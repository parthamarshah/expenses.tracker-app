// Cloudflare Worker: /api/stats-history
// Public endpoint — returns weekly activity counts for the landing page chart.
// No PII: only counts aggregated by week, no user IDs, amounts, or expense details.
import { createClient } from "@supabase/supabase-js";

export async function onRequestGet(context) {
  const { env } = context;
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // 1-hour edge cache
  const cache = caches.default;
  const cacheKey = new Request("https://stats-cache-key/api/stats-history");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Fetch last 12 weeks of raw expense rows (date + user_id only — no amounts or notes).
  // We aggregate in JS because Supabase's client SDK doesn't expose DATE_TRUNC directly.
  const twelveWeeksAgo = new Date(Date.now() - 12 * 7 * 864e5).toISOString().slice(0, 10);
  const { data: rows } = await supabase
    .from("expenses")
    .select("date, user_id")
    .gte("date", twelveWeeksAgo)
    .limit(10000);

  // Group by ISO week (Mon-aligned): find the Monday of each expense's date.
  const weekMap = new Map();
  for (const row of rows || []) {
    const d = new Date(row.date);
    const day = d.getUTCDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day;
    const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    const key = mon.toISOString().slice(0, 10);
    if (!weekMap.has(key)) weekMap.set(key, { entries: 0, users: new Set() });
    const bucket = weekMap.get(key);
    bucket.entries++;
    bucket.users.add(row.user_id);
  }

  const weeks = [...weekMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week_start, { entries, users }]) => ({ week_start, entries, users: users.size }));

  const body = JSON.stringify({ ok: true, weeks });
  const response = new Response(body, {
    headers: { ...cors, "Cache-Control": "public, max-age=3600" },
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
