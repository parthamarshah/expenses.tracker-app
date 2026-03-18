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

  // Check Cloudflare edge cache first (5-minute TTL per API key)
  const cache = caches.default;
  const cacheKey = request.url;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

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

  // Fetch prefs + trips in parallel (removed expenses query — return all active trips)
  const [{ data: prefsData }, { data: tripsData }] = await Promise.all([
    supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle(),
    supabase.from("trips").select("id, name, pinned").eq("user_id", userId).eq("archived", false).order("pinned", { ascending: false }).order("created_at", { ascending: false }),
  ]);

  // Resolve user's categories from user_prefs.cats_json
  let userCats = OLD_DEFAULT_CATEGORIES;
  if (prefsData?.cats_json) {
    try {
      const parsed = JSON.parse(prefsData.cats_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const visible = parsed.filter(c => !c.hidden);
        if (visible.length > 0) userCats = visible;
      }
    } catch {}
  }

  // Build category list with "icon label" format for iOS Shortcut display
  const categories = userCats.map(c => ({ id: c.id, label: `${c.icon} ${c.label}` }));

  // Active trips (all non-archived, pinned ones first)
  const tripCats = (tripsData || []).map(t => ({ id: `trip_${t.id}`, label: `✈️ ${t.name}` }));

  const allCategories = [...categories, ...tripCats];
  const labels = allCategories.map(c => c.label);
  const categoriesMap = {};
  allCategories.forEach(c => { categoriesMap[c.label] = c.id; });

  const body = JSON.stringify({
    ok: true,
    categories: allCategories,
    labels,
    categories_list: labels,
    categories_map: categoriesMap,
  });

  // Cache for 5 minutes at Cloudflare edge
  const response = new Response(body, {
    headers: { ...cors, "Cache-Control": "private, max-age=300" },
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
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
