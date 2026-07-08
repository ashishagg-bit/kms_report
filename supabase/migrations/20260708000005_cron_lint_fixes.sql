-- Address Supabase security-advisor warnings from the cron migration:
--   1. trigger_refresh_all_active_campaigns() was callable via the REST
--      API by anon/authenticated -- it's an internal function only meant
--      to be run by the pg_cron job itself.
--   2. pg_net was installed into the public schema instead of `extensions`.

revoke execute on function public.trigger_refresh_all_active_campaigns() from public;
revoke execute on function public.trigger_refresh_all_active_campaigns() from anon;
revoke execute on function public.trigger_refresh_all_active_campaigns() from authenticated;

-- pg_net doesn't support ALTER EXTENSION ... SET SCHEMA; its functions
-- already live in their own `net` schema regardless of where the
-- extension's catalog entry points, so drop/recreate is safe here.
drop extension pg_net;
create extension pg_net with schema extensions;
