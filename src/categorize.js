// Grouping + suggestion logic for the Categorize sheet. Pure functions, no I/O — the
// sheet in App.jsx renders the result and writes the user's choice.
//
// Suggestions only PRE-SELECT a category chip; nothing is applied without a tap. Every
// signal comes from the signed-in user's own expenses (plus static brand rules), never
// from other users' data. Category ids mean different things per user, so ids are only
// ever taken from this user's own history or resolved by label (brandCategory).

import { brandCategory } from "../functions/api/_brandRules.js";

// Notes that carry no payee information — parseSmsNote's fallbacks, plus HDFC's "At NA".
const NO_PAYEE_NOTES = new Set(["", "sms expense", "na", "auto-debit"]);

// The grouping key for an expense's payee, or null when the note says nothing useful.
// A VPA-style first token is the payee even when the user appended words after it
// ("Q317656410@ybl office lunch"). HDFC masked payees ("*zxgs@pty") keep only the visible
// suffix, flagged so matching can compare by suffix instead of exact equality.
export function payeeKey(note) {
  const normalized = (note || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (NO_PAYEE_NOTES.has(normalized)) return null;
  const firstToken = normalized.split(" ")[0];
  if (firstToken.includes("@")) {
    const masked = firstToken.startsWith("*");
    const key = firstToken.replace(/^\*+/, "");
    // "*@ybl" / "@pty" carry only the UPI handle, shared by unrelated payees.
    if (key.startsWith("@")) return null;
    return { key, masked };
  }
  // A note of only asterisks (fully masked payee) says nothing about who was paid.
  if (/^\*+$/.test(normalized)) return null;
  return { key: normalized, masked: false };
}

// Two payee keys refer to the same payee. A masked key is a suffix of the full VPA, so
// "zxgs@pty" matches "paytm.s2uzxgs@pty". Suffix needs >=4 chars before "@", same guard
// as log-sms.js, so a short suffix can't collide with unrelated payees on one handle.
function samePayee(a, b) {
  if (a.key === b.key) return true;
  const maskedSide = a.masked ? a : b.masked ? b : null;
  if (!maskedSide) return false;
  const other = maskedSide === a ? b : a;
  const localPart = maskedSide.key.split("@")[0].replace(/[^a-z0-9]/g, "");
  return localPart.length >= 4 && other.key.endsWith(maskedSide.key);
}

const median = (nums) => {
  const s = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const hourOf = (d) => new Date(d).getHours();

// Groups uncategorized expenses by payee. Expenses with no payee info each get their own
// group so they can still be filed one at a time. Sorted so the groups that clear the
// most rows per tap come first.
// The group a payee belongs in, or null. A full VPA only joins its exact match or a
// masked-only group with the same suffix. A masked payee joins by suffix, but only when
// exactly one group fits — if two different full VPAs share the visible suffix, it's
// ambiguous and stays on its own rather than being filed with the wrong payee.
function findPayeeGroup(groups, payee) {
  const candidates = groups.filter(g => g.payee && samePayee(g.payee, payee));
  if (!payee.masked) {
    return candidates.find(g => g.payee.key === payee.key)
      || candidates.find(g => g.payee.masked)
      || null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

export function groupUncategorized(exps) {
  const groups = [];
  const uncategorized = exps.filter(e => e.category === "uncategorized" && !e.tripId);
  for (const exp of uncategorized) {
    const payee = payeeKey(exp.note);
    const existing = payee ? findPayeeGroup(groups, payee) : null;
    if (existing) {
      existing.items.push(exp);
      // A masked-only group adopts the first full VPA it meets, so a second, different
      // full VPA with the same visible suffix can't also join it through the mask.
      if (existing.payee.masked && !payee.masked) existing.payee = payee;
    } else {
      groups.push({ id: payee ? `p:${payee.key}` : `e:${exp.id}`, payee, items: [exp] });
    }
  }
  for (const g of groups) {
    g.items.sort((a, b) => new Date(b.date) - new Date(a.date));
    g.label = g.payee ? (g.items[0].note || "").trim() : "No payee info";
    g.total = g.items.reduce((s, e) => s + e.amount, 0);
    g.medianAmount = median(g.items.map(e => e.amount));
    g.typicalHour = Math.round(median(g.items.map(e => hourOf(e.date))));
  }
  groups.sort((a, b) => b.items.length - a.items.length || b.total - a.total);
  return groups;
}

// The user's categorized, non-trip expenses with payee keys precomputed once, so
// suggestCategory doesn't re-parse every note for every group. Keeps the caller's order
// (App state is newest-first), which topCategory relies on for tie-breaks.
export function prepareHistory(exps) {
  return exps
    .filter(e => e.category !== "uncategorized" && e.category !== "trip" && !e.tripId)
    .map(e => ({ ...e, payee: payeeKey(e.note) }));
}

// Most common category among rows, with its share. Ties go to the most recent row,
// since rows are passed newest-first.
function topCategory(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) || 0) + 1);
  let best = null;
  for (const r of rows) {
    const n = counts.get(r.category);
    if (!best || n > best.count) best = { catId: r.category, count: n };
  }
  return best ? { ...best, share: best.count / rows.length } : null;
}

const withinRatio = (a, b, ratio) => Math.abs(a - b) <= ratio * Math.max(a, b);

const formatHour = (h) => {
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${suffix}`;
};

// Suggests a category for a group, or null. Signals in order of strength:
//   1. Same payee in the user's history — prefer past payments of a similar amount, so a
//      payee used for both ₹80 coffee and ₹2,000 rent resolves by amount.
//   2. Well-known brand, resolved to the user's own category by label.
//   3. The user's own habit: past payments of the same amount, same pay mode, around the
//      same hour (>=3 such payments, >=80% agreeing) — catches new opaque QR ids for a
//      routine like the morning ₹80.
// `history` comes from prepareHistory; `cats` are the visible categories the sheet offers.
// Back-tested 2026-10-20 the same way as the habit signal below: the same-payee signal
// was right 87% of the time.
export function suggestCategory(group, history, cats) {
  const validIds = new Set(cats.map(c => c.id));
  const usable = history.filter(e => validIds.has(e.category));

  if (group.payee) {
    const samePayeeRows = usable.filter(e => e.payee && samePayee(e.payee, group.payee));
    if (samePayeeRows.length > 0) {
      const similarAmount = samePayeeRows.filter(e => withinRatio(e.amount, group.medianAmount, 0.25));
      const basis = similarAmount.length > 0 ? similarAmount : samePayeeRows;
      const top = topCategory(basis);
      if (top && top.share >= 0.5) {
        const payments = top.count === 1 ? "1 earlier payment" : `${top.count} earlier payments`;
        return { catId: top.catId, reason: `Same payee as ${payments}` };
      }
    }

    const brandCatId = brandCategory(group.items[0].note, cats);
    if (brandCatId && validIds.has(brandCatId)) {
      return { catId: brandCatId, reason: "Known merchant" };
    }
  }

  // Thresholds back-tested on real history (2026-10-20, each categorized row of the last
  // 120 days predicted from that user's earlier rows): exact amount + same pay mode +
  // ±1h + >=3 rows at >=80% agreement was right 89% of the time. Looser variants
  // (±20% amount, any mode, 60%) dropped to 57%, too weak to pre-select.
  const sixMonthsAgo = Date.now() - 183 * 864e5;
  const groupPayMode = group.items[0].payMode;
  const habitRows = usable.filter(e =>
    new Date(e.date).getTime() >= sixMonthsAgo &&
    e.amount === group.medianAmount &&
    e.payMode === groupPayMode &&
    Math.abs(hourOf(e.date) - group.typicalHour) <= 1
  );
  if (habitRows.length >= 3) {
    const top = topCategory(habitRows);
    if (top && top.share >= 0.8) {
      const amount = Math.round(group.medianAmount).toLocaleString("en-IN");
      return { catId: top.catId, reason: `Your usual ₹${amount} around ${formatHour(group.typicalHour)}` };
    }
  }

  return null;
}
