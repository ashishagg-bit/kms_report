-- Scheduled refresh: every 8 hours, call the refresh-campaign Edge Function
-- for every campaign with status = 'active'.
--
-- ONE-TIME MANUAL SETUP REQUIRED (cannot be done from this migration):
-- this function authenticates its call to refresh-campaign using the
-- project's service role key, read from the Postgres setting
-- app.settings.service_role_key. That key is never available to this
-- migration/session -- it must be set once, directly by a project owner,
-- via the Supabase SQL Editor:
--
--   alter database postgres set app.settings.service_role_key = '<paste service_role key from Project Settings > API>';
--
-- Until that's set, trigger_refresh_all_active_campaigns() logs a warning
-- and no-ops on each scheduled run, rather than failing.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.trigger_refresh_all_active_campaigns()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_campaign record;
  v_service_role_key text;
  v_function_url text := 'https://qanjzxbdgntaksvzjvke.supabase.co/functions/v1/refresh-campaign';
begin
  v_service_role_key := current_setting('app.settings.service_role_key', true);

  if v_service_role_key is null or v_service_role_key = '' then
    raise warning 'app.settings.service_role_key is not set -- skipping scheduled campaign refresh. See migration 20260708000004_cron.sql for one-time setup.';
    return;
  end if;

  for v_campaign in select id from public.campaigns where status = 'active' loop
    perform net.http_post(
      url := v_function_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_service_role_key
      ),
      body := jsonb_build_object('campaign_id', v_campaign.id)
    );
  end loop;
end;
$$;

select cron.schedule(
  'refresh-active-campaigns-every-8h',
  '0 */8 * * *',
  $$ select public.trigger_refresh_all_active_campaigns(); $$
);
