// Cloudflare Pages Function: /api/add-expense
// Simple endpoint for adding expenses directly (cash, manual entry from Shortcuts)
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

  const userId   = keyRow.user_id;
  const amount   = Math.round(Number(body.amount));
  const note     = (body.note || "").trim().slice(0, 100);
  const category = (body.category || "personal").trim().toLowerCase() === "uncategorized" ? "personal" : (body.category || "personal").trim().toLowerCase();
  const payMode  = (body.pay_mode || "cash").trim();

  if (!amount || amount <= 0 || amount >= 10_000_000) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid amount" }), { status: 400, headers: cors });
  }

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

  let catId = userCats[0]?.id || "personal";
  let tripId = null;
  const catLower = category.toLowerCase().trim();

  // "Do not Log" → skip logging entirely
  if (catLower === "do_not_log" || category === "\u274C Do not Log") {
    return new Response(JSON.stringify({ ok: true, deleted: true, note: "Expense not logged" }), { headers: cors });
  }

  if (catLower.startsWith("trip_")) {
    tripId = category.replace(/^trip_/i, "");
    catId = "trip";
  } else {
    // Build dynamic map: id → id, label → id, "icon label" → id
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
      // Emoji prefix not in catMap — try trip by display name (e.g. "🏖️ Beach Trip")
      const tripName = category.replace(/^[^\w\s]+\s*/u, "").trim();
      const { data: tripRow } = await supabase.from("trips")
        .select("id").eq("user_id", userId).ilike("name", tripName).maybeSingle();
      if (tripRow) { tripId = tripRow.id; catId = "trip"; }
    } else {
      catId = catMap[catLower] || userCats[0]?.id || "personal";
    }
  }

  const expId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const { error } = await supabase.from("expenses").insert({
    id:       expId,
    user_id:  userId,
    amount,
    note,
    category: catId,
    pay_mode: payMode,
    date:     new Date().toISOString(),
    trip_id:  tripId,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true, amount, note, category: catId, pay_mode: payMode }), { headers: cors });
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
