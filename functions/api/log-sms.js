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

  // Accept secret key in JSON body (most reliable for iOS Shortcuts)
  // Also accept Authorization header as fallback
  const bodyKey  = (body.key || "").trim();
  const authHdr  = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const token    = bodyKey || authHdr;

  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "No key provided" }), { status: 401, headers: cors });
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Look up which user owns this key (multi-user support)
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
  const category = (body.category || "personal").trim().toLowerCase();
  const payMode  = (body.pay_mode || "bank").trim();

  if (!sms) {
    return new Response(JSON.stringify({ ok: false, error: "sms field required" }), { status: 400, headers: cors });
  }

  // Skip non-expense messages (OTP, credit, balance, failed txn)
  if (!isDebitSms(sms)) {
    return new Response(JSON.stringify({ ok: false, error: "Not a debit SMS — skipped", skipped: true }), { status: 422, headers: cors });
  }

  const amount = parseSmsAmount(sms);
  if (!amount) {
    return new Response(JSON.stringify({ ok: false, error: "Could not parse amount", sms }), { status: 422, headers: cors });
  }
  const note = parseSmsNote(sms);

  // Handle trip categories (e.g. "trip_abc123") and fixed categories
  let catId = "personal";
  let tripId = null;

  if (category.startsWith("trip_")) {
    tripId = category.replace("trip_", "");
    catId = "trip";
  } else if (category.startsWith("custom_") || ["personal", "work", "home", "investment"].includes(category)) {
    catId = category;
  } else {
    const catMap = { savings: "investment" };
    catId = catMap[category] || "personal";
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

  return new Response(JSON.stringify({ ok: true, amount, note, category: catId, trip_id: tripId, logged_for: userId }), { headers: cors });
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
 * Returns false for messages that should NOT be logged as expenses:
 * OTPs, credit/refund SMSes, balance alerts, failed transactions.
 */
function isDebitSms(sms) {
  const s = sms.toLowerCase();

  // Skip OTP / 2FA messages
  if (/\botp\b/.test(s) || /one.time.pass/i.test(s) || /verification\s+code/i.test(s)) return false;

  // Skip "transaction failed" / "declined" messages
  if (/(?:transaction|payment|txn)\s+(?:failed|declined|unsuccessful|not\s+processed)/i.test(sms)) return false;

  // Skip balance alerts with no debit keyword
  if (/available\s+balance/i.test(s) && !/debit|withdrawn|transferred|sent|paid/i.test(s)) return false;
  if (/balance.*(?:is|:)\s*(?:rs|inr|₹)/i.test(s) && !/debit|withdrawn|transferred|sent|paid/i.test(s)) return false;

  // Skip promotional / informational messages
  if (/dear\s+customer.*(?:important|update|alert)|scheduled\s+maintenance|downtime/i.test(s)) return false;
  if (/reward\s*point|(?:get|earn|win)\s+cashback|limit\s*(?:increased|enhanced|revised)/i.test(s)) return false;
  if (/login\s+detected|security\s+alert|suspicious\s+(?:activity|login)/i.test(s)) return false;

  // Skip credit / refund / reversal messages (where money came IN)
  // Only skip if the primary action is credit — "debited and credited" is a transfer, not an expense
  if (/\bcredited\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/\brefund(?:ed)?\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/\brevers(?:al|ed)\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/money\s+received/i.test(s)) return false;

  // Must contain at least one debit-type keyword
  // Covers HDFC, SBI, ICICI, Axis, PNB, BOB, IDFC First, Yes Bank
  return /debit(?:ed)?|withdrawn|withdrawal|\bsent\b|spent|paid|purchase[d]?|transfer(?:red)?\s+from|payment\s+of|\bemi\b|\btxn\b|debited\s+by|money\s+sent|bill\s+payment|top.?up/i.test(sms);
}

/**
 * Extracts the debit amount from Indian bank SMS messages.
 * Handles HDFC (debit card, credit card, UPI, NEFT, IMPS, ATM, EMI, autopay).
 */
function parseSmsAmount(sms) {
  const patterns = [
    // "Rs.250.00" / "Rs 250" / "INR 1,000" / "₹500" — most common across all banks
    /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "debited with INR 500" / "debited for Rs.80" / "debited by Rs.200" (SBI/PNB)
    /debit(?:ed)?\s+(?:with|for|of|by)?\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "spent Rs.450" / "paid Rs.90 via"
    /(?:spent|paid(?:\s+via)?)\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "500.00 has been debited" / "1,250 debited"
    /([\d,]+(?:\.\d{1,2})?)\s*(?:INR\s*)?has\s+been\s+debited/i,
    /([\d,]+(?:\.\d{1,2})?)\s+(?:INR\s*)?debited\b/i,

    // "transaction of Rs.1500" / "purchase of INR 200" / "Txn of Rs.500" (ICICI/Axis)
    /(?:transaction|purchase|txn)\s+(?:of|for)\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "INR 2000 transferred from" / "Rs.5000 withdrawn"
    /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:transferred\s+from|withdrawn|debited)/i,

    // "payment of Rs.15000" (credit card bill, utility)
    /payment\s+of\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "withdrawn Rs.10000 at ATM"
    /withdrawn\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // EMI: "EMI of Rs.2500 due"
    /EMI\s+(?:of|amount)?\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "Rupees 500" / "Rupees 1,000.00" (some SBI/PNB formats)
    /Rupees?\s+([\d,]+(?:\.\d{1,2})?)/i,
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
 * Returns "SMS expense" if nothing parseable is found.
 */
function parseSmsNote(sms) {
  // ATM cash withdrawal
  if (/ATM\s+(?:Cash\s+)?(?:withdrawal|withdraw)|withdrawn\s+at\s+ATM/i.test(sms)) return "ATM Withdrawal";

  // EMI payment
  if (/\bEMI\b/i.test(sms)) {
    const m = sms.match(/(?:loan|card|a\/c)\s+(?:no\.?\s+)?(?:XX)?(\w+)/i);
    return m ? `EMI — ${m[1].toUpperCase()}` : "EMI Payment";
  }

  // UPI LITE top-up
  if (/UPI\s+LITE\s+top.?up/i.test(sms)) return "UPI LITE Top-up";

  // Credit card bill payment
  if (/credit\s+card.*payment|payment.*toward.*credit\s+card/i.test(sms)) return "Credit Card Payment";

  // Standing instruction / auto-debit
  if (/standing\s+instruction|auto.?debit|auto.?pay/i.test(sms)) return "Auto-debit";

  const patterns = [
    // UPI/NEFT payee: "to Mr VISHAL BHAGVATILAL JAI on"
    /\bto\s+([A-Za-z][A-Za-z0-9 &\-\.]{2,40}?)(?=\s+on\s|\s+via\s|\s+for\s+UPI|\s+Ref|\s+UPI|\s+A\/c|[,.]|$)/i,

    // Card swipe merchant: "at AMAZON.IN on" or "at SWIGGY via"
    /\bat\s+([A-Za-z][A-Za-z0-9 &\-\.\/]{2,35}?)(?=\s+on\s|\s+via\s|\s+ref|\s+\d{2}|[,.]|$)/i,

    // "Txn at MERCHANT" (ICICI, Axis style)
    /txn\s+at\s+([A-Za-z][A-Za-z0-9 &\-\.\/]{2,35}?)(?=\s+on|\s+ref|[,.]|$)/i,

    // VPA / UPI ID (e.g., merchant@upi)
    /(?:VPA|UPI\s*[:\-]?\s*)([A-Za-z0-9._-]+@[A-Za-z0-9]+)/i,

    // "toward(s) LOAN / SUBSCRIPTION" etc.
    /\btowards?\s+([A-Za-z][A-Za-z0-9 &\-\.]{2,35}?)(?=\s+for|\s+of|\s+on|\s*$)/i,

    // "to a/c XXXX1234 BENEFICIARY NAME" (SBI NEFT/IMPS)
    /to\s+a\/c\s+\w+\s+([A-Za-z][A-Za-z ]{2,35}?)(?=\s+on|\s+ref|[,.]|$)/i,

    // "Info: UPI/merchant/txnref" (SBI UPI format)
    /Info:\s*UPI\/([A-Za-z][A-Za-z0-9 &\-\.]{2,30})/i,

    // Remarks / Narration / Description fields (all banks)
    /(?:Remarks|Narration|Description|Info)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 &\-\/\.]{2,35})/i,
  ];

  for (const pat of patterns) {
    const m = sms.match(pat);
    if (m) {
      const note = m[1].trim().replace(/\s+/g, " ");
      // Skip pure-number results (account numbers, references)
      if (note.length >= 2 && !/^\d+$/.test(note)) return note.slice(0, 50);
    }
  }
  return "SMS expense";
}
