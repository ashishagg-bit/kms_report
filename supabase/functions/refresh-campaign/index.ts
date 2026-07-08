// refresh-campaign: pulls stored post_urls for a campaign, re-scrapes them
// via Apify's Instagram Post Scraper, and upserts the results.
//
// NOTE ON APIFY SCHEMA: field names below (likesCount, videoViewCount,
// latestComments, etc.) reflect apify/instagram-post-scraper's documented
// output as of this actor's stable version. Apify actor schemas evolve;
// before relying on this in production, run one campaign through and
// diff a raw_json row against the field names read in extractPostFields()
// below, adjusting the candidate key lists if the actor has changed.
//
// IMPORTANT: "views" is Instagram's public view-count metric available on
// scraped posts/reels. It is NOT Meta's Reach metric -- Reach is only
// available via the Insights API for accounts you own, which is out of
// scope for public post scraping. Do not conflate the two.

import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { adminClient, requireAdmin } from "../_shared/authorizeAdmin.ts";

const APIFY_TOKEN = Deno.env.get("APIFY_TOKEN")!;
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

    const items = await runApifyScraper(postUrls);
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

async function runApifyScraper(directUrls: string[]): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directUrls,
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
    const url = firstString(item, ["url", "inputUrl", "postUrl"]);
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
    const { error } = await admin
      .from("campaign_posts")
      .upsert(rows, { onConflict: "campaign_id,post_url" });
    if (error) throw error;
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
