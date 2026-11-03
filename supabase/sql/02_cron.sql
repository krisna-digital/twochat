-- =====================================================================
-- OPSIONAL tapi disarankan: pembersihan terjadwal tiap menit.
-- 1) Ganti PROJECT_REF dan GANTI_RAHASIA_CRON di bawah (rahasia yang sama dengan secret CRON_SECRET Edge Function).
-- 2) Jalankan di SQL Editor.  JANGAN simpan versi yang sudah diisi rahasia ke repository.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'twochat-cleanup',
  '* * * * *',
  $job$
    select public.cleanup_expired_text();
    select net.http_post(
      url     := 'https://PROJECT_REF.supabase.co/functions/v1/cleanup',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', 'GANTI_RAHASIA_CRON'),
      body    := '{}'::jsonb
    ) where public.has_expired_attachments();
  $job$
);

-- Untuk menghentikan:  select cron.unschedule('twochat-cleanup');
