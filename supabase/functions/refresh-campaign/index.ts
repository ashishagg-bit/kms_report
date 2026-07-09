// refresh-campaign: kicks off an async Apify scrape of a campaign's posts
// and returns immediately. Results are processed later by apify-webhook
// when Apify calls back -- this avoids Edge Function execution timeouts on
// large batches (200-500 posts can take many minutes of real browser-based
// scraping, far longer than a synchronous request should ever block for).
//
// A campaign can only have one refresh in flight at a time (campaigns.
// refreshing_since acts as a lock) -- this is the backend-level fix for the
// double-refresh/double-billing issue found earlier, independent of
// whatever the frontend's "Refresh now" button does.

import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { adminClient, requireAdmin } from "../_shared/authorizeAdmin.ts";

const ACTOR_ID = "apify~instagram-post-scraper";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;

// A lock older than this is treated as stale (e.g. a run that crashed
// before its webhook ever fired) so a campaign can't get stuck forever.
const LOCK_STALE_MINUTES = 30;

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

    // Atomic compare-and-swap: acquire the lock in a single UPDATE...WHERE
    // so two simultaneous requests can't both read "unlocked" before either
    // writes (that race is exactly what let the earlier double-refresh bug
    // happen). Postgres's row-level locking serializes concurrent UPDATEs
    // on the same row -- the second one re-evaluates its WHERE clause
    // against the first one's already-committed result and simply matches
    // zero rows.
    const staleThreshold = new Date(Date.now() - LOCK_STALE_MINUTES * 60 * 1000).toISOString();
    const { data: lockedRows, error: lockErr } = await admin
      .from("campaigns")
      .update({ refreshing_since: new Date().toISOString(), last_refresh_error: null })
      .eq("id", campaignId)
      .or(`refreshing_since.is.null,refreshing_since.lt.${staleThreshold}`)
      .select("id");
    if (lockErr) throw lockErr;

    if (!lockedRows || lockedRows.length === 0) {
      const { data: campaignCheck } = await admin
        .from("campaigns")
        .select("id, refreshing_since")
        .eq("id", campaignId)
        .maybeSingle();
      if (!campaignCheck) {
        return jsonResponse({ error: "campaign_not_found" }, 404);
      }
      return jsonResponse(
        { error: "refresh_already_in_progress", refreshing_since: campaignCheck.refreshing_since },
        409,
      );
    }

    try {
      const { data: existingPosts, error: postsErr } = await admin
        .from("campaign_posts")
        .select("post_url")
        .eq("campaign_id", campaignId);
      if (postsErr) throw postsErr;

      const postUrls = (existingPosts ?? []).map((p) => p.post_url as string);
      if (postUrls.length === 0) {
        // Nothing to do -- release the lock we just took.
        await admin.from("campaigns").update({ refreshing_since: null }).eq("id", campaignId);
        return jsonResponse({
          campaign_id: campaignId,
          message: "no_posts_to_refresh",
        });
      }

      const { data: apifyToken, error: tokenErr } = await admin.rpc("get_apify_token");
      if (tokenErr || !apifyToken) {
        throw new Error("apify_token not found in Vault (see migration 20260708000007_apify_token_vault.sql)");
      }

      const { data: webhookSecret, error: secretErr } = await admin.rpc("get_apify_webhook_secret");
      if (secretErr || !webhookSecret) {
        throw new Error("apify_webhook_secret not found in Vault (see migration 20260709000001_async_refresh.sql)");
      }

      const runId = await startApifyRun(
        postUrls,
        apifyToken as string,
        webhookSecret as string,
        campaignId,
      );

      return jsonResponse({
        campaign_id: campaignId,
        status: "started",
        requested: postUrls.length,
        run_id: runId,
      });
    } catch (err) {
      // Starting the run failed after we'd already acquired the lock --
      // release it so the campaign doesn't stay stuck for 30 minutes.
      await admin
        .from("campaigns")
        .update({
          refreshing_since: null,
          last_refresh_error: err instanceof Error ? err.message : String(err),
        })
        .eq("id", campaignId);
      throw err;
    }
  } catch (err) {
    console.error("refresh-campaign error", err);
    return jsonResponse(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

async function startApifyRun(
  directUrls: string[],
  apifyToken: string,
  webhookSecret: string,
  campaignId: string,
): Promise<string | null> {
  const webhookUrl =
    `${SUPABASE_URL}/functions/v1/apify-webhook` +
    `?secret=${encodeURIComponent(webhookSecret)}` +
    `&campaign_id=${encodeURIComponent(campaignId)}`;

  // Apify's ad-hoc per-run webhook mechanism: a base64-encoded JSON array
  // passed as the `webhooks` query param on the "run actor" call, so we
  // don't need to pre-configure anything in the Apify console. Verified
  // live below (see startApifyRun's caller / the live test run after
  // deploy) -- flagging in case Apify's exact mechanism has since changed.
  const webhooksParam = encodeURIComponent(
    btoa(
      JSON.stringify([
        {
          eventTypes: ["ACTOR.RUN.SUCCEEDED", "ACTOR.RUN.FAILED", "ACTOR.RUN.TIMED_OUT", "ACTOR.RUN.ABORTED"],
          requestUrl: webhookUrl,
        },
      ]),
    ),
  );

  const res = await fetch(
    `https://api.apify.com/v2/acts/${ACTOR_ID}/runs?token=${apifyToken}&webhooks=${webhooksParam}`,
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
    throw new Error(`Failed to start Apify run: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data?.data?.id ?? null;
}
