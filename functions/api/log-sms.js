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
  const category = (body.category || "personal").trim().toLowerCase();
  let   payMode  = (body.pay_mode || "").trim();

  if (!sms) {
    return new Response(JSON.stringify({ ok: false, error: "sms field required" }), { status: 400, headers: cors });
  }

  // Step 1: Identify bank from SMS
  const bank = identifyBank(sms);

  // Step 2: Check if this is a debit SMS
  if (!isDebitSms(sms)) {
    return new Response(JSON.stringify({ ok: false, error: "Not a debit SMS — skipped", skipped: true }), { status: 422, headers: cors });
  }

  // Step 3: Auto-detect payment mode type (card/bank/cash)
  const payType = detectPayMode(sms, bank);

  // Step 3b: Match to user's configured banks (or auto-create one)
  if (!payMode || payMode === "bank" || payMode === "card") {
    // Load user's bank config to match
    const { data: prefsRow } = await supabase
      .from("user_prefs")
      .select("banks_json")
      .eq("user_id", userId)
      .maybeSingle();

    let userBanks = [];
    if (prefsRow?.banks_json) {
      try { userBanks = JSON.parse(prefsRow.banks_json); } catch {}
    }

    // Extract last4 from SMS for matching
    const last4Match = sms.match(/(?:XX?|xx?|ending|x{1,2})(\d{4})/);
    const smsLast4 = last4Match ? last4Match[1] : null;

    const bankNames = {
      hdfc: "HDFC", icici: "ICICI", sbi: "SBI", axis: "Axis",
      kotak: "Kotak", indusind: "IndusInd", idfc: "IDFC", yes: "Yes Bank",
      pnb: "PNB", bob: "BOB", federal: "Federal", canara: "Canara",
      union: "Union", boi: "BOI",
    };
    const bankPatterns = {
      hdfc: /hdfc/i, icici: /icici/i, sbi: /sbi|state\s*bank/i, axis: /axis/i,
      kotak: /kotak/i, indusind: /indus/i, idfc: /idfc/i, yes: /yes\s*bank/i,
      pnb: /pnb|punjab/i, bob: /baroda|bob/i, federal: /federal/i,
      canara: /canara/i, union: /union/i, boi: /bank\s*of\s*india/i,
    };

    let matched = null;

    if (userBanks.length > 0) {
      // Try matching by last4 digits first
      if (smsLast4) {
        matched = userBanks.find(b => b.last4 === smsLast4);
      }
      // Fallback: match by bank name in label
      if (!matched && bank !== "unknown") {
        const bankPat = bankPatterns[bank];
        if (bankPat) {
          const candidates = userBanks.filter(b => bankPat.test(b.label));
          if (payType === "card") {
            matched = candidates.find(b => b.type === "credit_card") || candidates[0];
          } else {
            matched = candidates.find(b => b.type === "bank") || candidates[0];
          }
        }
      }
    }

    if (matched) {
      payMode = matched.id;
    } else if (bank !== "unknown" && payType !== "cash") {
      // Auto-create a bank entry from SMS info
      const newBankId = "bnk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
      const label = bankNames[bank] || bank.charAt(0).toUpperCase() + bank.slice(1);
      const newBank = { id: newBankId, label, type: payType === "card" ? "credit_card" : "bank", last4: smsLast4 || "" };
      const updatedBanks = [...userBanks, newBank];
      // Save to user_prefs (fire-and-forget, don't block the response)
      supabase.from("user_prefs").upsert({ user_id: userId, banks_json: JSON.stringify(updatedBanks) }).then(() => {});
      payMode = newBankId;
    } else {
      payMode = payType;
    }
  }

  // Step 4: Strip balance info to avoid confusing amount parser
  const cleanedSms = stripBalance(sms);

  // Step 5: Parse amount (bank-aware)
  const amount = parseSmsAmount(cleanedSms, bank);
  if (!amount) {
    return new Response(JSON.stringify({ ok: false, error: "Could not parse amount", sms, bank }), { status: 422, headers: cors });
  }

  // Step 6: Parse merchant/note (bank-aware)
  const note = parseSmsNote(sms, bank);

  // Load user's categories from prefs for dynamic label→id mapping
  const { data: prefsData } = await supabase
    .from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle();

  let userCats = [
    { id: "personal",   label: "Personal", icon: "👤" },
    { id: "work",       label: "Work",     icon: "💼" },
    { id: "home",       label: "Home",     icon: "🏠" },
    { id: "investment", label: "Savings",  icon: "₹"  },
  ];
  if (prefsData?.cats_json) {
    try {
      const parsed = JSON.parse(prefsData.cats_json);
      if (Array.isArray(parsed) && parsed.length > 0) userCats = parsed;
    } catch {}
  }

  // Handle trip categories and fixed categories
  // Accept IDs ("personal"), label strings ("Groceries"), or emoji+label ("🛒 Groceries")
  let catId = userCats[0]?.id || "personal";
  let tripId = null;

  const catLower = category.toLowerCase().trim();
  if (catLower.startsWith("trip_")) {
    tripId = category.replace(/^trip_/i, "");
    catId = "trip";
  } else if (catLower.startsWith("✈") || catLower.startsWith("✈️")) {
    // Trip by display name (e.g. "✈️ Goa Trip")
    const tripName = category.replace(/^✈️?\s*/u, "").trim();
    const { data: tripRow } = await supabase.from("trips")
      .select("id").eq("user_id", userId).ilike("name", tripName).maybeSingle();
    if (tripRow) { tripId = tripRow.id; catId = "trip"; }
  } else {
    // Build dynamic map: id → id, label → id, and "icon label" → id for all user cats
    const catMap = {};
    userCats.forEach(c => {
      catMap[c.id.toLowerCase()] = c.id;
      catMap[c.label.toLowerCase()] = c.id;
      if (c.icon) catMap[`${c.icon} ${c.label}`.toLowerCase()] = c.id;
    });
    // Always allow savings/investment alias
    const invCat = userCats.find(c => c.id === "investment");
    if (invCat) { catMap["savings"] = "investment"; catMap["investment"] = "investment"; }

    catId = catMap[catLower] || userCats[0]?.id || "personal";
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

  return new Response(JSON.stringify({ ok: true, amount, note, category: catId, trip_id: tripId, bank, pay_mode: payMode, logged_for: userId }), { headers: cors });
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 1: Bank identification — done first so all subsequent parsing is aware
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function identifyBank(sms) {
  // Order matters: more specific names first to avoid false matches
  if (/indusind/i.test(sms))                           return "indusind";
  if (/idfc\s*first/i.test(sms))                       return "idfc";
  if (/hdfc\s*bank|hdfcbk/i.test(sms))                return "hdfc";
  if (/icici/i.test(sms))                              return "icici";
  if (/axis\s*bank/i.test(sms))                        return "axis";
  if (/kotak/i.test(sms))                              return "kotak";
  if (/yes\s*bank/i.test(sms))                         return "yes";
  if (/\bsbi\b|state\s*bank/i.test(sms))              return "sbi";
  if (/\bpnb\b|punjab\s*national/i.test(sms))         return "pnb";
  if (/\bbob\b|bank\s*of\s*baroda/i.test(sms))        return "bob";
  if (/federal\s*bank/i.test(sms))                     return "federal";
  if (/canara/i.test(sms))                             return "canara";
  if (/union\s*bank/i.test(sms))                       return "union";
  if (/bank\s*of\s*india\b/i.test(sms))               return "boi";
  return "unknown";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 2: Debit SMS check — reject OTPs, credits, promos, balance-only alerts
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function isDebitSms(sms) {
  const s = sms.toLowerCase();

  // Skip OTP / 2FA messages
  if (/\botp\b/.test(s) || /one.time.pass/i.test(s) || /verification\s+code/i.test(s)) return false;

  // Skip "transaction failed" / "declined" messages
  if (/(?:transaction|payment|txn)\s+(?:failed|declined|unsuccessful|not\s+processed)/i.test(sms)) return false;

  // Skip balance alerts with no debit keyword
  if (/available\s+balance/i.test(s) && !/debit|withdrawn|transferred|sent|paid|spent/i.test(s)) return false;
  if (/balance.*(?:is|:)\s*(?:rs|inr|₹)/i.test(s) && !/debit|withdrawn|transferred|sent|paid|spent/i.test(s)) return false;

  // Skip promotional / informational messages
  if (/dear\s+customer.*(?:important|update|alert)|scheduled\s+maintenance|downtime/i.test(s)) return false;
  if (/reward\s*point|(?:get|earn|win)\s+cashback|limit\s*(?:increased|enhanced|revised)/i.test(s)) return false;
  if (/login\s+detected|security\s+alert|suspicious\s+(?:activity|login)/i.test(s)) return false;

  // Skip credit / refund / reversal messages (where money came IN)
  if (/\bcredited\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/\brefund(?:ed)?\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/\brevers(?:al|ed)\b/.test(s) && !/debit(?:ed)?/i.test(s)) return false;
  if (/money\s+received/i.test(s)) return false;

  // Must contain at least one debit-type keyword
  return /debit(?:ed)?|withdrawn|withdrawal|\bsent\b|spent|paid|purchase[d]?|transfer(?:red)?\s+from|payment\s+of|\bemi\b|\btxn\b|debited\s+by|money\s+sent|bill\s+payment|top.?up|\bcharged\b|card\s+(?:has\s+been\s+)?used/i.test(sms);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 3: Payment mode detection — bank-aware
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function detectPayMode(sms, bank) {
  // Credit card patterns (bank-specific + generic)
  if (/credit\s+card/i.test(sms)) return "card";
  if (/(?:indusind|hdfc|icici|axis|sbi|idfc|kotak|yes)\s+(?:bank\s+)?card\s+(?:x|xx|ending)/i.test(sms)) return "card";
  if (/\bcard\s+(?:x|xx)\d{4}\b/i.test(sms)) return "card";
  if (/(?:spent|charged).*\bcard\b/i.test(sms)) return "card";
  if (/\bAvl\s+Lmt\b/i.test(sms)) return "card"; // "Available Limit" = credit card

  // ATM
  if (/atm\s+(?:cash\s+)?withdraw|cash\s+withdrawal|withdrawn\s+at\s+atm/i.test(sms)) return "cash";

  return "bank";
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Strip balance/limit info from SMS to prevent the amount parser from
// picking up the wrong number. Runs BEFORE amount parsing.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function stripBalance(sms) {
  return sms
    // "Avl Lmt: INR 85,049.61" / "Avl Bal: Rs.10000" / "Available Balance: ₹5000"
    .replace(/(?:Avl|Available)\s*(?:Bal|Lmt|Limit|Balance)?[:\s]*(?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d{1,2})?/gi, "")
    // "Bal Rs.25583.12" / "Bal: INR 1000" / "Balance INR 10000"
    .replace(/\bBal(?:ance)?[:\s]*(?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d{1,2})?/gi, "")
    // "Remaining Limit: Rs.50000"
    .replace(/(?:Remaining|Outstanding)\s*(?:Limit|Balance|Amt)?[:\s]*(?:Rs\.?|INR|₹)\s*[\d,]+(?:\.\d{1,2})?/gi, "")
    .trim();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 5: Amount parser — tries bank-specific patterns first, then generic
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseSmsAmount(sms, bank) {
  // Bank-specific patterns (tried first for higher accuracy)
  const bankPatterns = {
    indusind: [
      // "INR 200.00 spent on IndusInd Card XX4826"
      /INR\s*([\d,]+(?:\.\d{1,2})?)\s+spent/i,
      // "Rs.500 debited from A/c"
      /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+debited/i,
    ],
    hdfc: [
      // "Spent Rs.6071 From HDFC Bank Card x8812 At MERCHANT"
      /Spent\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
      // "Rs.500.00 debited from A/c XX1234"
      /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+debited/i,
      // "UPI LITE Top-up amounting to Rs.700.00"
      /amounting\s+to\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ],
    icici: [
      // "Txn of Rs.500 on your Card/Acct"
      /Txn\s+of\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
      // "Rs.500 debited from Acct"
      /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+debited/i,
    ],
    sbi: [
      // "debited by Rs.500.00"
      /debited\s+by\s+(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i,
      // "Rs.500 transferred from your A/c"
      /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)\s+transferred/i,
    ],
    axis: [
      // "Rs.500 was debited from your Axis Bank A/c"
      /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:was\s+)?debited/i,
      // "Spent Rs.500 on Card"
      /Spent\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ],
    idfc: [
      // "Rs.500 debited from your IDFC FIRST Bank A/c"
      /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+debited/i,
      // "INR 500 spent on IDFC FIRST Bank Card"
      /INR\s*([\d,]+(?:\.\d{1,2})?)\s+spent/i,
      /Spent\s+(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i,
    ],
    kotak: [
      // "Sent Rs.70.00 from Kotak Bank AC X3082"
      /Sent\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+from/i,
      /Rs\.?\s*([\d,]+(?:\.\d{1,2})?)\s+(?:was\s+)?debited/i,
      /Spent\s+Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i,
    ],
  };

  // Try bank-specific patterns first
  const bpats = bankPatterns[bank];
  if (bpats) {
    for (const pat of bpats) {
      const m = sms.match(pat);
      if (m) {
        const val = parseFloat(m[1].replace(/,/g, ""));
        if (val > 0 && val < 10_000_000) return Math.round(val);
      }
    }
  }

  // Generic patterns (fallback for unknown banks or unmatched formats)
  const genericPatterns = [
    // "Rs.250.00" / "Rs 250" / "INR 1,000" / "₹500"
    /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "debited with/for/of/by Rs.500"
    /debit(?:ed)?\s+(?:with|for|of|by)?\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "spent Rs.450" / "paid Rs.90"
    /(?:spent|paid(?:\s+via)?)\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "500.00 has been debited" / "1,250 debited"
    /([\d,]+(?:\.\d{1,2})?)\s*(?:INR\s*)?has\s+been\s+debited/i,
    /([\d,]+(?:\.\d{1,2})?)\s+(?:INR\s*)?debited\b/i,

    // "transaction/purchase/txn of Rs.500"
    /(?:transaction|purchase|txn)\s+(?:of|for)\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "INR 2000 transferred from" / "Rs.5000 withdrawn"
    /(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)\s+(?:transferred\s+from|withdrawn|debited)/i,

    // "payment of Rs.15000"
    /payment\s+of\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "withdrawn Rs.10000"
    /withdrawn\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "EMI of Rs.2500"
    /EMI\s+(?:of|amount)?\s+(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i,

    // "Rupees 500"
    /Rupees?\s+([\d,]+(?:\.\d{1,2})?)/i,
  ];

  for (const pat of genericPatterns) {
    const m = sms.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ""));
      if (val > 0 && val < 10_000_000) return Math.round(val);
    }
  }
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STEP 6: Note/merchant parser — bank-aware extraction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseSmsNote(sms, bank) {
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

  // ── Bank-specific note extraction ──
  let extracted = null;

  if (bank === "indusind") {
    // "INR 200.00 spent on IndusInd Card XX4826 on DATE at UPI AUNSH PETROLEUM. Avl Lmt..."
    // "at" comes AFTER the date for IndusInd
    const m = sms.match(/\bat\s+(?:UPI\s+)?([A-Za-z][A-Za-z0-9 &\-\.\/]{2,40}?)(?=\.\s*Avl|\.\s*Not|\.\s*To\s+dispute|[.]?\s*$)/i);
    if (m) extracted = m[1].trim();
  }

  if (bank === "hdfc" && !extracted) {
    // "Spent Rs.6071 From HDFC Bank Card x8812 At COUNCIL OF ARCHITECTUR On DATE"
    const m = sms.match(/\bAt\s+([A-Za-z][A-Za-z0-9 &\-\.\/]{2,40}?)\s+On\s+\d/i);
    if (m) extracted = m[1].trim();
    if (!extracted) {
      // "to Mr NAME on" / "to NAME via UPI"
      const m2 = sms.match(/\bto\s+(?:Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?([A-Za-z][A-Za-z0-9 &\-\.]{2,40}?)(?=\s+on\s|\s+via\s|\s+Ref|\s*$)/i);
      if (m2) extracted = m2[1].trim();
    }
  }

  if (bank === "icici" && !extracted) {
    const m = sms.match(/\bat\s+([A-Za-z][A-Za-z0-9 &\-\.\/]{2,35}?)(?=\s+on|\s+ref|[,.]|$)/i);
    if (m) extracted = m[1].trim();
  }

  if (bank === "kotak" && !extracted) {
    // "Sent Rs.70.00 from Kotak Bank AC X3082 to bharatpe.8a0p0v7t7h42223@fbpe on 07-03-26.UPI Ref..."
    // Extract UPI ID or payee after "to"
    const m = sms.match(/\bto\s+([A-Za-z0-9._\-]+@[A-Za-z0-9]+)\s+on\b/i);
    if (m) {
      // Try to extract readable name from UPI ID (before the @)
      const upiName = m[1].split("@")[0].replace(/[0-9._\-]+$/g, "").replace(/\./g, " ").trim();
      extracted = upiName.length >= 2 ? upiName : m[1];
    }
    if (!extracted) {
      const m2 = sms.match(/\bto\s+([A-Za-z][A-Za-z0-9 &\-\.]{2,40}?)\s+on\b/i);
      if (m2) extracted = m2[1].trim();
    }
  }

  if (bank === "sbi" && !extracted) {
    // "Info: UPI/MERCHANT/txnref"
    const m = sms.match(/Info:\s*UPI\/([A-Za-z][A-Za-z0-9 &\-\.]{2,30})/i);
    if (m) extracted = m[1].trim();
    if (!extracted) {
      const m2 = sms.match(/to\s+a\/c\s+\w+\s+([A-Za-z][A-Za-z ]{2,35}?)(?=\s+on|\s+ref|[,.]|$)/i);
      if (m2) extracted = m2[1].trim();
    }
  }

  if (extracted) {
    // Clean up: remove "UPI " prefix, trailing junk
    extracted = extracted.replace(/^UPI\s+/i, "").replace(/\s+/g, " ").trim();
    if (extracted.length >= 2 && !/^\d+$/.test(extracted)) return extracted.slice(0, 50);
  }

  // ── Generic note patterns (fallback for all banks) ──
  const patterns = [
    // UPI/NEFT payee: "to Mr NAME on"
    /\bto\s+(?:Mr\.?\s+|Mrs\.?\s+|Ms\.?\s+)?([A-Za-z][A-Za-z0-9 &\-\.]{2,40}?)(?=\s+on\s|\s+via\s|\s+for\s+UPI|\s+Ref|\s+UPI|\s+A\/c|[,.]|$)/i,

    // Card swipe merchant: "at AMAZON.IN on" or "at SWIGGY via"
    /\bat\s+(?:UPI\s+)?([A-Za-z][A-Za-z0-9 &\-\.\/]{2,35}?)(?=\s+on\s|\s+via\s|\s+ref|\s+\d{2}|[,.]|$)/i,

    // "Txn at MERCHANT"
    /txn\s+at\s+(?:UPI\s+)?([A-Za-z][A-Za-z0-9 &\-\.\/]{2,35}?)(?=\s+on|\s+ref|[,.]|$)/i,

    // VPA / UPI ID
    /(?:VPA|UPI\s*[:\-]?\s*)([A-Za-z0-9._-]+@[A-Za-z0-9]+)/i,

    // "toward(s) LOAN / SUBSCRIPTION"
    /\btowards?\s+([A-Za-z][A-Za-z0-9 &\-\.]{2,35}?)(?=\s+for|\s+of|\s+on|\s*$)/i,

    // "to a/c XXXX BENEFICIARY"
    /to\s+a\/c\s+\w+\s+([A-Za-z][A-Za-z ]{2,35}?)(?=\s+on|\s+ref|[,.]|$)/i,

    // "Info: UPI/merchant/txnref"
    /Info:\s*UPI\/([A-Za-z][A-Za-z0-9 &\-\.]{2,30})/i,

    // Remarks / Narration / Description
    /(?:Remarks|Narration|Description|Info)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 &\-\/\.]{2,35})/i,
  ];

  for (const pat of patterns) {
    const m = sms.match(pat);
    if (m) {
      let note = m[1].trim().replace(/^UPI\s+/i, "").replace(/\s+/g, " ");
      if (note.length >= 2 && !/^\d+$/.test(note)) return note.slice(0, 50);
    }
  }
  return "SMS expense";
}
