// Cloudflare Pages Function: /api/log-sms
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
  const sms      = (body.sms      || "").trim();
  const category = (body.category || "personal").trim();
  const payMode  = (body.pay_mode || "").trim();

  if (!sms) {
    return new Response(JSON.stringify({ ok: false, error: "sms field required" }), { status: 400, headers: cors });
  }

  if (!isDebitSms(sms)) {
    return new Response(JSON.stringify({ ok: false, error: "Not a debit SMS — skipped", skipped: true }), { status: 422, headers: cors });
  }

  const amount = parseSmsAmount(sms);
  if (!amount) {
    return new Response(JSON.stringify({ ok: false, error: "Could not parse amount", sms }), { status: 422, headers: cors });
  }
  const note = parseSmsNote(sms);

  // Auto-detect payment mode from SMS if not provided
  const detectedPayMode = payMode || detectPayMode(sms);

  // Handle trip categories and fixed categories
  // Accept both IDs ("personal") and label strings ("👤 Personal", "Personal")
  let catId = "personal";
  let tripId = null;

  const catLower = category.toLowerCase().trim();
  if (catLower.startsWith("trip_")) {
    tripId = category.replace(/^trip_/i, "");
    catId = "trip";
  } else {
    // Map both ids and emoji-prefixed labels to internal ids
    const catMap = {
      "personal": "personal", "👤 personal": "personal",
      "work": "work", "💼 work": "work",
      "home": "home", "🏠 home": "home",
      "savings": "investment", "₹ savings": "investment",
      "investment": "investment", "₹ investment": "investment",
      "card": "personal", // fallback if "card" sent as category
    };
    catId = catMap[catLower] || "personal";

    // If it starts with a trip name (✈), look up by name
    if (catLower.startsWith("✈") || catLower.startsWith("✈️")) {
      const tripName = category.replace(/^✈️?\s*/u, "").trim();
      const { data: tripRow } = await supabase.from("trips")
        .select("id").eq("user_id", userId).ilike("name", tripName).maybeSingle();
      if (tripRow) { tripId = tripRow.id; catId = "trip"; }
    }
  }

  const expId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const { error } = await supabase.from("expenses").insert({
    id:       expId,
    user_id:  userId,
    amount,
    note,
    category: catId,
    pay_mode: detectedPayMode,
    date:     new Date().toISOString(),
    trip_id:  tripId,
  });

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: cors });
  }

  return new Response(JSON.stringify({ ok: true, amount, note, category: catId, pay_mode: detectedPayMode, trip_id: tripId, logged_for: userId }), { headers: cors });
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

/**
 * Returns false for messages that should NOT be logged as expenses.
 */
function isDebitSms(sms) {
  const s = sms.toLowerCase();

  if (/\botp\b/.test(s) || /one.time.pass/i.test(s) || /verification\s+code/i.test(s)) return false;
  if (/(?:transaction|payment)\s+(?:failed|declined|unsuccessful|not\s+processed)/i.test(sms)) return false;
  if (/available\s+balance/i.test(s) && !/debit|withdrawn|transferred|spent/i.test(s)) return false;
  if (/\bcredited\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/\brefund(?:ed)?\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/\brevers(?:al|ed)\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/money\s+received/i.test(s)) return false;

  return /debit(?:ed)?|withdrawn|withdrawal|\bsent\b|spent|paid|purchase[d]?|transfer(?:red)?\s+from|payment\s+of|\bemi\b/i.test(sms);
}

/**
 * Auto-detect payment mode from SMS content.
 * Returns "card", "upi", "cash", or "bank".
 */
function detectPayMode(sms) {
  const s = sms.toLowerCase();
  // Credit card indicators
  if (/credit\s+card|card\s+(?:ending|x|no\.?|number)|from\s+hdfc\s+bank\s+card|from\s+\w+\s+bank\s+card|card\s+x\d{4}/i.test(sms)) return "card";
  // ATM cash withdrawal
  if (/atm\s+(?:cash\s+)?withdrawal|withdrawn\s+at\s+atm/i.test(s)) return "cash";
  // UPI indicators
  if (/\bupi\b|vpa|@(?:okaxis|okhdfcbank|okicici|oksbi|ybl|apl|ibl|axl|paytm|fbl|timecosmos|waicici)/i.test(sms)) return "upi";
  // NEFT/IMPS/bank transfer
  if (/\bneft\b|\bimps\b|\brtgs\b/i.test(s)) return "bank";
  return "bank";
}

