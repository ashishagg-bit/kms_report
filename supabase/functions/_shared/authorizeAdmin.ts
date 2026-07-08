import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jsonResponse } from "./http.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

/**
 * Verifies the request's JWT belongs to a logged-in kwms_admin.
 * Returns the caller's user id, or a Response to return immediately
 * if the request is unauthenticated / not an admin.
 */
export async function requireAdmin(
  req: Request,
  admin: SupabaseClient,
): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return jsonResponse({ error: "unauthorized" }, 401);

  // Internal calls (the pg_cron scheduled refresh) authenticate with the
  // project's own service role key, known only to this function's runtime
  // env and to the database's app.settings.service_role_key GUC -- never
  // exposed to any browser client. Bypasses the human admin/profile lookup.
  if (jwt === SERVICE_ROLE_KEY) {
    return { userId: "service_role" };
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .single();

  if (profileErr || profile?.role !== "kwms_admin") {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  return { userId: userData.user.id };
}
