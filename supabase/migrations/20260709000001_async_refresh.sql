-- Support large batch refreshes (200-500 posts) without hitting Edge
-- Function timeouts, and prevent duplicate/overlapping refreshes of the
-- same campaign (root cause of the earlier double-scrape/double-cost
-- incident).
--
-- refreshing_since: set when a refresh starts, cleared when it finishes
-- (success or failure). A refresh request for a campaign that already has
-- a recent refreshing_since is rejected outright. Stale locks (older than
-- 30 minutes -- e.g. a crashed run that never got a webhook callback) are
-- treated as not-locked so the campaign doesn't get stuck forever.
--
-- last_refresh_error: surfaces the failure reason in the UI when an async
-- run fails, instead of just silently not updating.

alter table public.campaigns add column refreshing_since timestamptz;
alter table public.campaigns add column last_refresh_error text;
