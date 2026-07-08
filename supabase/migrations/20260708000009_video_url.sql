-- Apify's Instagram Post Scraper returns a direct video file URL
-- (raw_json->>'videoUrl') for video/reel posts, which we weren't
-- capturing into its own column. Adding it so the frontend can play the
-- actual video natively instead of needing Instagram's oEmbed/embed.js
-- (a Meta API dependency we're deliberately avoiding).

alter table public.campaign_posts add column video_url text;

comment on column public.campaign_posts.video_url is
  'Direct video file URL from Apify (raw_json.videoUrl), only present for video/reel posts. Null for photo posts -- the thumbnail_url image is the complete post in that case.';
