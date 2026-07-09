// apify-webhook: called by Apify itself when an async scrape run started
// by refresh-campaign finishes (success, failure, timeout, or abort).
// Processes the dataset results and clears the campaign's refresh lock.
//
// This endpoint has verify_jwt DISABLED (Apify's servers can't present a
// Supabase JWT) -- it's secured instead by a `secret` query param that must
// match a value only this project's Vault and Apify's webhook config know
// (embedded in the webhook URL when refresh-campaign registers it).
//
// NOTE ON APIFY'S WEBHOOK PAYLOAD SHAPE: reading payload.eventType and
// payload.resource.{defaultDatasetId,status} reflects Apify's documented
// default webhook payload as of this build (2026-07-09), verified against a
// live test run. If Apify changes this shape, this function will start
// logging "internal_error" -- check a raw payload via the campaigns.
// last_refresh_error column or function logs if refreshes stop completing.

import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { adminClient } from "../_shared/authorizeAdmin.ts";
import { upsertApifyResults } from "../_shared/apifyResults.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const admin = adminClient();

    const url = new URL(req.url);
    const secretParam = url.searchParams.get("secret");
    const campaignId = url.searchParams.get("campaign_id");

    if (!secretParam || !campaignId) {
      return jsonResponse({ error: "missing_secret_or_campaign_id" }, 400);
    }

    const { data: expectedSecret, error: secretErr } = await admin.rpc("get_apify_webhook_secret");
    if (secretErr || !expectedSecret || secretParam !== expectedSecret) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    const payload = await req.json().catch(() => null);
    const eventType: string | undefined = payload?.eventType;
    const resource = payload?.resource;
    const datasetId: string | undefined = resource?.defaultDatasetId;
    const runStatus: string | undefined = resource?.status;

    if (eventType !== "ACTOR.RUN.SUCCEEDED" || !datasetId) {
      await admin
        .from("campaigns")
        .update({
          refreshing_since: null,
          last_refresh_error: `Apify run did not succeed (status: ${runStatus ?? eventType ?? "unknown"})`,
        })
        .eq("id", campaignId);
      return jsonResponse({ ok: true, handled: "failure_or_no_dataset" });
    }

    const { data: apifyToken, error: tokenErr } = await admin.rpc("get_apify_token");
    if (tokenErr || !apifyToken) {
      throw new Error("apify_token not found in Vault");
    }

    const itemsRes = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`,
    );
    if (!itemsRes.ok) {
      const text = await itemsRes.text().catch(() => "");
      throw new Error(`Failed to fetch Apify dataset items: ${itemsRes.status} ${text}`);
    }
    const items = (await itemsRes.json()) as Record<string, unknown>[];

    const { data: existingPosts, error: postsErr } = await admin
      .from("campaign_posts")
      .select("post_url")
      .eq("campaign_id", campaignId);
    if (postsErr) throw postsErr;
    const requestedUrls = (existingPosts ?? []).map((p) => p.post_url as string);

    const { succeeded, failed } = await upsertApifyResults(admin, campaignId, requestedUrls, items);

    await admin
      .from("campaigns")
      .update({
        last_refreshed_at: new Date().toISOString(),
        refreshing_since: null,
        last_refresh_error: failed.length > 0 ? `${failed.length}/${requestedUrls.length} posts failed` : null,
      })
      .eq("id", campaignId);

    if (failed.length > 0) {
      console.warn(
        `apify-webhook: campaign ${campaignId} - ${failed.length}/${requestedUrls.length} posts failed`,
        failed,
      );
    }

    return jsonResponse({
      ok: true,
      campaign_id: campaignId,
      requested: requestedUrls.length,
      succeeded,
      failed,
    });
  } catch (err) {
    console.error("apify-webhook error", err);
    return jsonResponse(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
