// Cloudflare Pages Function: /api/delete-account
import { createClient } from "@supabase/supabase-js";

const ALLOWED_ORIGIN = "https://expenses.gurjarbooks.com";

export async function onRequestPost(context) {
  const { env, request } = context;
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : ALLOWED_ORIGIN;
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": corsOrigin,
  };

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), { status: 400, headers: cors });
  }

  const token = (body.access_token || "").trim();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "No token" }), { status: 401, headers: cors });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Verify token and get user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors });
  }

  const userId = user.id;

  // Delete all user data — check for errors
  const results = await Promise.all([
    supabase.from("expenses").delete().eq("user_id", userId),
    supabase.from("trips").delete().eq("user_id", userId),
    supabase.from("user_prefs").delete().eq("user_id", userId),
    supabase.from("user_keys").delete().eq("user_id", userId),
  ]);

  const dataErrors = results.filter(r => r.error);
  if (dataErrors.length > 0) {
    return new Response(JSON.stringify({ ok: false, error: "Failed to delete some data, account preserved" }), { status: 500, headers: cors });
  }

  // Delete auth account (only after all data successfully deleted)
  const { error: delError } = await supabase.auth.admin.deleteUser(userId);
  if (delError) {
    return new Response(JSON.stringify({ ok: false, error: delError.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
