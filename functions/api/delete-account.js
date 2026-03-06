// Cloudflare Pages Function: /api/delete-account
// Deletes the authenticated user's account and all their data
import { createClient } from "@supabase/supabase-js";

export async function onRequestPost(context) {
  const { env, request } = context;
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Extract the user's JWT from Authorization header
  const authHeader = request.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!jwt) {
    return new Response(JSON.stringify({ ok: false, error: "Not authenticated" }), { status: 401, headers: cors });
  }

  // Create a user-scoped client to verify the token and get user id
  const userClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });

  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid session" }), { status: 401, headers: cors });
  }

  // Use service key to delete the user (admin operation)
  const adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: delErr } = await adminClient.auth.admin.deleteUser(user.id);
  if (delErr) {
    return new Response(JSON.stringify({ ok: false, error: delErr.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
