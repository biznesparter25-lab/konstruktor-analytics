// =====================================================================
// constructor-sync — забирає замовлення з SalesDrive у базу Supabase
//
// Секрети (Supabase → Edge Functions → Secrets):
//   SALESDRIVE_DOMAIN   піддомен, напр. "myshop" для myshop.salesdrive.me
//   SALESDRIVE_API_KEY  API-ключ SalesDrive (права на читання заявок)
//   CRON_SECRET         будь-який довгий пароль для автозапуску
//   SALESDRIVE_SAJT     (необов.) брати лише ці сайти (id через кому). Зазвичай не потрібно:
//                       кожен сайт і так стає окремим магазином у дашборді
//   INITIAL_SYNC_FROM   (необов.) з якої дати вантажити історію, РРРР-ММ-ДД
//
// Режими (тіло запиту JSON):
//   { }                                   авто: історія частинами, потім лише змінені замовлення
//   { mode: "range", dateFrom, dateTo, page }  перезавантажити період (повертає more/nextPage)
//   { mode: "statuses" }                  лише оновити список статусів
// =====================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const DOMAIN = (Deno.env.get("SALESDRIVE_DOMAIN") || "").replace(/^https?:\/\//, "").replace(/\.salesdrive\.me.*$/, "")
const API_KEY = Deno.env.get("SALESDRIVE_API_KEY") || ""
const CRON_SECRET = Deno.env.get("CRON_SECRET") || ""
const SAJT_FILTER = (Deno.env.get("SALESDRIVE_SAJT") || "").split(",").map((s) => Number(s.trim())).filter(Boolean)
const INITIAL_FROM = Deno.env.get("INITIAL_SYNC_FROM") || ""
const BASE = Deno.env.get("SALESDRIVE_BASE_URL") || `https://${DOMAIN}.salesdrive.me` // підміна лише для тестів

const PAGE_LIMIT = 100
const TIME_BUDGET_MS = 110_000        // безкоштовний Supabase дає функції ~150 с
const LIMITS = [                      // ліміти SalesDrive на список заявок (з запасом)
  { windowMs: 60_000, max: 9 },
  { windowMs: 3_600_000, max: 95 },
  { windowMs: 86_400_000, max: 950 },
]

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Content-Type": "application/json",
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const num = (v: unknown) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : 0 }