/**
 * Extracts the debit amount from Indian bank SMS messages.
 * Handles HDFC debit card, credit card, UPI, NEFT, IMPS, ATM, EMI, autopay.
 */
function parseSmsAmount(sms) {
  const patterns = [
    // "Spent Rs.6071" — HDFC credit card format
    /Spent\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "Rs.250.00" / "INR 1,000" — most common
    /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "debited with INR 500" / "debited for Rs.80"
    /debit(?:ed)?\s+(?:with|for|of)?\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "spent Rs.450" / "paid Rs.90 via"
    /(?:spent|paid(?:\s+via)?)\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "500.00 has been debited" / "1,250 debited"
    /([\d,]+(?:\.\d{1,2})?)\s*(?:INR\s*)?has\s+been\s+debited/i,
    /([\d,]+(?:\.\d{1,2})?)\s+(?:INR\s*)?debited\b/i,

    // "transaction of Rs.1500" / "purchase of INR 200"
    /(?:transaction|purchase)\s+of\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "INR 2000 transferred from" / "Rs.5000 withdrawn"
    /(?:INR|Rs\.?)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:transferred\s+from|withdrawn|debited)/i,

    // "payment of Rs.15000"
    /payment\s+of\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "withdrawn Rs.10000 at ATM"
    /withdrawn\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // EMI: "EMI of Rs.2500 due"
    /EMI\s+(?:of|amount)?\s+(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i,
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

/**
 * Extracts a short payee/merchant description from the SMS.
 */
function parseSmsNote(sms) {
  if (/ATM\s+(?:Cash\s+)?(?:withdrawal|withdraw)|withdrawn\s+at\s+ATM/i.test(sms)) return "ATM Withdrawal";

  if (/\bEMI\b/i.test(sms)) {
    const m = sms.match(/(?:loan|card|a\/c)\s+(?:no\.?\s+)?(?:XX)?(\w+)/i);
    return m ? `EMI — ${m[1].toUpperCase()}` : "EMI Payment";
  }

  if (/credit\s+card.*payment|payment.*toward.*credit\s+card/i.test(sms)) return "Credit Card Payment";
  if (/standing\s+instruction|auto.?debit|auto.?pay/i.test(sms)) return "Auto-debit";

  const patterns = [
    // HDFC credit card: "At MERCHANT On" — uppercase merchant after "At"
    /\bAt\s+([A-Z][A-Z0-9 &\-\.\/]{2,40}?)(?=\s+On\s|\s+Ref|\s+[0-9]{4}|[,.]|$)/,

    // UPI/NEFT payee: "to Mr VISHAL" or "to MERCHANT on"
    /\bto\s+([A-Za-z][A-Za-z0-9 &\-\.]{2,40}?)(?=\s+on\s|\s+via\s|\s+for\s+UPI|\s+Ref|\s+UPI|\s+A\/c|[,.]|$)/i,

    // Card swipe: "at AMAZON.IN on" or "at SWIGGY via"
    /\bat\s+([A-Za-z][A-Za-z0-9 &\-\.\/]{2,35}?)(?=\s+on\s|\s+via\s|\s+ref|\s+\d{2}|[,.]|$)/i,

    // VPA / UPI ID
    /(?:VPA|UPI\s*[:\-]?\s*)([A-Za-z0-9._-]+@[A-Za-z0-9]+)/i,

    // "toward LOAN / SUBSCRIPTION"
    /\btoward\s+([A-Za-z][A-Za-z0-9 &\-\.]{2,35}?)(?=\s+for|\s+of|\s+on|\s*$)/i,

    // Remarks / Narration
    /(?:Remarks|Narration|Description|Info)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 &\-\/\.]{2,35})/i,
  ];

  for (const pat of patterns) {
    const m = sms.match(pat);
    if (m) {
      const note = m[1].trim().replace(/\s+/g, " ");
      if (note.length >= 2 && !/^\d+$/.test(note)) return note.slice(0, 50);
    }
  }
  return "SMS expense";
}
