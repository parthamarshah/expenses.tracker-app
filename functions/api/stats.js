// Cloudflare Pages Function: /api/stats
// Public endpoint — returns anonymous aggregate stats for the landing page.
// No PII: only counts, no user IDs, emails, amounts, or expense details.
import { createClient } from "@supabase/supabase-js";

export async function onRequestGet(context) {
  const { env } = context;
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Serve from Cloudflare edge cache for 10 minutes
  const cache = caches.default;
  const cacheKey = new Request("https://stats-cache-key/api/stats");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString();

  const [
    { count: totalExpenses },
    { count: weekExpenses },
    { data: activeUserRows },
  ] = await Promise.all([
    // Total expenses ever logged
    supabase.from("expenses").select("id", { count: "exact", head: true }),
    // Expenses logged in the last 7 days
    supabase.from("expenses").select("id", { count: "exact", head: true }).gte("date", sevenDaysAgo),
    // Distinct active users in last 7 days (count unique user_ids)
    supabase.from("expenses").select("user_id").gte("date", sevenDaysAgo).limit(1000),
  ]);

  const activeUsers = new Set((activeUserRows || []).map(r => r.user_id)).size;

  const body = JSON.stringify({
    ok: true,
    total_expenses: totalExpenses || 0,
    expenses_this_week: weekExpenses || 0,
    active_users_this_week: activeUsers,
  });

  const response = new Response(body, {
    headers: { ...cors, "Cache-Control": "public, max-age=600" },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
