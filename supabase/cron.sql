-- =====================================================================
-- Автосинхронізація кожні 15 хвилин
-- 1) Supabase → Database → Extensions: увімкніть pg_cron і pg_net
-- 2) Замініть ВАШ_CRON_SECRET нижче і виконайте в SQL Editor:
--      ВАШ_CRON_SECRET  — той самий пароль, що в секреті CRON_SECRET функції
--    (у функції має бути вимкнено «Verify JWT», див. README, крок 4)
-- =====================================================================

select cron.unschedule('constructor-sync') where exists (select 1 from cron.job where jobname = 'constructor-sync');

select cron.schedule(
  'constructor-sync',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://lwaxkiuzxauilivpxojt.supabase.co/functions/v1/constructor-sync',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', 'ВАШ_CRON_SECRET'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 150000
  );
  $$
);

-- Перевірити, що задача створена:
-- select * from cron.job;
-- Подивитися останні запуски:
-- select * from sync_log order by id desc limit 20;

-- =====================================================================
-- WayForPay: комісії щогодини (потрібна функція wayforpay-sync і секрети WFP_*)
-- =====================================================================
select cron.unschedule('wayforpay-sync') where exists (select 1 from cron.job where jobname = 'wayforpay-sync');

select cron.schedule(
  'wayforpay-sync',
  '7 * * * *',
  $$
  select net.http_post(
    url     := 'https://lwaxkiuzxauilivpxojt.supabase.co/functions/v1/wayforpay-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'ВАШ_CRON_SECRET'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
