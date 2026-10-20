// Brand → category rules shared by the Worker (log-sms.js "auto" path) and the SPA
// (Categorize sheet suggestions). NOT a route — no onRequest* exports, not registered in
// src/worker.js's API_ROUTES. Pure functions, no I/O.
//
// Brand → category fallback for the "auto" path, used only when the user has no history
// for the payee. Rules resolve to the user's own category by LABEL, never by id: ids mean
// different things per user (OLD defaults reuse "personal"/"home" for Food/Travel etc.,
// NEW defaults use "food"/"travel"). If no visible label matches, the expense stays
// uncategorized rather than guessing. Order matters: groceries runs before food so
// "swiggyinstamart" / "jiomart" don't land in Food or Utility.
export const BRAND_RULES = [
  { brands: /instamart|blinkit|zepto|bigbasket|dmart|jiomart|grofers|swiggymart/i, labelWord: /^(grocery|groceries|grocer|kirana|કરિયાણા|કરિયાણું|किराना)$/u },
  { brands: /swiggy|zomato|eatsure|dominos|mcdonald|kfc|starbucks|chaayos|bikanervala|haldiram/i, labelWord: /^(food|eating|eat|dining|restaurants?|meals?|lunch|dinner|breakfast|ખાવાનું|ભોજન|खाना|भोजन)$/u },
  // Fuel before cabs: a "Petrol" category should catch fuel stations but never Uber/Ola.
  // Brand patterns are deliberately narrow (goindigo not indigo, dmrc not metro, \binox\b)
  // because a wrong auto-match skips the Shortcut prompt and the uncategorized queue.
  { brands: /petrol|\bfuel\b|hpcl|bpcl|iocl|indianoil|fastag/i, labelWord: /^(petrol|fuel|travel|transport|transportation|commute|પરિવહન|મુસાફરી|यात्रा)$/u },
  { brands: /\buber|rapido|\bola\b|olacabs|irctc|goindigo|interglobe|makemytrip|redbus|\bdmrc|delhimetro|bmrcl/i, labelWord: /^(travel|transport|transportation|commute|cabs?|પરિવહન|મુસાફરી|यात्रा)$/u },
  { brands: /amazon|amzn|flipkart|myntra|ajio|meesho|nykaa/i, labelWord: /^(shopping|shoppin)$/u },
  { brands: /pharmacy|apollo ?pharm|apollo24|1mg|netmeds|medkart|medplus/i, labelWord: /^(health|healthcare|medical|medicines?|pharmacy|દવા|दवा)$/u },
  { brands: /netflix|spotify|hotstar|bookmyshow|\bpvr\b|\binox\b|sortmyscene/i, labelWord: /^(entertainment|fun|movies?|મજા|મનોરંજન|मनोरंजन)$/u },
  { brands: /airtel|\bjio\b|vodafone|bsnl|bescom|electricity|tatapower|adanielec/i, labelWord: /^(utility|utilities|bills?|recharges?|બિલ|बिल)$/u },
];

export function brandCategory(note, userCats) {
  if (!note) return null;
  // Test brands against the payee only, not the UPI handle: "@airtel" (Airtel Payments
  // Bank) and "@jio" are handles on ordinary person-to-person VPAs like "ravi@airtel",
  // which would otherwise all land in Utility.
  const payee = note.replace(/@[a-z0-9.-]+/gi, " ");
  const rule = BRAND_RULES.find(r => r.brands.test(payee));
  if (!rule) return null;
  // Whole-word label match (emoji/punctuation stripped) — a substring match would put
  // food brands into "Health" because "health" contains "eat". Split on anything that
  // isn't a letter or combining mark so Gujarati/Hindi labels survive intact.
  const labelWords = c => (c.label || "").toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  const match = userCats.find(c =>
    !c.hidden &&
    c.id !== "investment" &&
    c.id !== "uncategorized" &&
    labelWords(c).some(w => rule.labelWord.test(w))
  );
  return match ? match.id : null;
}
