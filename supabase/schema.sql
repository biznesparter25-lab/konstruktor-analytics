-- =====================================================================
-- Аналітика магазину конструкторів — схема бази Supabase
-- Виконати один раз: Supabase → SQL Editor → New query → вставити все → Run
-- =====================================================================

-- ---------- Замовлення з SalesDrive (кожне окремо) ----------
create table if not exists orders (
  id               bigint primary key,            -- номер заявки в SalesDrive
  order_time       timestamp,                     -- коли створена (київський час)
  order_date       date generated always as (order_time::date) stored,
  payment_date     date,                          -- дата продажу (paymentDate)
  update_at        timestamp,
  status_id        int,
  payment_amount   numeric(14,2) not null default 0,  -- сума замовлення
  cost_price       numeric(14,2) not null default 0,  -- собівартість (закупка)
  shipping_costs   numeric(14,2) not null default 0,  -- витрати на доставку
  commission       numeric(14,2) not null default 0,  -- комісії (накладений платіж, еквайринг)
  expenses_amount  numeric(14,2) not null default 0,  -- інші витрати в замовленні
  payed_amount     numeric(14,2) not null default 0,  -- оплачено
  rest_pay         numeric(14,2) not null default 0,  -- залишок до оплати
  discount_amount  numeric(14,2) not null default 0,
  upsell_amount    numeric(14,2) not null default 0,  -- сума допродажів (товари з preSale)
  rejection_reason text,
  utm_source       text,
  utm_campaign     text,
  sajt             int,
  manager_id       int,
  payment_method   text,
  synced_at        timestamptz not null default now()
);
alter table orders add column if not exists ttn text;                     -- номер ТТН
alter table orders add column if not exists delivery_cost numeric(14,2) not null default 0;  -- вартість доставки з трекінгу
alter table orders add column if not exists delivery_json jsonb;           -- дані доставки як є (для перевірки)
create index if not exists orders_order_date_idx   on orders (order_date);
create index if not exists orders_payment_date_idx on orders (payment_date);
create index if not exists orders_status_idx       on orders (status_id);

create table if not exists order_items (
  order_id   bigint not null references orders(id) on delete cascade,
  pos        int    not null,
  product_id bigint,
  name       text,
  sku        text,
  amount     numeric(12,3) not null default 1,
  price      numeric(14,2) not null default 0,
  cost_price numeric(14,2) not null default 0,
  pre_sale   boolean not null default false,
  primary key (order_id, pos)
);
create index if not exists order_items_product_idx on order_items (product_id);

-- ---------- Статуси SalesDrive і що вони означають ----------
-- category: work (в роботі) | success (продаж) | fail (відмова) | return (повернення) | ignore (не рахувати)
create table if not exists statuses (
  id        int primary key,
  name      text not null,
  type      int,
  category  text not null default 'work' check (category in ('work','success','fail','return','ignore')),
  confirmed boolean not null default false,  -- рахується як «підтверджене» замовлення
  manual    boolean not null default false,  -- true = змінено вручну, синхронізація не перезапише
  sort      int not null default 0
);
alter table statuses add column if not exists confirmed boolean not null default false;

-- ---------- Магазини (сайти в SalesDrive) ----------
-- id = номер сайту (поле «Сайт»/sajt у заявці). З'являються автоматично під час синхронізації,
-- назву задаєте в Налаштуваннях. active = false — сайт не рахується у звітах.
create table if not exists stores (
  id     int primary key,
  name   text,
  active boolean not null default true,
  sort   int not null default 0
);

