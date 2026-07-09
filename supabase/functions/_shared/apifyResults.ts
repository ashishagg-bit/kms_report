import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface FailedPost {
  url: string;
  reason: string;
}

export function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number") return value;
  }
  return null;
}

export function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function extractPostFields(item: Record<string, unknown>) {
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

  // NOTE: "shares" is deliberately NOT set here. Verified live against two
  // different Apify Instagram actors (including on video/reel posts): the
  // field never appears in the scraped data, because Instagram never sends
  // a share count to anyone but the post's own owner, for any post type.
  // campaign_posts.shares is admin-entered only (a creator's self-reported
  // number). Omitting the key here entirely means this upsert never
  // touches/clobbers a manually-entered value.
  return {
    posted_at: postedAtRaw ? new Date(postedAtRaw).toISOString() : null,
    // "views" -- public scrape metric, not Meta Reach.
    views: firstNumber(item, ["videoViewCount", "videoPlayCount", "viewCount", "views"]),
    likes: firstNumber(item, ["likesCount", "likes"]),
    comments_count: firstNumber(item, ["commentsCount", "comments"]),
    thumbnail_url: firstString(item, ["displayUrl", "thumbnailUrl", "imageUrl"]),
    // Only present for video/reel posts -- lets the frontend play the real
    // video natively instead of needing Instagram's oEmbed/embed.js.
    video_url: firstString(item, ["videoUrl"]),
    creator_username: firstString(item, ["ownerUsername", "username"]),
    top_comments: topComments,
  };
}

export async function upsertApifyResults(
  admin: SupabaseClient,
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
