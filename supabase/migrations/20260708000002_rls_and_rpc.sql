-- KWMS Campaign Reports: RLS policies + admin-only RPC functions
--
-- Access model:
--   kwms_admin  -> full read/write on everything
--   client      -> read-only, scoped to campaigns/posts where campaigns.brand_id
--                  matches their own profiles.brand_id. Never sees other brands'
--                  data, and querying a campaign that isn't theirs returns zero
--                  rows (RLS filters it out of the result set), not an error --
--                  so existence of other campaigns is never leaked.
--   anon        -> no access at all (everything requires a logged-in profile)

-- ============================================================
-- Helper functions
-- SECURITY DEFINER + fixed search_path so they bypass RLS on
-- profiles (avoiding self-referential recursion) while remaining
-- safe against search_path hijacking. They only ever read the
-- calling user's own row (auth.uid()), never anyone else's.
-- ============================================================
create or replace function public.current_user_role()
returns text
language sql
security definer
stable
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_user_brand_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select brand_id from public.profiles where id = auth.uid();
$$;

revoke all on function public.current_user_role() from public;
revoke all on function public.current_user_brand_id() from public;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_user_brand_id() to authenticated;

-- ============================================================
-- Enable RLS
-- ============================================================
alter table public.brands enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_posts enable row level security;
alter table public.profiles enable row level security;

-- ============================================================
-- brands
-- ============================================================
create policy brands_admin_all
  on public.brands
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

create policy brands_client_select_own
  on public.brands
  for select
  to authenticated
  using (
    public.current_user_role() = 'client'
    and id = public.current_user_brand_id()
  );

-- ============================================================
-- campaigns
-- ============================================================
create policy campaigns_admin_all
  on public.campaigns
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

create policy campaigns_client_select_own
  on public.campaigns
  for select
  to authenticated
  using (
    public.current_user_role() = 'client'
    and brand_id = public.current_user_brand_id()
  );

-- ============================================================
-- campaign_posts
-- ============================================================
create policy campaign_posts_admin_all
  on public.campaign_posts
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

create policy campaign_posts_client_select_own
  on public.campaign_posts
  for select
  to authenticated
  using (
    public.current_user_role() = 'client'
    and exists (
      select 1
      from public.campaigns c
      where c.id = campaign_posts.campaign_id
        and c.brand_id = public.current_user_brand_id()
    )
  );

-- ============================================================
-- profiles
-- ============================================================
create policy profiles_admin_all
  on public.profiles
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

create policy profiles_self_select
  on public.profiles
  for select
  to authenticated
  using (id = auth.uid());

-- ============================================================
-- Admin-only RPCs
-- SECURITY INVOKER: they run as the calling user, so the RLS
-- policies above are what actually gate who can insert. A client
-- calling these gets a normal RLS-violation error (this is an
-- authorization error on a write action, not a read-isolation
-- leak, so an explicit error here is fine).
-- ============================================================
create or replace function public.slugify(input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from regexp_replace(lower(input), '[^a-z0-9]+', '-', 'g'));
$$;

create or replace function public.create_campaign(p_brand_id uuid, p_title text)
returns public.campaigns
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_base_slug text;
  v_slug      text;
  v_suffix    int := 0;
  v_campaign  public.campaigns;
begin
  v_base_slug := public.slugify(p_title);
  v_slug := v_base_slug;

  while exists (select 1 from public.campaigns where slug = v_slug) loop
    v_suffix := v_suffix + 1;
    v_slug := v_base_slug || '-' || v_suffix;
  end loop;

  insert into public.campaigns (brand_id, title, slug)
  values (p_brand_id, p_title, v_slug)
  returning * into v_campaign;

  return v_campaign;
end;
$$;

create or replace function public.add_posts_to_campaign(p_campaign_id uuid, p_post_urls text[])
returns setof public.campaign_posts
language sql
security invoker
set search_path = public
as $$
  insert into public.campaign_posts (campaign_id, post_url)
  select p_campaign_id, url
  from unnest(p_post_urls) as url
  on conflict (campaign_id, post_url) do nothing
  returning *;
$$;

revoke all on function public.create_campaign(uuid, text) from public;
revoke all on function public.add_posts_to_campaign(uuid, text[]) from public;
grant execute on function public.create_campaign(uuid, text) to authenticated;
grant execute on function public.add_posts_to_campaign(uuid, text[]) to authenticated;
