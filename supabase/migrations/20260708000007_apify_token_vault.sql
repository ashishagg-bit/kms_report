-- Store the Apify API token in Supabase Vault rather than as an Edge
-- Function secret (no tool in this workflow can set Edge Function secrets
-- directly, but Vault is reachable via SQL). refresh-campaign fetches it
-- at request time via this tightly-locked-down RPC, callable only by
-- service_role (i.e. only from the function's own admin client).

create or replace function public.get_apify_token()
returns text
language sql
security definer
set search_path = vault
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'apify_token' limit 1;
$$;

revoke all on function public.get_apify_token() from public;
revoke all on function public.get_apify_token() from anon;
revoke all on function public.get_apify_token() from authenticated;
grant execute on function public.get_apify_token() to service_role;
