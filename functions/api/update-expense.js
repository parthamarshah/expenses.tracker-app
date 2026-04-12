// Cloudflare Pages Function: /api/update-expense
// Updates an existing expense's category (used by iPhone Shortcut after deferred category pick)
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

  const bodyKey  = (body.key || "").trim();
  const authHdr  = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const token    = bodyKey || authHdr;

  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "No key provided" }), { status: 401, headers: cors });
  }

  const expenseId = (body.id || "").trim();
  const category  = (body.category || "").trim();

  if (!expenseId) {
    return new Response(JSON.stringify({ ok: false, error: "id required" }), { status: 400, headers: cors });
  }
  if (!category) {
    return new Response(JSON.stringify({ ok: false, error: "category required" }), { status: 400, headers: cors });
  }
  // Cannot assign "uncategorized" — one-way only (from uncategorized → real category)
  if (category.toLowerCase() === "uncategorized") {
    return new Response(JSON.stringify({ ok: false, error: "Cannot set category to uncategorized" }), { status: 400, headers: cors });
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

  // Load user's categories for dynamic label→id resolution
  const { data: prefsData } = await supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle();
  let userCats = [
    { id: "personal", label: "Personal", icon: "👤" },
    { id: "work",     label: "Work",     icon: "💼" },
    { id: "home",     label: "Home",     icon: "🏠" },
    { id: "investment", label: "Savings", icon: "₹" },
  ];
  if (prefsData?.cats_json) {
    try {
      const parsed = JSON.parse(prefsData.cats_json);
      if (Array.isArray(parsed) && parsed.length > 0) userCats = parsed;
    } catch {}
  }

  // Resolve category (same logic as add-expense.js: id/label/icon+label/trip support)
  let catId = userCats[0]?.id || "personal";
  let tripId = null;
  const catLower = category.toLowerCase().trim();

  // "Do not Log" → delete the expense entirely
  if (catLower === "do_not_log" || category === "\u274C Do not Log") {
    const { error: delErr } = await supabase.from("expenses")
      .delete().eq("id", expenseId).eq("user_id", userId);
    if (delErr) return new Response(JSON.stringify({ ok: false, error: delErr.message }), { status: 500, headers: cors });
    return new Response(JSON.stringify({ ok: true, deleted: true, id: expenseId }), { headers: cors });
  }

  if (catLower.startsWith("trip_")) {
    tripId = category.replace(/^trip_/i, "");
    catId = "trip";
  } else {
    const catMap = {};
    userCats.forEach(c => {
      catMap[c.id.toLowerCase()] = c.id;
      catMap[c.label.toLowerCase()] = c.id;
      if (c.icon) catMap[`${c.icon} ${c.label}`.toLowerCase()] = c.id;
    });
    catMap["savings"] = "investment";
    catMap["investment"] = "investment";

    if (catMap[catLower]) {
      catId = catMap[catLower];
    } else if (/^[^\w\s]/.test(category)) {
      const tripName = category.replace(/^[^\w\s]+\s*/u, "").trim();
      const { data: tripRow } = await supabase.from("trips")
        .select("id").eq("user_id", userId).ilike("name", tripName).maybeSingle();
      if (tripRow) { tripId = tripRow.id; catId = "trip"; }
    } else {
      catId = catMap[catLower] || userCats[0]?.id || "personal";
    }
  }

  // Update — .eq("user_id") prevents cross-user modification
  const { data, error } = await supabase
    .from("expenses")
    .update({ category: catId, trip_id: tripId })
    .eq("id", expenseId)
    .eq("user_id", userId)
    .select("id");

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors });
  }
  if (!data || data.length === 0) {
    return new Response(JSON.stringify({ ok: false, error: "Expense not found" }), { status: 404, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true, id: expenseId, category: catId, trip_id: tripId }), { headers: cors });
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
