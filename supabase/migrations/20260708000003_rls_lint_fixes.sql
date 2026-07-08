-- Address Supabase security-advisor warnings from the RLS migration:
--   1. slugify() had a mutable search_path
--   2/3. current_user_role() / current_user_brand_id() are SECURITY DEFINER
--        and were still callable by anon (Supabase applies default privileges
--        to anon/authenticated on new public-schema functions independently
--        of the "revoke ... from public" done in the previous migration).

alter function public.slugify(text) set search_path = '';

revoke execute on function public.current_user_role() from anon;
revoke execute on function public.current_user_brand_id() from anon;
revoke execute on function public.create_campaign(uuid, text) from anon;
revoke execute on function public.add_posts_to_campaign(uuid, text[]) from anon;
