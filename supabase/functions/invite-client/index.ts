// invite-client: kwms_admin-only. Sends a Supabase Auth invite email to a
// client contact, scoped to one brand via a profiles row. The invited user
// sets their own password on first login through Supabase Auth's invite flow.

import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { adminClient, requireAdmin } from "../_shared/authorizeAdmin.ts";

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
    const brandId = body?.brand_id;
    const email = body?.email;
    if (!brandId || !email) {
      return jsonResponse({ error: "brand_id and email are required" }, 400);
    }

    const { data: brand, error: brandErr } = await admin
      .from("brands")
      .select("id")
      .eq("id", brandId)
      .single();
    if (brandErr || !brand) {
      return jsonResponse({ error: "brand_not_found" }, 404);
    }

    const { data: inviteData, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { invited_brand_id: brandId },
    });

    if (inviteErr || !inviteData?.user) {
      return jsonResponse(
        { error: "invite_failed", message: inviteErr?.message ?? "unknown_error" },
        500,
      );
    }

    const { error: profileErr } = await admin
      .from("profiles")
      .upsert({ id: inviteData.user.id, role: "client", brand_id: brandId });

    if (profileErr) {
      return jsonResponse(
        { error: "profile_creation_failed", message: profileErr.message },
        500,
      );
    }

    return jsonResponse({
      user_id: inviteData.user.id,
      email,
      brand_id: brandId,
      status: "invited",
    });
  } catch (err) {
    console.error("invite-client error", err);
    return jsonResponse(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
