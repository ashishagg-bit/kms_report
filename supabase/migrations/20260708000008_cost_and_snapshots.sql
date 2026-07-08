-- Two additive features requested for the client-facing reports:
--
-- 1. Per-post cost/ROI tracking (admin-only). Deliberately a SEPARATE table
--    with NO client RLS policy at all -- not a column hidden by convention
--    in the UI, but a table clients get zero rows from no matter how they
--    query it, same isolation guarantee as everything else in this schema.
--
-- 2. Historical snapshots for growth-over-time charts. campaign_posts is
--    upserted in place on every refresh (today's totals only) -- this new
--    table captures a row per post on every refresh so trend charts have
--    real history to draw from, instead of only ever showing "right now."

-- ============================================================
-- campaign_post_costs (admin-only, no client access whatsoever)
-- ============================================================
create table public.campaign_post_costs (
  campaign_post_id  uuid primary key references public.campaign_posts(id) on delete cascade,
  cost              numeric,
  updated_at        timestamptz not null default now()
);

alter table public.campaign_post_costs enable row level security;

create policy campaign_post_costs_admin_all
  on public.campaign_post_costs
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

-- Intentionally no client policy -- RLS defaults to deny-all for any role
-- without a matching policy, so a client querying this table (directly or
-- via a join) always gets zero rows, never an error.

-- ============================================================
-- campaign_post_snapshots (history for trend charts)
-- ============================================================
create table public.campaign_post_snapshots (
  id                 uuid primary key default gen_random_uuid(),
  campaign_post_id   uuid not null references public.campaign_posts(id) on delete cascade,
  views              bigint,
  likes              bigint,
  comments_count     bigint,
  shares             bigint,
  captured_at        timestamptz not null default now()
);

create index campaign_post_snapshots_post_id_captured_at_idx
  on public.campaign_post_snapshots(campaign_post_id, captured_at);

alter table public.campaign_post_snapshots enable row level security;

create policy campaign_post_snapshots_admin_all
  on public.campaign_post_snapshots
  for all
  to authenticated
  using (public.current_user_role() = 'kwms_admin')
  with check (public.current_user_role() = 'kwms_admin');

create policy campaign_post_snapshots_client_select_own
  on public.campaign_post_snapshots
  for select
  to authenticated
  using (
    public.current_user_role() = 'client'
    and exists (
      select 1
      from public.campaign_posts cp
      join public.campaigns c on c.id = cp.campaign_id
      where cp.id = campaign_post_snapshots.campaign_post_id
        and c.brand_id = public.current_user_brand_id()
    )
  );

-- Per-campaign, per-day aggregate for a simple growth-over-time chart.
create view public.campaign_daily_stats
with (security_invoker = true) as
select
  cp.campaign_id,
  date_trunc('day', s.captured_at) as day,
  sum(s.views) as total_views,
  sum(s.likes) as total_likes,
  sum(s.comments_count) as total_comments,
  sum(s.shares) as total_shares
from public.campaign_post_snapshots s
join public.campaign_posts cp on cp.id = s.campaign_post_id
group by cp.campaign_id, date_trunc('day', s.captured_at);

comment on view public.campaign_daily_stats is
  'Daily rollup of campaign_post_snapshots for growth-over-time charts. RLS-scoped via security_invoker.';
