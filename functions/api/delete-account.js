// Cloudflare Pages Function: /api/delete-account
import { createClient } from "@supabase/supabase-js";

export async function onRequestPost(context) {
  const { env, request } = context;
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
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

  // Delete all user data
  await Promise.all([
    supabase.from("expenses").delete().eq("user_id", userId),
    supabase.from("trips").delete().eq("user_id", userId),
    supabase.from("user_prefs").delete().eq("user_id", userId),
    supabase.from("user_keys").delete().eq("user_id", userId),
  ]);

  // Delete auth account
  const { error: delError } = await supabase.auth.admin.deleteUser(userId);
  if (delError) {
    return new Response(JSON.stringify({ ok: false, error: delError.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
