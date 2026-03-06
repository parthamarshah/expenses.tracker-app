// Cloudflare Pages Function: /api/categories
// Returns fixed categories + active trips for the user's shortcut key
import { createClient } from "@supabase/supabase-js";

export async function onRequestGet(context) {
  const { env, request } = context;
  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  const url = new URL(request.url);
  const token = (url.searchParams.get("key") || "").trim();

  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "No key provided" }), { status: 401, headers: cors });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Look up user from key
  const { data: keyRow } = await supabase
    .from("user_keys")
    .select("user_id")
    .eq("key_value", token)
    .maybeSingle();

  if (!keyRow) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors });
  }

  const userId = keyRow.user_id;

  // Default categories (fallback if user has no custom prefs)
  const DEFAULT_CATS = [
    { id: "personal", label: "Personal" },
    { id: "work", label: "Work" },
    { id: "home", label: "Home" },
    { id: "investment", label: "Savings" },
  ];

  // Load user's custom categories from user_prefs
  const [{ data: prefsRow }, { data: tripRows }] = await Promise.all([
    supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle(),
    supabase.from("trips").select("id, name, pinned").eq("user_id", userId).eq("archived", false).order("created_at", { ascending: false }),
  ]);

  let userCats = DEFAULT_CATS;
  if (prefsRow?.cats_json) {
    try {
      const saved = JSON.parse(prefsRow.cats_json);
      const visible = saved.filter(c => !c.hidden);
      if (visible.length > 0) userCats = visible.map(c => ({ id: c.id, label: c.label }));
    } catch {}
  }

  // Determine which trips are "active" — had an expense in last 7 days, or pinned
  const trips = tripRows || [];
  let activeTrips = trips;

  if (trips.length > 0) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const { data: recentExps } = await supabase
      .from("expenses")
      .select("trip_id")
      .eq("user_id", userId)
      .not("trip_id", "is", null)
      .gte("date", sevenDaysAgo);

    const recentTripIds = new Set((recentExps || []).map(e => e.trip_id));
    activeTrips = trips.filter(t => t.pinned || recentTripIds.has(t.id));
  }

  const categories = [
    ...userCats,
    ...activeTrips.map(t => ({ id: `trip_${t.id}`, label: `✈ ${t.name}` })),
  ];

  return new Response(JSON.stringify({ ok: true, categories }), { headers: cors });
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
