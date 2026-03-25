// Cloudflare Pages Function: /api/uncategorized
// Returns recent uncategorized expenses for deferred category assignment (iPhone Shortcut dual-mode)
import { createClient } from "@supabase/supabase-js";

const OLD_DEFAULT_CATEGORIES = [
  { id: "personal",   label: "Personal", icon: "👤" },
  { id: "work",       label: "Work",     icon: "💼" },
  { id: "home",       label: "Home",     icon: "🏠" },
  { id: "investment", label: "Savings",  icon: "₹"  },
];

export async function onRequestGet(context) {
  const { env, request } = context;
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  const url = new URL(request.url);
  const token = (url.searchParams.get("key") || "").trim();
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "No key provided" }), { status: 401, headers: cors });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: keyRow } = await supabase
    .from("user_keys").select("user_id").eq("key_value", token).maybeSingle();
  if (!keyRow) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors });
  }

  const userId = keyRow.user_id;

  // Fetch uncategorized expenses + user categories + trips in parallel
  const [{ data: expenses }, { data: prefsData }, { data: tripsData }] = await Promise.all([
    supabase.from("expenses")
      .select("id, amount, note, date")
      .eq("user_id", userId)
      .eq("category", "uncategorized")
      .order("date", { ascending: false })
      .limit(20),
    supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle(),
    supabase.from("trips").select("id, name, pinned").eq("user_id", userId)
      .eq("archived", false).order("pinned", { ascending: false }),
  ]);

  // Build category labels + map for shortcut
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

  const catEntries = userCats.map(c => ({ id: c.id, label: `${c.icon} ${c.label}` }));
  const tripEntries = (tripsData || []).map(t => ({ id: `trip_${t.id}`, label: `✈️ ${t.name}` }));
  const allEntries = [...catEntries, ...tripEntries];
  const labels = allEntries.map(c => c.label);
  const categoriesMap = {};
  allEntries.forEach(c => { categoriesMap[c.label] = c.id; });

  // Format expense labels for "Choose from List": "₹500 Swiggy · 25 Mar"
  const expenseLabels = (expenses || []).map(e => {
    const d = new Date(e.date);
    const day = d.getDate();
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    return `₹${e.amount.toLocaleString("en-IN")} ${e.note || "Expense"} · ${day} ${mon}`;
  });
  const expenseMap = {};
  (expenses || []).forEach((e, i) => { expenseMap[expenseLabels[i]] = e.id; });

  return new Response(JSON.stringify({
    ok: true,
    count: (expenses || []).length,
    expense_labels: expenseLabels,
    expense_map: expenseMap,
    labels,
    categories_map: categoriesMap,
  }), { headers: cors });
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
