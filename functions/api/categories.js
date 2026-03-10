// Cloudflare Pages Function: /api/categories
// Returns user's categories + active trips for iOS Shortcut "Choose from List"
import { createClient } from "@supabase/supabase-js";

const OLD_DEFAULT_CATEGORIES = [
  { id: "personal",   label: "Personal", icon: "👤" },
  { id: "work",       label: "Work",     icon: "💼" },
  { id: "home",       label: "Home",     icon: "🏠" },
  { id: "investment", label: "Savings",  icon: "₹"  },
];

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

  // Auth first (required before other queries)
  const { data: keyRow } = await supabase
    .from("user_keys").select("user_id").eq("key_value", token).maybeSingle();

  if (!keyRow) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors });
  }

  const userId = keyRow.user_id;
  const sevenDaysAgo = new Date(Date.now() - 7 * 864e5).toISOString();

  // Fetch prefs + trips + recent trip expenses all in parallel
  const [{ data: prefsData }, { data: tripsData }, { data: expsData }] = await Promise.all([
    supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle(),
    supabase.from("trips").select("id, name, pinned").eq("user_id", userId).eq("archived", false).order("created_at", { ascending: false }),
    supabase.from("expenses").select("trip_id").eq("user_id", userId).not("trip_id", "is", null).gte("date", sevenDaysAgo),
  ]);

  // Resolve user's categories from user_prefs.cats_json
  let userCats = OLD_DEFAULT_CATEGORIES;
  if (prefsData?.cats_json) {
    try {
      const parsed = JSON.parse(prefsData.cats_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Filter out hidden categories
        const visible = parsed.filter(c => !c.hidden);
        if (visible.length > 0) userCats = visible;
      }
    } catch {}
  }

  // Build category list with "icon label" format for iOS Shortcut display
  const categories = userCats.map(c => ({ id: c.id, label: `${c.icon} ${c.label}` }));

  // Active trips (pinned or had expense in last 7 days)
  const trips = tripsData || [];
  const recentTripIds = new Set((expsData || []).map(e => e.trip_id));
  const activeTrips = trips.filter(t => t.pinned || recentTripIds.has(t.id));
  const tripCats = activeTrips.map(t => ({ id: `trip_${t.id}`, label: `✈️ ${t.name}` }));

  const allCategories = [...categories, ...tripCats];

  // labels: flat array of display strings for iOS "Choose from List"
  const labels = allCategories.map(c => c.label);

  // categories_map: label→id dictionary (useful for Android Shortcuts / mapping back)
  const categoriesMap = {};
  allCategories.forEach(c => { categoriesMap[c.label] = c.id; });

  // categories_list: alias for labels (backward compat with Android shortcut)
  const categoriesList = labels;

  return new Response(JSON.stringify({ ok: true, categories: allCategories, labels, categories_list: categoriesList, categories_map: categoriesMap }), { headers: cors });
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
