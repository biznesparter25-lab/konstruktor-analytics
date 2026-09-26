// =====================================================================
// wayforpay-sync — забирає транзакції WayForPay з фактичною комісією
// і прив'язує їх до заявок SalesDrive.
//
// Секрети (Supabase → Edge Functions → Secrets):
//   WFP_MERCHANT_ACCOUNT  Merchant login з кабінету WayForPay (напр. mblok_shop)
//   WFP_SECRET_KEY        Merchant secret key
//   CRON_SECRET           той самий, що для constructor-sync
//   SALESDRIVE_DOMAIN, SALESDRIVE_API_KEY — вже задані (для запасної прив'язки через платежі)
//   WFP_SYNC_FROM         (необов.) з якої дати вантажити вперше, РРРР-ММ-ДД. Інакше INITIAL_SYNC_FROM або 30 днів
//
// Тіло запиту: { } — звичайне оновлення (останні дні); { from: "2026-09-01" } — перезавантажити з дати.
// =====================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"
import { createHmac } from "node:crypto"

const ACCOUNT = Deno.env.get("WFP_MERCHANT_ACCOUNT") || ""
const SECRET = Deno.env.get("WFP_SECRET_KEY") || ""
const CRON_SECRET = Deno.env.get("CRON_SECRET") || ""
const FIRST_FROM = Deno.env.get("WFP_SYNC_FROM") || Deno.env.get("INITIAL_SYNC_FROM") || ""
const SD_DOMAIN = (Deno.env.get("SALESDRIVE_DOMAIN") || "").replace(/^https?:\/\//, "").replace(/\.salesdrive\.me.*$/, "")
const SD_KEY = Deno.env.get("SALESDRIVE_API_KEY") || ""
const WFP_URL = Deno.env.get("WFP_API_URL") || "https://api.wayforpay.com/api"          // підміна лише для тестів
const SD_BASE = Deno.env.get("SALESDRIVE_BASE_URL") || `https://${SD_DOMAIN}.salesdrive.me`

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Content-Type": "application/json",
}
const DAY = 86_400_000
const num = (v: unknown) => { const n = parseFloat(String(v ?? "")); return Number.isFinite(n) ? n : 0 }
const sign = (s: string) => createHmac("md5", SECRET).update(s, "utf8").digest("hex")

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: cors })

  const cronOk = CRON_SECRET && req.headers.get("x-cron-secret") === CRON_SECRET
  if (!cronOk) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
    const { data, error } = token ? await supabase.auth.getUser(token) : { data: null, error: true }
    if (error || !data?.user) return json({ success: false, error: "Потрібно увійти в дашборд" }, 401)
  }
  if (!ACCOUNT || !SECRET) return json({ success: false, error: "Не задано секрети WFP_MERCHANT_ACCOUNT або WFP_SECRET_KEY" }, 500)

  let body: any = {}
  try { body = await req.json() } catch { /* порожнє тіло */ }
  const getSetting = async (key: string, def: any = null) => {
    const { data } = await supabase.from("settings").select("value").eq("key", key).maybeSingle()
    return data ? data.value : def
  }
  const setSetting = (key: string, value: any) => supabase.from("settings").upsert({ key, value })

  let result: any
  try {
    // ---------- період ----------
    const now = Date.now()
    const last = await getSetting("wfp_last_sync", null)
    let fromMs: number
    if (body.from) fromMs = new Date(body.from + "T00:00:00+03:00").getTime()
    else if (last) fromMs = new Date(String(last)).getTime() - 3 * DAY           // з запасом: повернення, зміни статусів
    else fromMs = FIRST_FROM ? new Date(FIRST_FROM + "T00:00:00+03:00").getTime() : now - 30 * DAY

    // ---------- транзакції WayForPay (частинами по 7 днів) ----------
    const rows: any[] = []
    for (let a = fromMs; a < now; a += 7 * DAY) {
      const dateBegin = Math.floor(a / 1000), dateEnd = Math.floor(Math.min(a + 7 * DAY, now) / 1000)
      const res = await fetch(WFP_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactionType: "TRANSACTION_LIST", merchantAccount: ACCOUNT, apiVersion: 1,
          dateBegin, dateEnd, merchantSignature: sign(`${ACCOUNT};${dateBegin};${dateEnd}`) }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.reasonCode && Number(data.reasonCode) !== 1100) throw new Error(`WayForPay: ${data.reason || data.reasonCode}`)
      for (const t of data.transactionList || []) {
        const ts = Number(t.processingDate || t.createdDate) || 0
        rows.push({
          id: `${t.orderReference}|${t.transactionType || ""}|${ts}`,
          order_reference: String(t.orderReference || ""),
          tx_type: t.transactionType || null,
          status: t.transactionStatus || null,
          tx_time: new Date((Number(t.createdDate) || ts) * 1000).toISOString(),
          amount: num(t.amount), currency: t.currency || null, fee: num(t.fee),
          payment_system: t.paymentSystem || null,
          synced_at: new Date().toISOString(),
        })
      }
    }

    // ---------- прив'язка до заявок ----------
    // 1) за номером Tilda: друга частина orderReference = зовнішній номер заявки SalesDrive
    const { data: existing } = await supabase.from("wfp_transactions").select("id, order_id, matched_by").in("id", rows.map((r) => r.id).slice(0, 1000))
    const known = new Map((existing || []).map((e: any) => [e.id, e]))
    const refs = [...new Set(rows.flatMap((r) => [r.order_reference, r.order_reference.split("_").pop() || ""]).filter(Boolean))]
    const byExt = new Map<string, number>()
    for (let i = 0; i < refs.length; i += 200) {
      const { data } = await supabase.from("orders").select("id, external_id").in("external_id", refs.slice(i, i + 200))
      for (const o of data || []) byExt.set(String(o.external_id), Number(o.id))
    }
    for (const r of rows) {
      const k: any = known.get(r.id)
      if (k?.order_id) { r.order_id = k.order_id; r.matched_by = k.matched_by; continue }
      const id = byExt.get(r.order_reference) || byExt.get(r.order_reference.split("_").pop() || "")
      r.order_id = id || null; r.matched_by = id ? "external_id" : null
    }

    // 2) запасний шлях: вхідні платежі SalesDrive, у призначенні яких є номер WayForPay
    const unmatched = rows.filter((r) => !r.order_id)
    let viaPayments = 0
    if (unmatched.length && SD_DOMAIN && SD_KEY) {
      const fmt = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 19).replace("T", " ")
      for (let page = 1; page <= 10; page++) {
        const qs = new URLSearchParams({ page: String(page), limit: "100", "filter[type]": "incoming",
          "filter[date][from]": fmt(fromMs - DAY), "filter[date][to]": fmt(now) })
        const res = await fetch(`${SD_BASE}/api/payment/list/?${qs}`, { headers: { "X-Api-Key": SD_KEY, "Form-Api-Key": SD_KEY } })
        const data = await res.json().catch(() => ({}))
        const list: any[] = data.data || []
        for (const p of list) {
          const text = `${p.purpose || ""} ${p.comment || ""}`
          const orderId = (p.paymentBreakdown || []).map((b: any) => b?.order?.id).find(Boolean)
          if (!orderId) continue
          for (const r of unmatched) if (!r.order_id && text.includes(r.order_reference)) { r.order_id = Number(orderId); r.matched_by = "payment"; viaPayments++ }
        }
        if (!list.length || page >= (data.pagination?.pageCount || 1)) break
      }
    }
    // заявка може ще не бути в базі (наприклад, старіша за період синхронізації) — тоді не прив'язуємо
    const ids = [...new Set(rows.map((r) => r.order_id).filter(Boolean))]
    if (ids.length) {
      const { data } = await supabase.from("orders").select("id").in("id", ids)
      const have = new Set((data || []).map((o: any) => Number(o.id)))
      for (const r of rows) if (r.order_id && !have.has(Number(r.order_id))) { r.order_id = null; r.matched_by = null }
    }

    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from("wfp_transactions").upsert(rows.slice(i, i + 500))
      if (error) throw new Error("wfp_transactions: " + error.message)
    }
    await setSetting("wfp_last_sync", new Date(now).toISOString())
    const fee = rows.filter((r) => r.status === "Approved").reduce((s, r) => s + r.fee, 0)
    const noMatch = rows.filter((r) => !r.order_id && r.status === "Approved").length
    result = { success: true, transactions: rows.length, fee: Math.round(fee * 100) / 100, unmatched: noMatch, via_payments: viaPayments,
      message: `WayForPay: ${rows.length} транзакцій, комісія ${Math.round(fee)} ₴${noMatch ? `, не прив'язано ${noMatch}` : ""}` }
  } catch (e: any) {
    result = { success: false, error: String(e?.message || e) }
  }
  await supabase.from("sync_log").insert({ mode: "wayforpay", orders: result.transactions ?? 0, pages: 0, ok: !!result.success, message: result.message || result.error })
  return json(result, result.success ? 200 : 500)
})
