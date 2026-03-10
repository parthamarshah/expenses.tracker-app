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
  const category = (body.category || "personal").trim().toLowerCase();
  const payMode  = (body.pay_mode || "cash").trim();

  if (!amount || amount <= 0 || amount >= 10_000_000) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid amount" }), { status: 400, headers: cors });
  }

  let catId = "personal";
  let tripId = null;

  if (category.startsWith("trip_")) {
    tripId = category.replace("trip_", "");
    catId = "trip";
  } else if (category.startsWith("custom_") || ["personal", "work", "home", "investment"].includes(category)) {
    catId = category;
  } else {
    // Try resolving by label (e.g., "Personal" → "personal", "Savings" → "investment")
    const labelMap = { personal: "personal", work: "work", home: "home", savings: "investment", investment: "investment" };
    if (labelMap[category]) {
      catId = labelMap[category];
    } else {
      // Check user's custom categories by label match
      const { data: prefsRow } = await supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle();
      if (prefsRow?.cats_json) {
        try {
          const cats = JSON.parse(prefsRow.cats_json);
          const match = cats.find(c => c.label && c.label.toLowerCase() === category);
          if (match) catId = match.id;
        } catch {}
      }
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
