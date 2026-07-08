// refresh-campaign: pulls stored post_urls for a campaign, re-scrapes them
// via Apify's Instagram Post Scraper, and upserts the results.
//
// NOTE ON APIFY SCHEMA: verified live against a real scrape (2026-07-08).
// Output field names (likesCount, commentsCount, videoViewCount,
// videoPlayCount, ownerUsername, displayUrl, timestamp, latestComments)
// are confirmed correct. The one surprise: the actor's *input* field for
// URLs to scrape is called "username" despite accepting full post/reel
// URLs directly -- see runApifyScraper() below.
//
// IMPORTANT: "views" is Instagram's public view-count metric available on
// scraped posts/reels. It is NOT Meta's Reach metric -- Reach is only
// available via the Insights API for accounts you own, which is out of
// scope for public post scraping. Do not conflate the two.

import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { adminClient, requireAdmin } from "../_shared/authorizeAdmin.ts";

const ACTOR_ID = "apify~instagram-post-scraper";

interface FailedPost {
  url: string;
  reason: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const admin = adminClient();
    const authResult = await requireAdmin(req, admin);
    if (authResult instanceof Response) return authResult;

    const body = await req.json().catch(() => null);
    const campaignId = body?.campaign_id;
    if (!campaignId) {
      return jsonResponse({ error: "campaign_id is required" }, 400);
    }

    const { data: campaign, error: campaignErr } = await admin
      .from("campaigns")
      .select("id")
      .eq("id", campaignId)
      .single();
    if (campaignErr || !campaign) {
      return jsonResponse({ error: "campaign_not_found" }, 404);
    }

    const { data: existingPosts, error: postsErr } = await admin
      .from("campaign_posts")
      .select("post_url")
      .eq("campaign_id", campaignId);
    if (postsErr) throw postsErr;

    const postUrls = (existingPosts ?? []).map((p) => p.post_url as string);
    if (postUrls.length === 0) {
      return jsonResponse({
        campaign_id: campaignId,
        message: "no_posts_to_refresh",
        succeeded: 0,
        failed: [],
      });
    }

    const { data: apifyToken, error: tokenErr } = await admin.rpc("get_apify_token");
    if (tokenErr || !apifyToken) {
      throw new Error("apify_token not found in Vault (see migration 20260708000007_apify_token_vault.sql)");
    }

    const items = await runApifyScraper(postUrls, apifyToken as string);
    const { succeeded, failed } = await upsertResults(admin, campaignId, postUrls, items);

    await admin
      .from("campaigns")
      .update({ last_refreshed_at: new Date().toISOString() })
      .eq("id", campaignId);

    if (failed.length > 0) {
      console.warn(
        `refresh-campaign: campaign ${campaignId} - ${failed.length}/${postUrls.length} posts failed`,
        failed,
      );
    }

    return jsonResponse({
      campaign_id: campaignId,
      requested: postUrls.length,
      succeeded,
      failed,
    });
  } catch (err) {
    console.error("refresh-campaign error", err);
    return jsonResponse(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

async function runApifyScraper(directUrls: string[], apifyToken: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apifyToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // Despite the name, this actor's "username" field accepts direct
        // post/reel URLs, not just handles -- verified against a live run.
        username: directUrls,
        resultsType: "details",
        addParentData: false,
      }),
    },
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Apify actor run failed: ${res.status} ${text}`);
  }

  return (await res.json()) as Record<string, unknown>[];
}

async function upsertResults(
  admin: ReturnType<typeof adminClient>,
  campaignId: string,
  requestedUrls: string[],
  items: Record<string, unknown>[],
): Promise<{ succeeded: number; failed: FailedPost[] }> {
  const rows: Record<string, unknown>[] = [];
  const matchedUrls = new Set<string>();
  const failed: FailedPost[] = [];

  for (const item of items) {
    // inputUrl is exactly what we sent (matches our stored post_url for the
    // upsert conflict target); Apify's "url" is normalized/canonicalized
    // and won't match a stored URL that has query params or a /reel/ path.
    const url = firstString(item, ["inputUrl", "url", "postUrl"]);
    if (!url) continue;

    if (item.error) {
      failed.push({ url, reason: String(item.errorDescription ?? item.error) });
      continue;
    }

    matchedUrls.add(url);
    rows.push({
      campaign_id: campaignId,
      post_url: url,
      ...extractPostFields(item),
      raw_json: item,
    });
  }

  for (const url of requestedUrls) {
    if (!matchedUrls.has(url) && !failed.some((f) => f.url === url)) {
      failed.push({ url, reason: "no_result_returned_by_apify" });
    }
  }

  if (rows.length > 0) {
    const { data: upserted, error } = await admin
      .from("campaign_posts")
      .upsert(rows, { onConflict: "campaign_id,post_url" })
      .select("id, views, likes, comments_count, shares");
    if (error) throw error;

    if (upserted && upserted.length > 0) {
      const snapshots = upserted.map((p) => ({
        campaign_post_id: p.id,
        views: p.views,
        likes: p.likes,
        comments_count: p.comments_count,
        shares: p.shares,
      }));
      const { error: snapshotErr } = await admin.from("campaign_post_snapshots").insert(snapshots);
      // Snapshot history is a nice-to-have for trend charts -- don't fail
      // the whole refresh over it, just log if it breaks.
      if (snapshotErr) console.error("failed to insert campaign_post_snapshots", snapshotErr);
    }
  }

  return { succeeded: rows.length, failed };
}

function extractPostFields(item: Record<string, unknown>) {
  const postedAtRaw = firstString(item, ["timestamp", "takenAt"]);
  const rawComments = (item.latestComments ?? item.comments ?? item.topComments ?? []) as unknown[];

  const topComments = rawComments
    .map((c) => {
      const comment = c as Record<string, unknown>;
      return {
        username: firstString(comment, ["ownerUsername", "username"]) ?? "unknown",
        text: typeof comment.text === "string" ? comment.text : "",
        likes: firstNumber(comment, ["likesCount", "likes"]) ?? 0,
      };
    })
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 5);

  return {
    posted_at: postedAtRaw ? new Date(postedAtRaw).toISOString() : null,
    // "views" -- public scrape metric, not Meta Reach. See file header note.
    views: firstNumber(item, ["videoViewCount", "videoPlayCount", "viewCount", "views"]),
    likes: firstNumber(item, ["likesCount", "likes"]),
    comments_count: firstNumber(item, ["commentsCount", "comments"]),
    shares: firstNumber(item, ["sharesCount", "shares"]),
    thumbnail_url: firstString(item, ["displayUrl", "thumbnailUrl", "imageUrl"]),
    // Only present for video/reel posts -- lets the frontend play the real
    // video natively instead of needing Instagram's oEmbed/embed.js.
    video_url: firstString(item, ["videoUrl"]),
    creator_username: firstString(item, ["ownerUsername", "username"]),
    top_comments: topComments,
  };
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
