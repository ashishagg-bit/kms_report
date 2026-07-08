-- KWMS Campaign Reports: core schema
-- brands / campaigns / campaign_posts / profiles + campaign_stats aggregate view

create extension if not exists "pgcrypto";

-- ============================================================
-- brands
-- ============================================================
create table public.brands (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  logo_url       text,
  contact_email  text not null,
  created_at     timestamptz not null default now()
);

comment on table public.brands is 'Client brands KWMS runs campaigns for.';
comment on column public.brands.contact_email is 'Login email for the client user tied to this brand.';

-- ============================================================
-- campaigns
-- ============================================================
create table public.campaigns (
  id                 uuid primary key default gen_random_uuid(),
  brand_id           uuid not null references public.brands(id) on delete cascade,
  title              text not null,
  slug               text not null unique,
  status             text not null default 'active' check (status in ('active', 'completed')),
  created_at         timestamptz not null default now(),
  last_refreshed_at  timestamptz
);

create index campaigns_brand_id_idx on public.campaigns(brand_id);
create index campaigns_status_idx on public.campaigns(status);

-- ============================================================
-- campaign_posts
-- ============================================================
create table public.campaign_posts (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.campaigns(id) on delete cascade,
  post_url          text not null,
  posted_at         timestamptz,
  views             bigint,
  likes             bigint,
  comments_count    bigint,
  shares            bigint,
  thumbnail_url     text,
  creator_username  text,
  top_comments      jsonb not null default '[]'::jsonb,
  raw_json          jsonb,
  created_at        timestamptz not null default now(),
  unique (campaign_id, post_url)
);

comment on column public.campaign_posts.views is
  'Instagram "views" metric from public post scraping. NOT the same as Meta Reach/Insights — Reach is unavailable outside owned-account Insights API.';
comment on column public.campaign_posts.top_comments is
  'Top 5 comments by like count: [{username, text, likes}]';
comment on column public.campaign_posts.raw_json is
  'Full raw Apify payload for this post, retained for future field additions.';

create index campaign_posts_campaign_id_idx on public.campaign_posts(campaign_id);

-- ============================================================
-- profiles (extends auth.users)
-- ============================================================
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null check (role in ('kwms_admin', 'client')),
  brand_id    uuid references public.brands(id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint profiles_brand_scope_chk check (
    (role = 'kwms_admin' and brand_id is null) or
    (role = 'client' and brand_id is not null)
  )
);

create index profiles_brand_id_idx on public.profiles(brand_id);

-- ============================================================
-- campaign_stats aggregate view
-- security_invoker so RLS on the underlying tables is evaluated
-- as the querying user, not the view owner.
-- ============================================================
create view public.campaign_stats
with (security_invoker = true) as
select
  c.id as campaign_id,
  c.brand_id,
  c.title,
  c.slug,
  c.status,
  c.last_refreshed_at,
  count(cp.id) as total_posts,
  coalesce(sum(cp.views), 0) as total_views,
  coalesce(sum(cp.likes), 0) as total_likes,
  coalesce(sum(cp.comments_count), 0) as total_comments,
  coalesce(sum(cp.shares), 0) as total_shares,
  coalesce(top5.top_posts, '[]'::jsonb) as top_posts_by_engagement
from public.campaigns c
left join public.campaign_posts cp on cp.campaign_id = c.id
left join lateral (
  select jsonb_agg(ranked) as top_posts
  from (
    select
      cp2.id,
      cp2.post_url,
      cp2.thumbnail_url,
      cp2.creator_username,
      cp2.views,
      cp2.likes,
      cp2.comments_count,
      cp2.shares,
      (coalesce(cp2.likes, 0) + coalesce(cp2.comments_count, 0) + coalesce(cp2.shares, 0)) as engagement
    from public.campaign_posts cp2
    where cp2.campaign_id = c.id
    order by engagement desc
    limit 5
  ) ranked
) top5 on true
group by c.id, c.brand_id, c.title, c.slug, c.status, c.last_refreshed_at, top5.top_posts;

comment on view public.campaign_stats is
  'Per-campaign aggregate stats + top 5 posts by engagement (likes+comments+shares). RLS-scoped via security_invoker.';