-- ---------- Менеджери (id з SalesDrive, ім'я вносите в Налаштуваннях) ----------
create table if not exists managers (
  id             int primary key,          -- userId у SalesDrive
  name           text,
  rate_per_order numeric(10,2) not null default 0,  -- грн за кожен продаж
  upsell_pct     numeric(6,4)  not null default 0,  -- частка від допродажів (0.25 = 25%)
  active         boolean not null default true
);

-- ---------- Витрати, які ви вносите вручну ----------
create table if not exists expenses (
  id         bigserial primary key,
  date       date not null,                -- дата (або початок періоду)
  date_to    date,                         -- кінець періоду: сума розподіляється по днях
  category   text not null,                -- 'Реклама', 'Податки', 'SMS-розсилки', ...
  channel    text,                         -- для реклами: Meta, Google, TikTok, ...
  amount     numeric(14,2) not null,       -- сума у валюті
  currency   text not null default 'UAH' check (currency in ('UAH','USD','EUR')),
  rate       numeric(10,4) not null default 1,  -- курс на момент внесення
  amount_uah numeric(14,2) generated always as (round(amount * rate, 2)) stored,
  comment    text,
  store_id   int,                          -- магазин; порожньо = загальна витрата
  created_by text default (auth.jwt() ->> 'email'),  -- хто вніс (email входу)
  created_at timestamptz not null default now()
);
alter table expenses add column if not exists store_id int;
alter table expenses add column if not exists created_by text default (auth.jwt() ->> 'email');
create index if not exists expenses_date_idx on expenses (date);

-- ---------- Автоматичні витрати (правила) ----------
-- kind: percent_revenue (% від виручки) | fixed_monthly (грн на місяць) | per_order (грн за продаж)
create table if not exists rules (
  id        bigserial primary key,
  name      text not null,
  kind      text not null check (kind in ('percent_revenue','fixed_monthly','per_order')),
  value     numeric(14,4) not null,
  category  text not null default 'Інше',
  date_from date,
  date_to   date,
  store_id  int,                           -- магазин; порожньо = для всіх
  active    boolean not null default true
);
alter table rules add column if not exists store_id int;
alter table rules add column if not exists created_by text default (auth.jwt() ->> 'email');

-- ---------- Зарплата: люди і виплати ----------
-- role: owner (власник — виплати НЕ віднімаються від прибутку, це розподіл прибутку)
--       team  (UGC-креатор, фрилансер тощо — виплати віднімаються від прибутку магазину)
-- pay_kind: percent_profit (% від чистого прибутку всього бізнесу за місяць) | fixed_monthly | manual
create table if not exists people (
  id        bigserial primary key,
  name      text not null,
  role      text not null default 'team' check (role in ('owner','team')),
  pay_kind  text not null default 'manual' check (pay_kind in ('percent_profit','fixed_monthly','manual')),
  value     numeric(14,4) not null default 0,
  store_id  int,                              -- для команди: з якого магазину віднімати фіксовану суму
  active    boolean not null default true,
  sort      int not null default 0,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

-- Разові виплати (UGC за відео, контент, бонуси)
create table if not exists payouts (
  id         bigserial primary key,
  person_id  bigint references people(id) on delete set null,
  date       date not null,
  date_to    date,                          -- якщо вказано, сума розподіляється по днях
  store_id   int,                           -- магазин; порожньо = загальна
  amount     numeric(14,2) not null,
  currency   text not null default 'UAH' check (currency in ('UAH','USD','EUR')),
  rate       numeric(10,4) not null default 1,
  amount_uah numeric(14,2) generated always as (round(amount * rate, 2)) stored,
  comment    text,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);
create index if not exists payouts_date_idx on payouts (date);

-- ---------- Налаштування і службові дані ----------
create table if not exists settings (
  key   text primary key,
  value jsonb
);

create table if not exists sync_log (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  mode    text,
  orders  int,
  pages   int,
  ok      boolean,
  message text
);

-- ---------- Початкові налаштування ----------
insert into settings(key, value) values
  ('finance_date',       '"order"'),
  ('usd_rate',           '41.5'),
  ('eur_rate',           '45'),
  ('expense_categories', '["Реклама","Податки","SMS-розсилки","Оренда / склад","Пакування","Сервіси (CRM, сайт)","Банк / еквайринг","Інше"]'),
  ('ad_channels',        '["Meta","Google","TikTok","Блогери","Розсилки","Інше"]'),
  ('targets',            '{"romi": 1.0, "cpo": 300, "conversion": 0.6}'),
  ('backfill_done',      'false'),
  ('backfill_page',      '1')
on conflict (key) do nothing;

-- =====================================================================
-- Доступ: читати й змінювати дані можуть лише ті, хто увійшов у дашборд
-- (користувачів створюєте в Supabase → Authentication → Users → Add user).
-- Функція синхронізації працює з service_role і обходить ці правила.
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['orders','order_items','statuses','stores','managers','expenses','rules','settings','sync_log','people','payouts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "signed_in_all" on %I', t);
    execute format('create policy "signed_in_all" on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- =====================================================================
-- Реальний час: коли партнер додає витрату чи змінює налаштування,
-- у всіх, хто зараз відкрив дашборд, дані оновлюються самі.
-- =====================================================================
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['expenses','rules','stores','statuses','managers','settings','sync_log','people','payouts'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- =====================================================================
-- Аналітичні функції (викликаються з дашборду через supabase.rpc)
-- p_fin: 'order' — гроші за датою створення заявки, 'payment' — за датою продажу
-- =====================================================================

-- Прибрати старі версії функцій (без параметра магазину), якщо схему оновлюють
drop function if exists stats_daily(date, date, text);
drop function if exists stats_channels(date, date, text);
drop function if exists stats_products(date, date, text);
drop function if exists stats_statuses(date, date);
drop function if exists stats_reasons(date, date);
drop function if exists stats_payments(date, date, text);
drop function if exists stats_managers(date, date, text);
drop function if exists stats_manager_daily(date, date, text);
drop function if exists stats_daily(date, date, text, int);
drop function if exists stats_managers(date, date, text, int);

-- Чи потрапляє замовлення в обраний магазин.
-- p_store порожній = усі активні магазини (+ замовлення без сайту)
create or replace function in_scope(p_sajt int, p_store int) returns boolean
language sql stable as $$
  select case
    when p_store is not null then p_sajt = p_store
    when p_sajt is null then true
    else coalesce((select st.active from stores st where st.id = p_sajt), true)
  end
$$;

-- Додаткові витрати замовлення (доставка, комісії тощо) БЕЗ собівартості.
-- У SalesDrive поле «Витрати» (expensesAmount) уже включає собівартість товарів,
-- тому беремо лише те, що понад собівартість. Якщо «Витрати» не заповнені —
-- беремо окремо доставку й комісію.
create or replace function order_extra(o orders) returns numeric
language sql immutable as $$
  select case when o.expenses_amount > 0 then greatest(o.expenses_amount - o.cost_price, 0)
              else o.shipping_costs + o.commission end
$$;

-- Дата, за якою гроші відносяться до дня
create or replace function fin_date(o orders, p_fin text) returns date
language sql immutable as $$
  select case when p_fin = 'payment' then coalesce(o.payment_date, o.order_date) else o.order_date end
$$;

-- По днях: воронка (за датою заявки) + гроші (за фінансовою датою)
create or replace function stats_daily(p_from date, p_to date, p_fin text default 'order', p_store int default null)
returns table (
  day date, leads int, confirmed int, unconfirmed int, success int, fail int, returns int, work int,
  sales int, revenue numeric, cogs numeric, order_costs numeric, return_costs numeric,
  payed numeric, upsell numeric,
  pend_sales int, pend_revenue numeric, pend_cogs numeric, pend_costs numeric,
  refusal_ship numeric, refusal_ship_unknown int
)
language sql stable as $$
  with f as (
    select o.order_date d,
           count(*)::int leads,
           count(*) filter (where s.confirmed)::int confirmed,
           count(*) filter (where coalesce(s.category,'work') = 'work' and not coalesce(s.confirmed, false))::int unconfirmed,
           count(*) filter (where s.category = 'success')::int success,
           count(*) filter (where s.category = 'fail')::int fail,
           count(*) filter (where s.category = 'return')::int returns,
           count(*) filter (where coalesce(s.category,'work') = 'work')::int work,
           -- підтверджені, але ще не викуплені (для режиму «виручка при підтвердженні»)
           count(*) filter (where s.category = 'work' and s.confirmed)::int pend_sales,
           coalesce(sum(o.payment_amount) filter (where s.category = 'work' and s.confirmed), 0) pend_revenue,
           coalesce(sum(o.cost_price) filter (where s.category = 'work' and s.confirmed), 0) pend_cogs,
           coalesce(sum(order_extra(o)) filter (where s.category = 'work' and s.confirmed), 0) pend_costs,
           -- доставка посилок, від яких відмовились (ми платимо за повернення)
           coalesce(sum(o.delivery_cost) filter (where s.category in ('fail','return') and o.delivery_cost > 0), 0) refusal_ship,
           count(*) filter (where s.category in ('fail','return') and coalesce(o.delivery_cost,0) = 0 and coalesce(o.ttn,'') <> '')::int refusal_ship_unknown
    from orders o left join statuses s on s.id = o.status_id
    where in_scope(o.sajt, p_store) and o.order_date between p_from and p_to and coalesce(s.category,'work') <> 'ignore'
    group by 1
  ), m as (
    select fin_date(o, p_fin) d,
           count(*) filter (where s.category = 'success')::int sales,
           coalesce(sum(o.payment_amount) filter (where s.category = 'success'), 0) revenue,
           coalesce(sum(o.cost_price) filter (where s.category = 'success'), 0) cogs,
           coalesce(sum(order_extra(o)) filter (where s.category = 'success'), 0) order_costs,
           coalesce(sum(order_extra(o)) filter (where s.category = 'return'), 0) return_costs,
           coalesce(sum(o.payed_amount) filter (where s.category = 'success'), 0) payed,
           coalesce(sum(o.upsell_amount) filter (where s.category = 'success'), 0) upsell
    from orders o join statuses s on s.id = o.status_id
    where in_scope(o.sajt, p_store) and fin_date(o, p_fin) between p_from and p_to and s.category in ('success','return')
    group by 1
  )
  select coalesce(f.d, m.d),
         coalesce(f.leads,0), coalesce(f.confirmed,0), coalesce(f.unconfirmed,0), coalesce(f.success,0), coalesce(f.fail,0), coalesce(f.returns,0), coalesce(f.work,0),
         coalesce(m.sales,0), coalesce(m.revenue,0), coalesce(m.cogs,0), coalesce(m.order_costs,0), coalesce(m.return_costs,0),
         coalesce(m.payed,0), coalesce(m.upsell,0),
         coalesce(f.pend_sales,0), coalesce(f.pend_revenue,0), coalesce(f.pend_cogs,0), coalesce(f.pend_costs,0),
         coalesce(f.refusal_ship,0), coalesce(f.refusal_ship_unknown,0)
  from f full join m on m.d = f.d
  order by 1
$$;

-- Канали за UTM-міткою
create or replace function stats_channels(p_from date, p_to date, p_fin text default 'order', p_store int default null)
returns table (utm_source text, leads int, sales int, revenue numeric, gross numeric)
language sql stable as $$
  with l as (
    select coalesce(o.utm_source,'') u, count(*)::int leads
    from orders o left join statuses s on s.id = o.status_id
    where in_scope(o.sajt, p_store) and o.order_date between p_from and p_to and coalesce(s.category,'work') <> 'ignore'
    group by 1
  ), m as (
    select coalesce(o.utm_source,'') u, count(*)::int sales, sum(o.payment_amount) revenue,
           sum(o.payment_amount - o.cost_price - order_extra(o)) gross
    from orders o join statuses s on s.id = o.status_id
    where in_scope(o.sajt, p_store) and fin_date(o, p_fin) between p_from and p_to and s.category = 'success'
    group by 1
  )
  select coalesce(l.u, m.u), coalesce(l.leads,0), coalesce(m.sales,0), coalesce(m.revenue,0), coalesce(m.gross,0)
  from l full join m on m.u = l.u
$$;

-- Товари: продано, відмовлено, виручка, прибуток
create or replace function stats_products(p_from date, p_to date, p_fin text default 'order', p_store int default null)
returns table (product_id bigint, name text, sku text, sold numeric, refused numeric, returned numeric,
               revenue numeric, cost numeric, profit numeric)
language sql stable as $$
  select coalesce(i.product_id, 0),
         max(i.name), max(i.sku),
         coalesce(sum(i.amount) filter (where s.category = 'success'), 0),
         coalesce(sum(i.amount) filter (where s.category = 'fail'), 0),
         coalesce(sum(i.amount) filter (where s.category = 'return'), 0),
         coalesce(sum(i.price * i.amount) filter (where s.category = 'success'), 0),
         coalesce(sum(i.cost_price * i.amount) filter (where s.category = 'success'), 0),
         coalesce(sum((i.price - i.cost_price) * i.amount) filter (where s.category = 'success'), 0)
  from order_items i
  join orders o on o.id = i.order_id
  join statuses s on s.id = o.status_id
  where in_scope(o.sajt, p_store) and s.category in ('success','fail','return')
    and (case when s.category = 'success' then fin_date(o, p_fin) else o.order_date end) between p_from and p_to
  group by coalesce(i.product_id, 0), case when i.product_id is null then i.name end
  order by 9 desc, 4 desc
$$;

-- Розподіл заявок за статусами
create or replace function stats_statuses(p_from date, p_to date, p_store int default null)
returns table (status_id int, name text, category text, cnt int, amount numeric)
language sql stable as $$
  select o.status_id, coalesce(s.name, 'Статус #' || o.status_id), coalesce(s.category,'work'), count(*)::int, sum(o.payment_amount)
  from orders o left join statuses s on s.id = o.status_id
  where in_scope(o.sajt, p_store) and o.order_date between p_from and p_to and coalesce(s.category,'work') <> 'ignore'
  group by o.status_id, s.name, s.category, s.sort
  order by coalesce(s.sort, 0), count(*) desc
$$;

-- Причини відмов і повернень
create or replace function stats_reasons(p_from date, p_to date, p_store int default null)
returns table (reason text, fail int, returns int)
language sql stable as $$
  select coalesce(nullif(o.rejection_reason,''), '—'),
         count(*) filter (where s.category = 'fail')::int,
         count(*) filter (where s.category = 'return')::int
  from orders o join statuses s on s.id = o.status_id
  where in_scope(o.sajt, p_store) and o.order_date between p_from and p_to and s.category in ('fail','return')
  group by 1 order by count(*) desc
$$;

-- Оплати
create or replace function stats_payments(p_from date, p_to date, p_fin text default 'order', p_store int default null)
returns json
language sql stable as $$
  select json_build_object(
    'payed',        coalesce((select sum(o.payed_amount) from orders o join statuses s on s.id=o.status_id
                              where in_scope(o.sajt, p_store) and s.category='success' and fin_date(o,p_fin) between p_from and p_to), 0),
    'rest',         coalesce((select sum(o.rest_pay) from orders o join statuses s on s.id=o.status_id
                              where in_scope(o.sajt, p_store) and s.category='success' and fin_date(o,p_fin) between p_from and p_to), 0),
    'unpaid_count', coalesce((select count(*) from orders o join statuses s on s.id=o.status_id
                              where in_scope(o.sajt, p_store) and s.category='success' and o.rest_pay > 0.009 and fin_date(o,p_fin) between p_from and p_to), 0),
    'pending_sum',  coalesce((select sum(o.rest_pay) from orders o join statuses s on s.id=o.status_id
                              where in_scope(o.sajt, p_store) and s.category in ('work','success') and o.rest_pay > 0.009 and o.order_date >= p_to - 90), 0),
    'pending_count',coalesce((select count(*) from orders o join statuses s on s.id=o.status_id
                              where in_scope(o.sajt, p_store) and s.category in ('work','success') and o.rest_pay > 0.009 and o.order_date >= p_to - 90), 0),
    'by_method',    coalesce((select json_agg(x order by x.amount desc) from (
                       select coalesce(nullif(o.payment_method,''),'—') method, count(*) cnt, sum(o.payment_amount) amount
                       from orders o join statuses s on s.id=o.status_id
                       where in_scope(o.sajt, p_store) and s.category='success' and fin_date(o,p_fin) between p_from and p_to
                       group by 1) x), '[]'::json)
  )
$$;

-- Менеджери
create or replace function stats_managers(p_from date, p_to date, p_fin text default 'order', p_store int default null)
returns table (manager_id int, leads int, confirmed int, success int, fail int, returns int, sales int, revenue numeric, gross numeric, upsell numeric)
language sql stable as $$
  with l as (
    select o.manager_id m, count(*)::int leads,
           count(*) filter (where s.confirmed)::int confirmed,
           count(*) filter (where s.category='success')::int success,
           count(*) filter (where s.category='fail')::int fail,
           count(*) filter (where s.category='return')::int returns
    from orders o left join statuses s on s.id=o.status_id
    where in_scope(o.sajt, p_store) and o.order_date between p_from and p_to and coalesce(s.category,'work') <> 'ignore'
    group by 1
  ), m as (
    select o.manager_id m, count(*)::int sales, sum(o.payment_amount) revenue,
           sum(o.payment_amount - o.cost_price - order_extra(o)) gross,
           sum(o.upsell_amount) upsell
    from orders o join statuses s on s.id=o.status_id
    where in_scope(o.sajt, p_store) and s.category='success' and fin_date(o,p_fin) between p_from and p_to
    group by 1
  )
  select coalesce(l.m, m.m), coalesce(l.leads,0), coalesce(l.confirmed,0), coalesce(l.success,0), coalesce(l.fail,0), coalesce(l.returns,0),
         coalesce(m.sales,0), coalesce(m.revenue,0), coalesce(m.gross,0), coalesce(m.upsell,0)
  from l full join m on m.m = l.m
$$;

-- Продажі менеджерів по днях (для розрахунку з/п у звіті)
create or replace function stats_manager_daily(p_from date, p_to date, p_fin text default 'order', p_store int default null)
returns table (day date, manager_id int, sales int, upsell numeric)
language sql stable as $$
  select fin_date(o, p_fin), o.manager_id, count(*)::int, coalesce(sum(o.upsell_amount), 0)
  from orders o join statuses s on s.id = o.status_id
  where in_scope(o.sajt, p_store) and s.category = 'success' and o.manager_id is not null and fin_date(o, p_fin) between p_from and p_to
  group by 1, 2
$$;

-- Приклади даних доставки для перевірки (останні відмови з ТТН)
create or replace function delivery_sample()
returns table (id bigint, order_date date, status text, ttn text, delivery_cost numeric, delivery_json jsonb)
language sql stable as $$
  select o.id, o.order_date, s.name, o.ttn, o.delivery_cost, o.delivery_json
  from orders o join statuses s on s.id = o.status_id
  where s.category in ('fail','return') and o.delivery_json is not null
  order by o.order_time desc limit 5
$$;

-- Загальна інформація для сторінки налаштувань
create or replace function stats_overview_meta()
returns json language sql stable as $$
  select json_build_object(
    'orders', (select count(*) from orders),
    'first_order', (select min(order_date) from orders),
    'last_order',  (select max(order_time) from orders),
    'sites', coalesce((select json_agg(x order by x.orders desc) from (
               select o.sajt id, count(*) orders, min(o.order_date) first_order, max(o.order_date) last_order
               from orders o group by o.sajt) x), '[]'::json)
  )
$$;
