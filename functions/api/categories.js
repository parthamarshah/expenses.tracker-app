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

  const { data: keyRow } = await supabase
    .from("user_keys")
    .select("user_id")
    .eq("key_value", token)
    .maybeSingle();

  if (!keyRow) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors });
  }

  const userId = keyRow.user_id;

  // Fixed base categories with emoji icons
  const baseFixed = [
    { id: "personal", label: "👤 Personal" },
    { id: "work",     label: "💼 Work"     },
    { id: "home",     label: "🏠 Home"     },
    { id: "savings",  label: "₹ Savings"  },
  ];

  // User category overrides (custom labels/icons + custom categories)
  const { data: userCatRows } = await supabase
    .from("user_categories")
    .select("id, label, icon, hidden, is_savings")
    .eq("user_id", userId)
    .eq("hidden", false);

  const userCats = userCatRows || [];
  const sysIds = new Set(["personal", "work", "home", "investment"]);

  // Build override map for system categories
  const overrideMap = {};
  const customCats = [];
  userCats.forEach(c => {
    if (sysIds.has(c.id)) overrideMap[c.id] = c;
    else customCats.push(c);
  });

  // Build fixed categories with user overrides
  // Note: "savings" in API maps to "investment" internally
  const fixed = baseFixed
    .filter(c => {
      // If user hid the "investment" system category
      const sysId = c.id === "savings" ? "investment" : c.id;
      return !overrideMap[sysId]?.hidden;
    })
    .map(c => {
      const sysId = c.id === "savings" ? "investment" : c.id;
      const ov = overrideMap[sysId];
      if (ov) return { id: c.id, label: `${ov.icon} ${ov.label}` };
      return c;
    });

  // Add custom categories
  const custom = customCats.map(c => ({ id: c.id, label: `${c.icon} ${c.label}` }));

  // Fetch active trips
  const { data: tripRows } = await supabase
    .from("trips")
    .select("id, name, pinned")
    .eq("user_id", userId)
    .eq("archived", false)
    .order("created_at", { ascending: false });

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

  const tripCats = activeTrips.map(t => ({ id: `trip_${t.id}`, label: `✈️ ${t.name}` }));

  const categories = [...fixed, ...custom, ...tripCats];

  // Also return a flat labels array for iOS Shortcuts "Choose from List"
  // — use this array directly; the shortcut will send back the full label string
  // and log-sms.js will map it to the correct internal id.
  const labels = categories.map(c => c.label);

  return new Response(JSON.stringify({ ok: true, categories, labels }), { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
