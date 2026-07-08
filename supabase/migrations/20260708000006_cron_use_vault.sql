-- Supabase's hosted Postgres doesn't grant regular project roles permission
-- to run ALTER DATABASE ... SET (that requires true superuser), so the
-- app.settings.service_role_key GUC approach from the previous migration
-- doesn't work here. Switch to Supabase Vault instead, which is the
-- platform's supported mechanism for exactly this case.
--
-- ONE-TIME MANUAL SETUP REQUIRED (run once in the Supabase SQL Editor,
-- substituting your real service_role key from Project Settings > API --
-- never share that key in chat/tickets/etc, only paste it directly here):
--
--   select vault.create_secret(
--     '<paste service_role key>',
--     'service_role_key',
--     'Used by pg_cron to authenticate calls to refresh-campaign'
--   );
--
-- Until that secret exists, trigger_refresh_all_active_campaigns() logs a
-- warning and no-ops on each scheduled run, rather than failing.

create or replace function public.trigger_refresh_all_active_campaigns()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_campaign record;
  v_service_role_key text;
  v_function_url text := 'https://qanjzxbdgntaksvzjvke.supabase.co/functions/v1/refresh-campaign';
begin
  select decrypted_secret into v_service_role_key
  from vault.decrypted_secrets
  where name = 'service_role_key'
  limit 1;

  if v_service_role_key is null or v_service_role_key = '' then
    raise warning 'vault secret "service_role_key" is not set -- skipping scheduled campaign refresh. See migration 20260708000006_cron_use_vault.sql for one-time setup.';
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

revoke execute on function public.trigger_refresh_all_active_campaigns() from public;
revoke execute on function public.trigger_refresh_all_active_campaigns() from anon;
revoke execute on function public.trigger_refresh_all_active_campaigns() from authenticated;