// Київський час у форматі SalesDrive "YYYY-MM-DD HH:MM:SS"
function kyiv(d: Date): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}
function normDate(v: unknown): string | null {
  if (!v) return null
  const s = String(v).trim()
  if (!s || s.startsWith("0000")) return null
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(.*)$/) // ДД.ММ.РРРР
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4] || ""}`.trim() : s
}

function guessCategory(name = "", type?: number): string {
  const n = name.toLowerCase()
  if (/видал|удал|дубл|спам|тест|архів/.test(n)) return "ignore"
  if (/поверн|возврат/.test(n)) return "return"
  if (/відмов|отказ|скасов|отмен|невикуп|не викуп|не забра/.test(n)) return "fail"
  if (/продаж|викуп|виконан|выполн|отриман|получен|успіш|успеш|заверш/.test(n)) return "success"
  if (type === 2) return "success"
  if (type === 3) return "fail"
  return "work"
}

// Вартість доставки з даних трекінгу (SalesDrive показує її як «Вартість доставки» біля ТТН).
// Назва поля може відрізнятися, тому шукаємо серед відомих варіантів, а потім за назвою.
const COST_KEYS = ["cost", "deliveryCost", "documentCost", "DocumentCost", "costOnSite", "CostOnSite", "deliveryPrice", "shippingCost", "price", "sum"]
function deliveryCost(d: any): number {
  if (!d || typeof d !== "object") return 0
  for (const k of COST_KEYS) { const v = num(d[k]); if (v > 0 && v < 20000) return v }
  for (const [k, v] of Object.entries(d)) {
    if (/(cost|price|вартіст)/i.test(k) && !/(declar|announc|assess|insur|postpay|redeliver|backward|seats|weight)/i.test(k)) {
      const n = num(v); if (n > 0 && n < 20000) return n
    }
  }
  return 0
}

// Чи вважати статус «підтвердженим» (замовлення підтверджене клієнтом і йде далі)
function guessConfirmed(name = "", category = "work"): boolean {
  if (category === "success") return true
  if (category !== "work") return false
  return /підтвер|подтвер|відправ|отправ|упак|збира|собира|комплект|в дороз|в пути|доставл|на пошт|прибу|оплач|передан/i.test(name)
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const started = Date.now()
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors })

  // ---------- хто викликає: автозапуск (секрет) або користувач дашборду ----------
  const cronOk = CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET
  if (!cronOk) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
    const { data, error } = token ? await supabase.auth.getUser(token) : { data: null, error: true }
    if (error || !data?.user) return json({ success: false, error: "Потрібно увійти в дашборд" }, 401)
  }
  if (!DOMAIN || !API_KEY) return json({ success: false, error: "Не задано секрети SALESDRIVE_DOMAIN або SALESDRIVE_API_KEY" }, 500)

  let body: any = {}
  try { body = await req.json() } catch { /* порожнє тіло = авто */ }
  const mode = body.mode || "auto"

  // ---------- налаштування ----------
  const getSetting = async (key: string, def: any = null) => {
    const { data } = await supabase.from("settings").select("value").eq("key", key).maybeSingle()
    return data ? data.value : def
  }
  const setSetting = async (key: string, value: any) => {
    const { error } = await supabase.from("settings").upsert({ key, value })
    if (error) throw new Error("settings: " + error.message)
  }

  // ---------- запити до SalesDrive ----------
  let stamps: number[] = ((await getSetting("api_stamps", [])) as number[]).filter((t) => started - t < 86_400_000)
  async function waitSlot(): Promise<boolean> {
    for (;;) {
      const now = Date.now()
      let wait = 0
      for (const { windowMs, max } of LIMITS) {
        const w = stamps.filter((t) => now - t < windowMs)
        if (w.length >= max) wait = Math.max(wait, w[0] + windowMs - now + 300)
      }
      if (wait === 0) { stamps.push(now); return true }
      if (now + wait - started > TIME_BUDGET_MS) return false // не встигаємо — продовжимо наступного разу
      await sleep(wait)
    }
  }
  async function sd(path: string, params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString()
    const res = await fetch(`${BASE}${path}${qs ? "?" + qs : ""}`, {
      headers: { "X-Api-Key": API_KEY, "Form-Api-Key": API_KEY, Accept: "application/json" },
    })
    const text = await res.text()
    let data: any
    try { data = JSON.parse(text) } catch { throw new Error(`SalesDrive HTTP ${res.status}: ${text.slice(0, 200)}`) }
    if (res.status === 429) return { rateLimited: true }
    if (!res.ok || data?.status === "error" || data?.message === "api key is invalid") {
      throw new Error("SalesDrive: " + (data?.message || "HTTP " + res.status))
    }
    return data
  }

  // ---------- статуси та довідники ----------
  async function syncStatuses() {
    const r = await sd("/api/statuses/")
    const list: any[] = r.data || []
    const { data: existing } = await supabase.from("statuses").select("id, manual, category, confirmed")
    const manual = new Map((existing || []).map((s: any) => [s.id, s]))
    const rows = list.map((s, i) => {
      const ex: any = manual.get(Number(s.id))
      const category = ex?.manual ? ex.category : guessCategory(s.name, s.type)
      return { id: Number(s.id), name: s.name, type: s.type ?? null, sort: i, category,
        confirmed: ex?.manual ? !!ex.confirmed : guessConfirmed(s.name, category), manual: ex?.manual ?? false }
    })
    if (rows.length) {
      const { error } = await supabase.from("statuses").upsert(rows)
      if (error) throw new Error("statuses: " + error.message)
    }
    return rows.length
  }
  let payMethods: Record<string, string> = {}
  try {
    const pm = await sd("/api/payment-methods/")
    for (const m of pm.data || []) { payMethods[String(m.id)] = m.name; if (m.parameter) payMethods[String(m.parameter)] = m.name }
  } catch { /* не критично */ }

  // ---------- збереження сторінки замовлень ----------
  async function saveOrders(orders: any[], meta: any) {
    const reasonNames: Record<string, string> = {}
    for (const o of meta?.fields?.rejectionReason?.options || []) reasonNames[String(o.value)] = o.text
    const rows: any[] = [], items: any[] = [], mgrIds = new Set<number>(), siteIds = new Set<number>()
    for (const o of orders) {
      if (SAJT_FILTER.length && !SAJT_FILTER.includes(Number(o.sajt))) continue
      const products: any[] = Array.isArray(o.products) ? o.products : []
      let cost = num(o.costPriceAmount)
      if (!cost) cost = products.reduce((s, p) => s + num(p.costPrice) * (num(p.amount) || 1), 0)
      const upsell = products.reduce((s, p) => s + (Number(p.preSale) === 1 ? num(p.price) * (num(p.amount) || 1) : 0), 0)
      const rr = o.rejectionReason
      const reason = rr == null || rr === "" ? null
        : typeof rr === "object" ? (rr.name || rr.text || null) : (reasonNames[String(rr)] || String(rr))
      const pmRaw = o.payment_method != null ? String(o.payment_method) : null
      const dList: any[] = Array.isArray(o.ord_delivery_data) ? o.ord_delivery_data : (o.ord_delivery_data ? [o.ord_delivery_data] : [])
      const dl = dList.find((x) => x && (x.trackingNumber || deliveryCost(x))) || dList[0] || null
      rows.push({
        id: Number(o.id),
        order_time: normDate(o.orderTime),
        payment_date: normDate(o.paymentDate)?.slice(0, 10) || null,
        update_at: normDate(o.updateAt),
        status_id: Number(o.statusId) || null,
        payment_amount: num(o.paymentAmount),
        cost_price: cost,
        shipping_costs: num(o.shipping_costs),
        commission: num(o.commissionAmount),
        expenses_amount: num(o.expensesAmount),
        payed_amount: num(o.payedAmount),
        rest_pay: num(o.restPay),
        discount_amount: num(o.discountAmount),
        upsell_amount: upsell,
        rejection_reason: reason,
        utm_source: o.utmSource || null,
        utm_campaign: o.utmCampaign || null,
        sajt: Number(o.sajt) || null,
        manager_id: Number(o.userId) || null,
        payment_method: pmRaw ? (payMethods[pmRaw] || pmRaw) : null,
        ttn: dl?.trackingNumber ? String(dl.trackingNumber) : null,
        delivery_cost: deliveryCost(dl),
        delivery_json: dl,
        synced_at: new Date().toISOString(),
      })
      if (Number(o.userId)) mgrIds.add(Number(o.userId))
      if (Number(o.sajt)) siteIds.add(Number(o.sajt))
      products.forEach((p, pos) => items.push({
        order_id: Number(o.id), pos, product_id: Number(p.productId) || null,
        name: p.text || p.documentName || "Без назви", sku: p.sku || "",
        amount: num(p.amount) || 1, price: num(p.price), cost_price: num(p.costPrice), pre_sale: Number(p.preSale) === 1,
      }))
    }
    if (!rows.length) return 0
    if (siteIds.size) {  // нові сайти з'являються в Налаштуваннях як магазини
      await supabase.from("stores").upsert([...siteIds].map((id) => ({ id, name: "Сайт #" + id })), { onConflict: "id", ignoreDuplicates: true })
    }
    if (mgrIds.size) {
      await supabase.from("managers").upsert([...mgrIds].map((id) => ({ id })), { onConflict: "id", ignoreDuplicates: true })
    }
    let { error } = await supabase.from("orders").upsert(rows)
    if (error) throw new Error("orders: " + error.message)
    ;({ error } = await supabase.from("order_items").delete().in("order_id", rows.map((r) => r.id)))
    if (error) throw new Error("order_items delete: " + error.message)
    if (items.length) {
      ;({ error } = await supabase.from("order_items").insert(items))
      if (error) throw new Error("order_items: " + error.message)
    }
    return rows.length
  }

  // Завантажує сторінки, поки є час і ліміт. Повертає, на якій сторінці зупинились.
  async function pull(filter: Record<string, string>, startPage: number) {
    let page = startPage, saved = 0, pages = 0, done = false, stopReason = ""
    for (;;) {
      if (Date.now() - started > TIME_BUDGET_MS - 15_000) { stopReason = "час"; break }
      if (!(await waitSlot())) { stopReason = "ліміт SalesDrive"; break }
      const r = await sd("/api/order/list/", { ...filter, "filter[statusId]": "__ALL__", page: String(page), limit: String(PAGE_LIMIT) })
      if (r.rateLimited) { stopReason = "ліміт SalesDrive"; break }
      const data: any[] = r.data || []
      saved += await saveOrders(data, r.meta)
      pages++
      const pageCount = r.pagination?.pageCount || 1
      if (page >= pageCount || data.length === 0) { done = true; break }
      page++
    }
    return { page, saved, pages, done, stopReason }
  }

  let result: any = {}
  try {
    const statusCount = await syncStatuses()
    if (mode === "statuses") {
      result = { success: true, message: `Оновлено статусів: ${statusCount}` }
    } else if (mode === "range") {
      if (!body.dateFrom || !body.dateTo) throw new Error("Вкажіть dateFrom і dateTo")
      const r = await pull({ "filter[orderTime][from]": `${body.dateFrom} 00:00:00`, "filter[orderTime][to]": `${body.dateTo} 23:59:59` }, Number(body.page) || 1)
      result = { success: true, more: !r.done, nextPage: r.done ? null : r.page, orders: r.saved, pages: r.pages,
        message: r.done ? `Період оновлено: ${r.saved} замовлень` : `Оброблено ${r.saved} замовлень, продовжую… (${r.stopReason})` }
    } else if ((await getSetting("backfill_done", false)) !== true) {
      // Історія: вантажимо частинами, прогрес зберігаємо
      const from = INITIAL_FROM || kyiv(new Date(Date.now() - 365 * 86_400_000)).slice(0, 10)
      const startPage = Number(await getSetting("backfill_page", 1)) || 1
      if (startPage === 1) await setSetting("backfill_started", new Date(started).toISOString())
      const r = await pull({ "filter[orderTime][from]": `${from} 00:00:00` }, startPage)
      if (r.done) {
        await setSetting("backfill_done", true)
        await setSetting("backfill_page", 1)
        // все, що змінилося під час завантаження історії, доберемо інкрементально
        await setSetting("last_sync", await getSetting("backfill_started", new Date(started).toISOString()))
      } else {
        await setSetting("backfill_page", r.page)
      }
      result = { success: true, more: !r.done, orders: r.saved, pages: r.pages,
        message: r.done ? `Історію завантажено (${from} — сьогодні)` : `Завантажую історію: сторінка ${r.page}, продовжу автоматично` }
    } else {
      // Звичайний режим: лише змінені з минулої синхронізації (з запасом 10 хв)
      const last = await getSetting("last_sync", null)
      const fromDate = last ? new Date(new Date(String(last)).getTime() - 10 * 60_000) : new Date(Date.now() - 86_400_000)
      const r = await pull({ "filter[updateAt][from]": kyiv(fromDate) }, 1)
      if (r.done) await setSetting("last_sync", new Date(started).toISOString())
      result = { success: true, more: !r.done, orders: r.saved, pages: r.pages,
        message: r.done ? `Оновлено замовлень: ${r.saved}` : `Частково оновлено (${r.saved}), решта при наступному запуску` }
    }
  } catch (e: any) {
    result = { success: false, error: String(e?.message || e) }
  } finally {
    await supabase.from("settings").upsert({ key: "api_stamps", value: stamps.filter((t) => Date.now() - t < 86_400_000) })
    await supabase.from("sync_log").insert({ mode: body.mode || (cronOk ? "cron" : "auto"), orders: result.orders ?? 0,
      pages: result.pages ?? 0, ok: !!result.success, message: result.message || result.error })
    await supabase.from("settings").upsert({ key: "last_run", value: new Date().toISOString() })
  }
  return json(result, result.success ? 200 : 500)
})
