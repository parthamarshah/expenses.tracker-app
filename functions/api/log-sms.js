// Cloudflare Pages Function: /api/log-sms
// Uses @supabase/supabase-js so the newer sb_secret_... key format works correctly

import { createClient } from "@supabase/supabase-js";

export async function onRequestPost(context) {
  const { env, request } = context;

  const cors = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  // Bearer token auth
  const auth = (request.headers.get("Authorization") || "").trim();
  if (auth !== `Bearer ${env.LOG_SMS_SECRET}`) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), { status: 400, headers: cors });
  }

  const sms      = (body.sms      || "").trim();
  const category = (body.category || "personal").trim().toLowerCase();
  const payMode  = (body.pay_mode || "bank").trim();

  if (!sms) {
    return new Response(JSON.stringify({ ok: false, error: "sms field required" }), { status: 400, headers: cors });
  }

  // ── Parse SMS ─────────────────────────────────────────────────────────────
  const amount = parseSmsAmount(sms);
  if (!amount) {
    return new Response(JSON.stringify({ ok: false, error: "Could not parse amount", sms }), { status: 422, headers: cors });
  }
  const note = parseSmsNote(sms);

  // ── Map category label → id ───────────────────────────────────────────────
  const catMap = { personal: "personal", work: "work", home: "home", savings: "investment", investment: "investment" };
  const catId = catMap[category] || "personal";

  // ── Insert via Supabase JS client (handles new key format) ────────────────
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const expId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const { error } = await supabase.from("expenses").insert({
    id:       expId,
    user_id:  env.OWNER_USER_ID,
    amount:   amount,
    note:     note,
    category: catId,
    pay_mode: payMode,
    date:     new Date().toISOString(),
    trip_id:  null,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true, amount, note, category: catId }), { headers: cors });
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

// ── SMS Parsing ──────────────────────────────────────────────────────────────

function parseSmsAmount(sms) {
  const patterns = [
    /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /(?:debited(?:\s+for)?|spent|paid(?:\s+via)?)\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /([\d,]+(?:\.\d{1,2})?)\s*(?:INR\s*)?has\s+been\s+debited/i,
    /([\d,]+(?:\.\d{1,2})?)\s+(?:INR\s*)?debited/i,
    /transaction\s+of\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
    /purchase\s+of\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const pat of patterns) {
    const m = sms.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 0 && val < 10_000_000) return Math.round(val);
    }
  }
  return null;
}

function parseSmsNote(sms) {
  const patterns = [
    /\b(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9 &\-\.]{2,35}?)(?:\s+on\s|\s+via\s|\s+using\s|\s+ref|\s+\d|[.,]|$)/i,
    /(?:VPA|UPI[:\s]+)([A-Za-z0-9._-]+@[A-Za-z0-9]+)/i,
    /(?:Info|Remarks|Narration|Description)[:\s]+([A-Za-z0-9][A-Za-z0-9 &\-\/\.]{2,35})/i,
  ];
  for (const pat of patterns) {
    const m = sms.match(pat);
    if (m) {
      const note = m[1].trim().replace(/\s+/g, " ");
      if (note.length >= 2) return note.slice(0, 50);
    }
  }
  return "SMS expense";
}
