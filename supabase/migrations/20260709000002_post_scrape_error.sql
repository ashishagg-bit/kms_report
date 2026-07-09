-- Surface the actual per-post scrape failure reason (e.g. "not_found: Post
-- does not exist", "restricted_page: Restricted access, only partial data
-- available") instead of only a campaign-wide count. Cleared automatically
-- the next time that post scrapes successfully -- some failures (like
-- restricted_page) are transient/Instagram-rate-limit-dependent and can
-- resolve on a later refresh; others (not_found) are permanent because the
-- post was deleted.

alter table public.campaign_posts add column last_scrape_error text;

comment on column public.campaign_posts.last_scrape_error is
  'Reason this post failed to scrape on the most recent refresh (e.g. Apify''s "not_found"/"restricted_page" errors). Null when the post last scraped successfully. Some reasons are permanent (post deleted), others transient (Instagram rate-limiting) and may clear on a later refresh.';
