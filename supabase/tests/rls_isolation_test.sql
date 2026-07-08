-- RLS isolation test: proves a `client` role user can never see another
-- brand's data, and that attempting to (e.g. by guessing a campaign_id)
-- returns zero rows -- not a permission error -- so the existence of other
-- campaigns/brands is never leaked.
--
-- Safe to run against ANY environment, including production: everything
-- happens inside a single transaction that ends in ROLLBACK, so nothing
-- is ever committed. Verified live against the KWMS project on 2026-07-08;
-- results below the query match what was actually returned.
--
-- Run with: supabase db execute -f supabase/tests/rls_isolation_test.sql
-- (or paste into the SQL editor)

begin;

-- Fixtures: two brands, each with one client user, one campaign, one post
insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'client-a@rls-test.local', '', now(), 'authenticated', 'authenticated', '{}', '{}'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'client-b@rls-test.local', '', now(), 'authenticated', 'authenticated', '{}', '{}');

insert into public.brands (id, name, contact_email)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Brand A (test)', 'client-a@rls-test.local'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Brand B (test)', 'client-b@rls-test.local');

insert into public.profiles (id, role, brand_id)
values
  ('11111111-1111-1111-1111-111111111111', 'client', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('22222222-2222-2222-2222-222222222222', 'client', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

insert into public.campaigns (id, brand_id, title, slug)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Campaign A', 'campaign-a-test'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Campaign B', 'campaign-b-test');

insert into public.campaign_posts (campaign_id, post_url, likes)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'https://instagram.com/p/aaa-test', 100),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'https://instagram.com/p/bbb-test', 200);

-- Simulate PostgREST's per-request context for Client A (Brand A)
set local role authenticated;
set local request.jwt.claims = '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';

select 'client_a_sees_own_campaign_posts' as test, count(*) as row_count
from public.campaign_posts where campaign_id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
union all
select 'client_a_queries_brand_b_campaign_posts_by_guessed_id', count(*)
from public.campaign_posts where campaign_id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
union all
select 'client_a_queries_brand_b_campaign_row_directly', count(*)
from public.campaigns where id = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
union all
select 'client_a_queries_brand_b_row_directly', count(*)
from public.brands where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
union all
select 'client_a_sees_own_brand', count(*)
from public.brands where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Actual result (live run, 2026-07-08):
--   client_a_sees_own_campaign_posts                        -> 1   (expected: 1)
--   client_a_queries_brand_b_campaign_posts_by_guessed_id   -> 0   (expected: 0, no error)
--   client_a_queries_brand_b_campaign_row_directly          -> 0   (expected: 0, no error)
--   client_a_queries_brand_b_row_directly                   -> 0   (expected: 0, no error)
--   client_a_sees_own_brand                                 -> 1   (expected: 1)
--
-- No row ever raises a Postgres/PostgREST error for the out-of-scope
-- lookups -- RLS's USING clause silently filters those rows out of the
-- result set. From the client's perspective, campaign dddddddd... simply
-- does not exist, whether it's a real campaign belonging to another brand
-- or a made-up UUID that was never created. That's the property we want:
-- no way to distinguish "not yours" from "doesn't exist".

reset role;
rollback;
