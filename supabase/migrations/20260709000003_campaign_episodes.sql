-- Sub-campaign grouping: a campaign (e.g. Netflix "Lock Upp") can be split
-- into episodes/segments (Ep 1, Ep 2, ...) so posts and stats can be viewed
-- per-episode as well as for the whole campaign. A post's episode_id is
-- optional -- posts can still belong to a campaign directly with no episode.

create table public.campaign_episodes (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  title        text not null,
  created_at   timestamptz not null default now()
);

create index campaign_episodes_campaign_id_idx on public.campaign_episodes(campaign_id);

alter table public.campaign_episodes enable row level security;

create policy campaign_episodes_admin_all
  on public.campaign_episodes
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

create policy campaign_episodes_client_select_own
  on public.campaign_episodes
  for select
  to authenticated
  using (
    public.current_user_role() = 'client'
    and exists (
      select 1 from public.campaigns c
      where c.id = campaign_episodes.campaign_id
        and c.brand_id = public.current_user_brand_id()
    )
  );

alter table public.campaign_posts
  add column episode_id uuid references public.campaign_episodes(id) on delete set null;

create index campaign_posts_episode_id_idx on public.campaign_posts(episode_id);

-- Per-episode aggregate, mirroring campaign_stats one level down.
create view public.episode_stats
with (security_invoker = true) as
select
  e.id as episode_id,
  e.campaign_id,
  e.title,
  count(cp.id) as total_posts,
  coalesce(sum(cp.views), 0) as total_views,
  coalesce(sum(cp.likes), 0) as total_likes,
  coalesce(sum(cp.comments_count), 0) as total_comments,
  coalesce(sum(cp.shares), 0) as total_shares
from public.campaign_episodes e
left join public.campaign_posts cp on cp.episode_id = e.id
group by e.id, e.campaign_id, e.title;

comment on view public.episode_stats is
  'Per-episode aggregate stats, same shape as campaign_stats but scoped to one episode. RLS-scoped via security_invoker.';

-- ============================================================
-- RPCs (admin-only via RLS, same pattern as create_campaign /
-- add_posts_to_campaign)
-- ============================================================
create or replace function public.create_campaign_episode(p_campaign_id uuid, p_title text)
returns public.campaign_episodes
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_episode public.campaign_episodes;
begin
  insert into public.campaign_episodes (campaign_id, title)
  values (p_campaign_id, p_title)
  returning * into v_episode;

  return v_episode;
end;
$$;

create or replace function public.add_posts_to_episode(p_episode_id uuid, p_post_urls text[])
returns setof public.campaign_posts
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_campaign_id uuid;
begin
  select campaign_id into v_campaign_id from public.campaign_episodes where id = p_episode_id;

  if v_campaign_id is null then
    raise exception 'episode_not_found';
  end if;

  -- Matches add_posts_to_campaign's semantics: a URL already in this
  -- campaign (in this episode or another) is left untouched, not silently
  -- reassigned. Moving a post between episodes is a separate explicit
  -- update, not an implicit side effect of adding URLs.
  return query
    insert into public.campaign_posts (campaign_id, episode_id, post_url)
    select v_campaign_id, p_episode_id, url
    from unnest(p_post_urls) as url
    on conflict (campaign_id, post_url) do nothing
    returning *;
end;
$$;

revoke all on function public.create_campaign_episode(uuid, text) from public;
revoke all on function public.create_campaign_episode(uuid, text) from anon;
grant execute on function public.create_campaign_episode(uuid, text) to authenticated;

revoke all on function public.add_posts_to_episode(uuid, text[]) from public;
revoke all on function public.add_posts_to_episode(uuid, text[]) from anon;
grant execute on function public.add_posts_to_episode(uuid, text[]) to authenticated;
