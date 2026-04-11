import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase, dbToExp, dbToTrip, expToDb, tripToDb } from "./supabase";
import { useAuth } from "./AuthContext";
import Auth, { PasswordReset } from "./Auth";

// Categories for users who signed up before the new defaults
const OLD_DEFAULT_CATEGORIES = [
  { id: "personal",   label: "Personal", icon: "👤" },
  { id: "work",       label: "Work",     icon: "💼" },
  { id: "home",       label: "Home",     icon: "🏠" },
  { id: "investment", label: "Savings",  icon: "₹" },
];
// Categories for brand-new users
const NEW_DEFAULT_CATEGORIES = [
  { id: "groceries",  label: "Groceries",     icon: "🛒" },
  { id: "food",       label: "Food",          icon: "🍔" },
  { id: "travel",     label: "Travel",        icon: "✈️" },
  { id: "entertain",  label: "Entertainment", icon: "🎬" },
  { id: "personal",   label: "Personal Care", icon: "💄" },
  { id: "others",     label: "Others",        icon: "📦" },
  { id: "investment", label: "Savings",       icon: "₹"  },
];
// Alias used by the cat modal Reset button
const DEFAULT_CATEGORIES = OLD_DEFAULT_CATEGORIES;
// System sentinel for uncategorized expenses (not in user's cats, not shown in Add form)
const UNCAT = { id: "uncategorized", label: "No Category", icon: "—" };
// iCloud Shortcut links — update after sharing/re-sharing
const SHORTCUT_ICLOUD_URL = "https://www.icloud.com/shortcuts/4dbf6ffb530347beb3c13f0969304d60"; // Bank/SMS expense
const CASH_SHORTCUT_URL   = "https://www.icloud.com/shortcuts/de22d5366b2a44c18bfe327c6387d0bf"; // Manual cash expense

const formatINR = (n) => {
  if (n == null || n === "") return "\u20B90";
  const v = Math.round(Number(n));
  if (isNaN(v)) return "\u20B90";
  const neg = v < 0;
  const a = Math.abs(v).toString();
  if (a.length <= 3) return (neg ? "-\u20B9" : "\u20B9") + a;
  let l3 = a.slice(-3), r = a.slice(0, -3), f = "";
  while (r.length > 2) { f = "," + r.slice(-2) + f; r = r.slice(0, -2); }
  return (neg ? "-\u20B9" : "\u20B9") + r + f + "," + l3;
};

const tds = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const tts = (d) => new Date(d).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
const tfd = (d) => new Date(d).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
const isToday = (d) => sameDay(d, new Date());
const isYest = (d) => { const y = new Date(); y.setDate(y.getDate() - 1); return sameDay(d, y); };
const dayLbl = (d) => isToday(d) ? "Today" : isYest(d) ? "Yesterday" : tds(d);
const dSince = (d) => (Date.now() - new Date(d).getTime()) / 864e5;
const hSince = (d) => (Date.now() - new Date(d).getTime()) / 36e5;
const hap = () => { try { navigator.vibrate?.(6); } catch {} };
const hasGujarati = (s) => /[\u0A80-\u0AFF]/.test(s);
const gujStyle = (s, base = 16) => hasGujarati(s) ? { fontFamily: "'Noto Sans Gujarati', sans-serif", fontSize: Math.round(base * 1.2) } : {};
const CAT_COLOR_PALETTE = ["#FF3B30", "#007AFF", "#34C759", "#FF9500", "#AF52DE", "#00C7BE", "#FF2D55", "#FFCC00", "#5856D6", "#FF6B35", "#30D158", "#6AC4DC"];

const G = {
  bg: "#FFF", bg2: "#F5F5F5", bg3: "#EBEBEB", bdr: "#D4D4D4",
  t1: "#111", t2: "#555", t3: "#888", tm: "#AAA",
  bk: "#000", wh: "#FFF", dk: "#1A1A1A", md: "#333", lt: "#E0E0E0", ac: "#444",
};

// Static styles hoisted to avoid re-allocation on every render
const S = {
  expCard: { display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", background: "#F5F5F5", borderRadius: 12, position: "relative", zIndex: 2, transition: "transform .2s ease", willChange: "transform" },
  expIcon: { width: 38, height: 38, borderRadius: 10, background: "transparent", border: "1.5px solid #D4D4D4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 },
};

const safeParse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// period: { scope: "month"|"year"|"all", year?, month? }
const inPeriodFor = (e, period) => {
  if (period.scope === "all") return true;
  const d = new Date(e.date);
  if (period.scope === "year") return d.getFullYear() === period.year;
  return d.getMonth() === period.month && d.getFullYear() === period.year;
};

const periodLabel = (period) => period.scope === "all" ? "All Time"
  : period.scope === "year" ? String(period.year)
  : new Date(period.year, period.month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

// ── Mindful Insights helpers (pure, client-side only) ─────────────────────────
const expSig = (e) => {
  const kw = (e.note || "").toLowerCase().replace(/[^a-z\s]/g, " ").trim().split(/\s+/)
              .find(w => w.length >= 3) || "";
  return `${e.category}|${kw}`;
};

const checkMindfulEligibility = (exps, today) => {
  const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const targetMonth = { year: prev.getFullYear(), month: prev.getMonth() };
  const months = [0, 1, 2].map(i => {
    const d = new Date(prev.getFullYear(), prev.getMonth() - i, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const counts = months.map(m => exps.filter(e => {
    if (e.category === "investment") return false;
    const d = new Date(e.date);
    return d.getMonth() === m.month && d.getFullYear() === m.year;
  }).length);
  return { eligible: counts.every(c => c >= 10), targetMonth };
};

// Auto-essential: ≥3 occurrences with low variance across ≥2 calendar weeks
const learnEssentialSigs = (exps, refDate, monthsBack = 6) => {
  const since = new Date(refDate.getFullYear(), refDate.getMonth() - monthsBack, 1).getTime();
  const groups = new Map();
  for (const e of exps) {
    if (e.category === "investment" || e.tripId) continue;
    if (new Date(e.date).getTime() < since) continue;
    const sig = expSig(e);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(e);
  }
  const essentials = new Set();
  for (const [sig, arr] of groups) {
    if (arr.length < 3) continue;
    const amts = arr.map(e => e.amount);
    const mean = amts.reduce((s, v) => s + v, 0) / amts.length;
    const variance = amts.reduce((s, v) => s + (v - mean) ** 2, 0) / amts.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 99;
    const weeks = new Set(arr.map(e => {
      const d = new Date(e.date);
      const wkStart = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
      return `${wkStart.getFullYear()}-${wkStart.getMonth()}-${wkStart.getDate()}`;
    }));
    if (cv <= 0.6 && weeks.size >= 2) essentials.add(sig);
  }
  return essentials;
};

const computeBaselines = (exps, refDate, monthsBack = 6) => {
  const since = new Date(refDate.getFullYear(), refDate.getMonth() - monthsBack, 1).getTime();
  const wd = {}, we = {}, wdN = {}, weN = {};
  for (const e of exps) {
    if (e.category === "investment" || e.tripId) continue;
    const d = new Date(e.date);
    if (d.getTime() < since) continue;
    const isWe = d.getDay() === 0 || d.getDay() === 6;
    const cat = e.category;
    if (isWe) { we[cat] = (we[cat] || 0) + e.amount; weN[cat] = (weN[cat] || 0) + 1; }
    else      { wd[cat] = (wd[cat] || 0) + e.amount; wdN[cat] = (wdN[cat] || 0) + 1; }
  }
  const weekdayAvgByCat = {}, weekendAvgByCat = {};
  for (const c of Object.keys(wd)) weekdayAvgByCat[c] = wdN[c] > 0 ? wd[c] / wdN[c] : 0;
  for (const c of Object.keys(we)) weekendAvgByCat[c] = weN[c] > 0 ? we[c] / weN[c] : 0;
  return { weekdayAvgByCat, weekendAvgByCat };
};

const timeDayWeight = (e, baselines) => {
  const d = new Date(e.date);
  const isWe = d.getDay() === 0 || d.getDay() === 6;
  const baselineAvg = isWe
    ? (baselines.weekendAvgByCat[e.category] || 0)
    : (baselines.weekdayAvgByCat[e.category] || 0);
  if (baselineAvg <= 0) return 1.0;
  const ratio = e.amount / baselineAvg;
  if (ratio <= 1.0) return 1.0;
  return Math.min(2.0, 1.0 + Math.min(1.0, (ratio - 1) * 0.4));
};

// `history` is optional — callers that have already memoized it pass it in to
// avoid a full 6-month rescan on every period switch.
const buildMindfulReport = (exps, period, trips, prefs, history) => {
  const refDate = new Date();
  const { learnedEssentials, baselines } = history || {
    learnedEssentials: learnEssentialSigs(exps, refDate),
    baselines: computeBaselines(exps, refDate),
  };
  const essentialSigs = new Set(prefs?.essentialSigs || []);
  const avoidableSigs = new Set(prefs?.avoidableSigs || []);

  const essential = [], discretionary = [], tripExps = [];
  let essentialSpend = 0, discretionarySpend = 0;
  for (const e of exps) {
    if (e.category === "investment") continue;
    if (!inPeriodFor(e, period)) continue;
    if (e.tripId) { tripExps.push(e); continue; }
    const sig = expSig(e);
    const isEss = !avoidableSigs.has(sig) && (essentialSigs.has(sig) || learnedEssentials.has(sig));
    if (isEss) { essential.push(e); essentialSpend += e.amount; }
    else { discretionary.push({ ...e, sig, weight: timeDayWeight(e, baselines) }); discretionarySpend += e.amount; }
  }
  const totalSpend = essentialSpend + discretionarySpend;
  const discretionaryPct = totalSpend > 0 ? discretionarySpend / totalSpend : 0;

  discretionary.sort((a, b) => (b.amount * b.weight) - (a.amount * a.weight));
  let running = 0;
  const topAvoidable = [];
  for (const e of discretionary) {
    topAvoidable.push(e);
    running += e.amount;
    if (topAvoidable.length >= 5 || running >= 0.8 * discretionarySpend) break;
  }
  const topAvoidablePctOfDisc = discretionarySpend > 0 ? running / discretionarySpend : 0;

  const tripMap = new Map();
  for (const e of tripExps) {
    const t = tripMap.get(e.tripId) || { tripId: e.tripId, name: (trips.find(tr => tr.id === e.tripId)?.name || "Trip"), spend: 0, entries: 0 };
    t.spend += e.amount; t.entries += 1;
    tripMap.set(e.tripId, t);
  }
  const tripsSummary = [...tripMap.values()].sort((a, b) => b.spend - a.spend);
  const tripSpend = tripsSummary.reduce((s, t) => s + t.spend, 0);

  return {
    scope: period.scope,
    scopeLabel: periodLabel(period),
    totalSpend,
    essentialSpend,
    discretionarySpend,
    discretionaryPct,
    topAvoidable,
    topAvoidablePctOfDisc,
    trips: tripsSummary,
    tripSpend,
    baselines,
    periodEntryCount: essential.length + discretionary.length,
  };
};

export default function ExpenseTracker() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const { session, loading: authLoading, signOut, userId, needsPasswordReset } = useAuth();

  // ── State ─────────────────────────────────────────────────────────────────
  const [exps,      setExps]      = useState([]);
  const [trips,     setTrips]     = useState([]);
  const [dbReady,   setDbReady]   = useState(false);
  const [view,      setView]      = useState("list");
  const [amt,       setAmt]       = useState("");
  const [note,      setNote]      = useState("");
  const [cat,       setCat]       = useState("personal");
  const [pay,       setPay]       = useState("cash");
  const [editId,    setEditId]    = useState(null);
  const [toast,     setToast]     = useState(null);
  const [sq,        setSq]        = useState("");
  const [fCat,      setFCat]      = useState("all");
  const [fPay,      setFPay]      = useState("all");
  const [tripMod,   setTripMod]   = useState(false);
  const [tName,     setTName]     = useState("");
  const [tBudg,     setTBudg]     = useState("");
  const [editTripId,setEditTripId]= useState(null);
  const [selTrip,   setSelTrip]   = useState(null);
  const [sw,        setSw]        = useState({ id: null, dir: null });
  const [swipeConf, setSwipeConf] = useState(null); // expense id pending delete confirm via swipe
  const [detMod,    setDetMod]    = useState(null);
  const [tripDet,   setTripDet]   = useState(null);
  const [confDel,   setConfDel]   = useState(null); // trip deletion confirm
  // Insights period: "month" | "year" | "all"
  const [insExTrips,  setInsExTrips]  = useState(false); // exclude trips from insights
  const [insPeriod,   setInsPeriod]   = useState("month");
  const [insMonth,    setInsMonth]    = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() }; });
  const [insYear,     setInsYear]     = useState(() => new Date().getFullYear());
  // History period: "all" | "month" | "year" — persisted to localStorage
  const [histPeriod,  setHistPeriod]  = useState(() => { try { return localStorage.getItem("histPeriod") || "month"; } catch { return "month"; } });
  const [histMonth,   setHistMonth]   = useState(() => { const n = new Date(); try { const s = localStorage.getItem("histMonth"); if (s) return JSON.parse(s); } catch {} return { year: n.getFullYear(), month: n.getMonth() }; });
  const [histYear,    setHistYear]    = useState(() => { try { const s = localStorage.getItem("histYear"); if (s) return Number(s); } catch {} return new Date().getFullYear(); });
  const [editDate,  setEditDate]  = useState("");
  const [keyMod,     setKeyMod]     = useState(false);
  const [userKey,    setUserKey]    = useState(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [cats,       setCats]       = useState(OLD_DEFAULT_CATEGORIES);
  const [catMod,     setCatMod]     = useState(false);
  const [editCats,   setEditCats]   = useState(OLD_DEFAULT_CATEGORIES);
  const [catSaving,  setCatSaving]  = useState(false);
  const [newCatIcon, setNewCatIcon] = useState("");
  const [newCatLabel,setNewCatLabel]= useState("");
  const [dragIdx,    setDragIdx]    = useState(null); // index of cat being moved (tap-to-reorder)
  const [setupTab,   setSetupTab]   = useState("ios"); // "ios" | "android"
  const [banks,      setBanks]      = useState([]);
  const [bankMod,    setBankMod]    = useState(false);
  const [editBanks,  setEditBanks]  = useState([]);
  const [bankSaving, setBankSaving] = useState(false);
  const [profileMod, setProfileMod] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [delConfirm, setDelConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [onboardStep, setOnboardStep] = useState(null); // null = hidden, 0-2 = step index
  const [mindfulPrefs, setMindfulPrefs] = useState({ essentialSigs: [], avoidableSigs: [], autoMonthlyPopup: true });
  const [mindfulPopup, setMindfulPopup] = useState(null);

  const aRef = useRef(null);
  const tRef = useRef({});
  const mRef = useRef({}); // modal swipe-down tracking
  const lastTouchTime = useRef(0); // desktop click detection

  // ── Reset UI state on sign-out / sign-in / account switch ────────────────
  useEffect(() => {
    setProfileMod(false); setKeyMod(false); setCatMod(false); setBankMod(false);
    setTripMod(false); setDetMod(null); setOnboardStep(null); setDelConfirm(false);
    setView("list"); setDbReady(false); setExps([]); setTrips([]); setBanks([]);
    setCats(OLD_DEFAULT_CATEGORIES); setUserKey(null); setEditId(null);
    setAmt(""); setNote(""); setCat("personal"); setPay("cash");
    setMindfulPopup(null); setMindfulPrefs({ essentialSigs: [], avoidableSigs: [], autoMonthlyPopup: true });
  }, [userId]);

  // ── Load data + realtime ──────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let expsChannel, tripsChannel;
    let mindfulPopupTimer;

    const init = async () => {
      const [{ data: expRows }, { data: tripRows }, { data: prefsRow }] = await Promise.all([
        supabase.from("expenses").select("*").eq("user_id", userId).order("date", { ascending: false }),
        supabase.from("trips").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        supabase.from("user_prefs").select("cats_json, banks_json, mindful_json").eq("user_id", userId).maybeSingle(),
      ]);
      if (cancelled) return; // userId changed while fetching
      const mappedExps = (expRows || []).map(dbToExp);
      const mappedTrips = (tripRows || []).map(dbToTrip);
      setExps(mappedExps);
      setTrips(mappedTrips);
      if (prefsRow?.cats_json) {
        try {
          const saved = JSON.parse(prefsRow.cats_json);
          if (Array.isArray(saved) && saved.length > 0) {
            // Preserve user's saved order as source of truth
            const savedIds = new Set(saved.map(s => s.id));
            const merged = saved.map(s => {
              const def = DEFAULT_CATEGORIES.find(d => d.id === s.id);
              return { id: s.id, label: s.label || (def ? def.label : "Custom"), icon: s.icon || (def ? def.icon : "📌"), hidden: !!s.hidden };
            });
            // Append any missing defaults at end (e.g. new default added after user saved)
            DEFAULT_CATEGORIES.forEach(def => {
              if (!savedIds.has(def.id)) merged.push(def);
            });
            setCats(merged);
          }
        } catch {}
      } else {
        // No prefs yet — seed new users with modern category set
        const isNewUser = (expRows || []).length === 0;
        if (isNewUser) {
          setCats(NEW_DEFAULT_CATEGORIES);
          supabase.from("user_prefs").upsert({ user_id: userId, cats_json: JSON.stringify(NEW_DEFAULT_CATEGORIES) }).then(() => {});
        }
        // else: existing user with no customisation → keep OLD_DEFAULT_CATEGORIES (initial state)
      }
      if (prefsRow?.banks_json) {
        try {
          const parsed = JSON.parse(prefsRow.banks_json);
          setBanks(parsed);
          if (parsed.length > 0) setPay(parsed[0].id);
        } catch {}
      }
      // Resilient if mindful_json column doesn't exist yet
      const mPrefs = safeParse(prefsRow?.mindful_json) || { essentialSigs: [], avoidableSigs: [], autoMonthlyPopup: true };
      setMindfulPrefs(mPrefs);

      setDbReady(true);

      try {
        if (mPrefs.autoMonthlyPopup !== false && !localStorage.getItem(`mindfulReportOptOut_${userId}`)) {
          const today = new Date();
          const currKey = `${today.getFullYear()}-${today.getMonth()}`;
          const lastShown = localStorage.getItem(`lastMindfulReportMonth_${userId}`);
          if (lastShown !== currKey) {
            const { eligible, targetMonth } = checkMindfulEligibility(mappedExps, today);
            if (eligible) {
              mindfulPopupTimer = setTimeout(() => {
                if (cancelled) return;
                const report = buildMindfulReport(mappedExps, { scope: "month", ...targetMonth }, mappedTrips, mPrefs);
                setMindfulPopup(report);
              }, 800);
            }
          }
        }
      } catch {}

      // Onboarding: show guide for brand-new users (0 expenses, not previously dismissed)
      if ((!expRows || expRows.length === 0)) {
        try { if (!localStorage.getItem(`onboarded_${userId}`)) setOnboardStep(0); } catch {}
      }

      if (cancelled) return;
      expsChannel = supabase.channel(`exp:${userId}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "expenses", filter: `user_id=eq.${userId}` },
          ({ eventType, new: n, old: o }) => {
            if (eventType === "INSERT") { const e = dbToExp(n); setExps(p => p.some(x => x.id === e.id) ? p : [e, ...p]); }
            if (eventType === "UPDATE") setExps(p => p.map(x => x.id === n.id ? dbToExp(n) : x));
            if (eventType === "DELETE") setExps(p => p.filter(x => x.id !== o.id));
          }).subscribe();

      tripsChannel = supabase.channel(`trp:${userId}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "trips", filter: `user_id=eq.${userId}` },
          ({ eventType, new: n, old: o }) => {
            if (eventType === "INSERT") { const t = dbToTrip(n); setTrips(p => p.some(x => x.id === t.id) ? p : [...p, t]); }
            if (eventType === "UPDATE") setTrips(p => p.map(x => x.id === n.id ? dbToTrip(n) : x));
            if (eventType === "DELETE") setTrips(p => p.filter(x => x.id !== o.id));
          }).subscribe();
    };

    init();
    return () => {
      cancelled = true;
      if (mindfulPopupTimer) clearTimeout(mindfulPopupTimer);
      expsChannel?.unsubscribe();
      tripsChannel?.unsubscribe();
    };
  }, [userId]);

  const onboardReturn = useRef(null); // step to return to after modal closes (current step)
  const onboardAdvance = useRef(null); // step to advance to after modal SAVE
  const dismissOnboard = useCallback(() => {
    setOnboardStep(null);
    onboardReturn.current = null;
    try { localStorage.setItem(`onboarded_${userId}`, "1"); } catch {}
  }, [userId]);

  // ── Mindful Insights callbacks ──────────────────────────────────────────
  // Ref tracks the latest prefs so rapid successive callbacks don't read stale state.
  const mindfulPrefsRef = useRef(mindfulPrefs);
  mindfulPrefsRef.current = mindfulPrefs;

  const saveMindfulPrefs = useCallback((patch) => {
    const next = { ...mindfulPrefsRef.current, ...patch };
    mindfulPrefsRef.current = next;
    setMindfulPrefs(next);
    supabase.from("user_prefs").upsert({ user_id: userId, mindful_json: JSON.stringify(next) }).then(() => {}, () => {});
  }, [userId]);

  const dismissMindfulPopup = useCallback((optOut = false) => {
    setMindfulPopup(null);
    const today = new Date();
    const currKey = `${today.getFullYear()}-${today.getMonth()}`;
    try {
      localStorage.setItem(`lastMindfulReportMonth_${userId}`, currKey);
      if (optOut) localStorage.setItem(`mindfulReportOptOut_${userId}`, "1");
    } catch {}
    if (optOut) saveMindfulPrefs({ autoMonthlyPopup: false });
  }, [userId, saveMindfulPrefs]);

  const markMindfulSig = useCallback((sig, type) => {
    const key = type === "essential" ? "essentialSigs" : "avoidableSigs";
    const otherKey = type === "essential" ? "avoidableSigs" : "essentialSigs";
    const current = mindfulPrefsRef.current;
    saveMindfulPrefs({
      [key]: [...new Set([...(current[key] || []), sig])],
      [otherKey]: (current[otherKey] || []).filter(s => s !== sig),
    });
  }, [saveMindfulPrefs]);

  // ── Computed ──────────────────────────────────────────────────────────────
  const getTAct = useCallback((t) => {
    const te = exps.filter(e => e.tripId === t.id);
    const lu = te.length > 0 ? Math.max(...te.map(e => new Date(e.date).getTime())) : new Date(t.createdAt).getTime();
    return { isActive: dSince(lu) < 7, dSince: dSince(lu), lu, cnt: te.length };
  }, [exps]);

  const activeTrips = useMemo(() =>
    trips.filter(t => !t.archived).filter(t => getTAct(t).isActive || t.pinned)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  [trips, getTAct]);

  const inactiveTrips = useMemo(() =>
    trips.filter(t => !t.archived).filter(t => !getTAct(t).isActive && !t.pinned)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)),
  [trips, getTAct]);

  const addCats = useMemo(() => [
    ...cats.filter(c => !c.hidden),
    ...activeTrips.map(t => ({ id: `trip_${t.id}`, label: t.name, icon: "\u2708\uFE0F", isTrip: true })),
  ], [cats, activeTrips]);

  const allCats = useMemo(() => [
    ...cats,
    ...[...activeTrips, ...inactiveTrips].map(t => ({ id: `trip_${t.id}`, label: t.name, icon: "\u2708\uFE0F", isTrip: true })),
  ], [cats, activeTrips, inactiveTrips]);

  // Stable color per category/trip — sequential position, no hash collisions
  const catColorMap = useMemo(() => {
    const m = { uncategorized: "#8E8E93" }; allCats.forEach((c, i) => { m[c.id] = CAT_COLOR_PALETTE[i % CAT_COLOR_PALETTE.length]; }); return m;
  }, [allCats]);

  // Visible categories only — used for Add form category grid
  const visCats = useMemo(() => allCats.filter(c => !c.hidden), [allCats]);

  // Dynamic history filter: only categories that have expenses in the selected period
  const activeFilterCats = useMemo(() => {
    let periodExps = [...exps];
    if (histPeriod === "month") periodExps = periodExps.filter(e => { const d = new Date(e.date); return d.getMonth() === histMonth.month && d.getFullYear() === histMonth.year; });
    else if (histPeriod === "year") periodExps = periodExps.filter(e => new Date(e.date).getFullYear() === histYear);
    if (selTrip) periodExps = periodExps.filter(e => e.tripId === selTrip);
    const activeCatIds = new Set(periodExps.map(e => e.tripId ? `trip_${e.tripId}` : e.category));
    const result = visCats.filter(c => activeCatIds.has(c.id));
    trips.filter(t => !t.archived && activeCatIds.has(`trip_${t.id}`)).forEach(t => result.push({ id: `trip_${t.id}`, label: `✈️ ${t.name}` }));
    if (activeCatIds.has("uncategorized")) result.push(UNCAT);
    return result;
  }, [exps, visCats, trips, histPeriod, histMonth, histYear, selTrip]);

  // Dynamic payment modes: Cash + user's configured banks/cards
  const payModes = useMemo(() => {
    const modes = [{ id: "cash", label: "Cash" }];
    if (banks.length > 0) {
      banks.forEach(b => modes.push({ id: b.id, label: b.label + (b.type === "credit_card" ? " Card" : ""), bankType: b.type }));
    } else {
      modes.push({ id: "bank", label: "Bank" });
    }
    return modes;
  }, [banks]);

  // Get payment mode label for display (handles legacy "bank"/"card" values)
  const getPayLabel = useCallback((payId) => {
    if (payId === "cash") return "Cash";
    if (payId === "bank") return "Bank";
    if (payId === "card") return "Card";
    const b = banks.find(x => x.id === payId);
    return b ? b.label : "Bank";
  }, [banks]);


  const toastTimer = useRef(null);
  const sToast = useCallback((m, t = "ok") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ m, t });
    toastTimer.current = setTimeout(() => { setToast(null); toastTimer.current = null; }, 1500);
  }, []);

  useEffect(() => { if (view === "add" && aRef.current) setTimeout(() => aRef.current?.focus(), 80); }, [view]);
  useEffect(() => { if (session?.user?.user_metadata?.full_name) setProfileName(session.user.user_metadata.full_name); }, [session]);

  // ── Shortcut key management ───────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    supabase.from("user_keys").select("key_value").eq("user_id", userId).maybeSingle()
      .then(({ data }) => setUserKey(data?.key_value || null));
  }, [userId]);

  const handleGenerateKey = useCallback(async () => {
    setKeyLoading(true);
    const chars = "abcdefghjkmnpqrstuvwxyz";
    const digits = "0123456789";
    let k = "";
    for (let i = 0; i < 3; i++) k += chars[Math.floor(Math.random() * chars.length)];
    for (let i = 0; i < 4; i++) k += digits[Math.floor(Math.random() * digits.length)];
    await supabase.from("user_keys").delete().eq("user_id", userId);
    const { error } = await supabase.from("user_keys").insert({ user_id: userId, key_value: k });
    if (error) sToast("Error generating key", "err");
    else { setUserKey(k); sToast("Key generated"); }
    setKeyLoading(false);
  }, [userId, sToast]);

  const copyKey = useCallback(() => {
    if (!userKey) return;
    navigator.clipboard?.writeText(userKey).then(() => sToast("Copied!")).catch(() => sToast("Copy failed", "err"));
  }, [userKey, sToast]);

  const API_BASE = "https://expenses.gurjarbooks.com";
  const copyText = useCallback((text) => {
    navigator.clipboard?.writeText(text).then(() => sToast("Copied!")).catch(() => sToast("Copy failed", "err"));
  }, [sToast]);

  // ── CRUD — all optimistic ─────────────────────────────────────────────────
  const savingRef = useRef(false);
  const doSave = useCallback(async () => {
    if (savingRef.current) return; // prevent double-submit
    const v = Math.round(Number(amt));
    if (!v || v <= 0) { sToast("Enter amount", "err"); return; }
    savingRef.current = true;
    setTimeout(() => { savingRef.current = false; }, 600);
    hap();
    const tid = cat.startsWith("trip_") ? cat.replace("trip_", "") : null;
    if (editId) {
      const orig = exps.find(e => e.id === editId);
      const origTime = orig?.date ? new Date(orig.date).toISOString().slice(11) : "12:00:00.000Z";
      const updated = { ...orig, amount: v, note: note.trim(), category: tid ? "trip" : cat, payMode: pay, tripId: tid, date: editDate ? new Date(editDate + "T" + origTime).toISOString() : orig?.date };
      setExps(p => p.map(e => e.id === editId ? updated : e).sort((a, b) => new Date(b.date) - new Date(a.date)));
      setEditId(null); setEditDate(""); sToast("Updated"); setView("list");
      supabase.from("expenses").update(expToDb(updated, userId)).eq("id", editId)
        .then(({ error }) => { if (error) sToast("Sync error", "err"); });
    } else {
      const newExp = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        amount: v, note: note.trim(), category: tid ? "trip" : cat,
        payMode: pay, date: new Date().toISOString(), tripId: tid,
      };
      setExps(p => [newExp, ...p]);
      sToast(`${formatINR(v)} saved`);
      supabase.from("expenses").insert(expToDb(newExp, userId))
        .then(({ error }) => { if (error) sToast("Sync error", "err"); });
    }
    setAmt(""); setNote("");
    setTimeout(() => aRef.current?.focus(), 50);
  }, [amt, cat, note, pay, editId, editDate, exps, userId, sToast]);

  const doDel = useCallback((id) => {
    hap();
    setExps(p => p.filter(e => e.id !== id));
    setSw({ id: null, dir: null }); setSwipeConf(null); setDetMod(null);
    sToast("Deleted", "err");
    supabase.from("expenses").delete().eq("id", id)
      .then(({ error }) => { if (error) sToast("Sync error", "err"); });
  }, [sToast]);

  const doEdit = useCallback((exp) => {
    setAmt(exp.amount.toString()); setNote(exp.note || "");
    setCat(exp.tripId ? `trip_${exp.tripId}` : exp.category);
    setPay(exp.payMode); setEditId(exp.id);
    setEditDate(new Date(exp.date).toISOString().slice(0, 10));
    setView("add");
    setSw({ id: null, dir: null }); setDetMod(null);
  }, []);

  const doSaveTrip = useCallback(async () => {
    if (!tName.trim()) return; hap();
    if (editTripId) {
      const updatedTrip = { ...trips.find(t => t.id === editTripId), name: tName.trim(), budget: Math.round(Number(tBudg)) || 0 };
      setTrips(p => p.map(t => t.id === editTripId ? updatedTrip : t));
      setEditTripId(null); sToast("Trip updated");
      supabase.from("trips").update(tripToDb(updatedTrip, userId)).eq("id", editTripId)
        .then(({ error }) => { if (error) sToast("Sync error", "err"); });
    } else {
      const newTrip = { id: Date.now().toString(36), name: tName.trim(), budget: Math.round(Number(tBudg)) || 0, createdAt: new Date().toISOString(), pinned: false, archived: false };
      setTrips(p => [...p, newTrip]);
      sToast("Trip created");
      supabase.from("trips").insert(tripToDb(newTrip, userId))
        .then(({ error }) => { if (error) sToast("Sync error", "err"); });
    }
    setTName(""); setTBudg(""); setTripMod(false);
  }, [tName, tBudg, editTripId, trips, userId, sToast]);

  const canDelTrip = useCallback((t) => hSince(t.createdAt) <= 48 || !exps.some(e => e.tripId === t.id), [exps]);

  const doDelTrip = useCallback((t) => {
    if (!canDelTrip(t)) { sToast("Has entries & >48hrs", "err"); return; }
    setTrips(p => p.map(x => x.id === t.id ? { ...x, archived: true } : x));
    setExps(p => p.map(e => e.tripId === t.id ? { ...e, tripId: null, category: "personal" } : e));
    setConfDel(null); setTripDet(null); sToast("Trip deleted");
    Promise.all([
      supabase.from("trips").update({ archived: true }).eq("id", t.id),
      supabase.from("expenses").update({ trip_id: null, category: "personal" }).eq("trip_id", t.id),
    ]).then(results => {
      if (results.some(r => r.error)) sToast("Sync error", "err");
    });
  }, [canDelTrip, sToast]);

  const pinT = useCallback((id) => {
    setTrips(p => p.map(t => t.id === id ? { ...t, pinned: true } : t)); sToast("Pinned");
    supabase.from("trips").update({ pinned: true }).eq("id", id)
      .then(({ error }) => { if (error) sToast("Sync error", "err"); });
  }, [sToast]);

  const unpinT = useCallback((id) => {
    setTrips(p => p.map(t => t.id === id ? { ...t, pinned: false } : t)); sToast("Unpinned");
    supabase.from("trips").update({ pinned: false }).eq("id", id)
      .then(({ error }) => { if (error) sToast("Sync error", "err"); });
  }, [sToast]);

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let l = [...exps];
    // Date range filter
    if (histPeriod === "month") l = l.filter(e => { const d = new Date(e.date); return d.getMonth() === histMonth.month && d.getFullYear() === histMonth.year; });
    else if (histPeriod === "year") l = l.filter(e => new Date(e.date).getFullYear() === histYear);
    if (selTrip) l = l.filter(e => e.tripId === selTrip);
    else if (fCat !== "all") {
      if (fCat.startsWith("trip_")) l = l.filter(e => e.tripId === fCat.replace("trip_", ""));
      else l = l.filter(e => e.category === fCat && !e.tripId);
    }
    if (fPay !== "all") l = l.filter(e => e.payMode === fPay);
    if (sq.trim()) {
      const q = sq.toLowerCase();
      l = l.filter(e => {
        const catLabel = (allCats.find(c => c.id === (e.tripId ? `trip_${e.tripId}` : e.category))?.label || "").toLowerCase();
        const payLabel = getPayLabel(e.payMode).toLowerCase();
        return (e.note || "").toLowerCase().includes(q) || e.amount.toString().includes(q) || catLabel.includes(q) || payLabel.includes(q);
      });
    }
    return l; // exps is always newest-first; filtering preserves that order
  }, [exps, fCat, fPay, sq, selTrip, allCats, histPeriod, histMonth, histYear]);

  // ── Export ────────────────────────────────────────────────────────────────
  const esc = useCallback((v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"), []);
  const doExportPDF = useCallback(() => {
    if (filtered.length === 0) return;
    const getCatLabel = (e) => {
      if (e.tripId) { const t = trips.find(x => x.id === e.tripId); return t ? t.name : "Trip"; }
      return cats.find(c => c.id === e.category)?.label || e.category;
    };
    const userName = session?.user?.user_metadata?.full_name || session?.user?.email?.split("@")[0] || "Expense Report";
    const periodLabel = selTrip
      ? `Trip: ${trips.find(t => t.id === selTrip)?.name || ""}`
      : fCat !== "all" ? (allCats.find(c => c.id === fCat)?.label || "Category") : "All Categories";
    const dates = filtered.map(e => new Date(e.date).getTime());
    const dateRange = sameDay(Math.min(...dates), Math.max(...dates))
      ? tds(Math.min(...dates))
      : `${tds(Math.min(...dates))} \u2013 ${tds(Math.max(...dates))}`;
    const total = filtered.reduce((s, e) => s + e.amount, 0);
    const generated = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const fileName = `Expenses-${esc(periodLabel).replace(/[^\w]/g, "-")}-${new Date().toISOString().slice(0, 10)}`;

    // ── Breakdown computations ──────────────────────────────────────────────
    const byCat = {}, byPay = {};
    const periodMap = new Map();
    const allYears = new Set(filtered.map(e => new Date(e.date).getFullYear()));
    const sameYearData = allYears.size === 1;
    const allMonths = new Set(filtered.map(e => { const d = new Date(e.date); return d.getFullYear() * 12 + d.getMonth(); }));
    const showTimeSplit = histPeriod !== "month" && allMonths.size > 1;
    filtered.forEach(e => {
      const cl = getCatLabel(e);
      byCat[cl] = (byCat[cl] || 0) + e.amount;
      byPay[getPayLabel(e.payMode)] = (byPay[getPayLabel(e.payMode)] || 0) + e.amount;
      if (showTimeSplit) {
        const d = new Date(e.date);
        const sortKey = sameYearData
          ? `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}`
          : d.getFullYear().toString();
        const label = sameYearData
          ? d.toLocaleDateString("en-IN", { month: "long" })
          : d.getFullYear().toString();
        if (!periodMap.has(sortKey)) periodMap.set(sortKey, { label, total: 0 });
        periodMap.get(sortKey).total += e.amount;
      }
    });
    const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const payEntries = Object.entries(byPay).sort((a, b) => b[1] - a[1]);
    const periodEntries = [...periodMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => v);

    const bkTableRows = (entries) => entries.map(([label, amt]) =>
      `<tr><td>${esc(label)}</td><td class="bamt">\u20B9${amt.toLocaleString("en-IN")}</td><td class="bpct">${Math.round(amt / total * 100)}%</td></tr>`
    ).join("");
    const periodTableRows = periodEntries.map(({ label, total: t }) =>
      `<tr><td>${esc(label)}</td><td class="bamt">\u20B9${t.toLocaleString("en-IN")}</td><td class="bpct">${Math.round(t / total * 100)}%</td></tr>`
    ).join("");

    const breakdownSections = [];
    if (catEntries.length > 1) breakdownSections.push(`<div class="bk"><div class="bk-title">By Category</div><table class="bkt"><tbody>${bkTableRows(catEntries)}</tbody></table></div>`);
    if (payEntries.length > 1) breakdownSections.push(`<div class="bk"><div class="bk-title">By Payment Mode</div><table class="bkt"><tbody>${bkTableRows(payEntries)}</tbody></table></div>`);
    if (periodEntries.length > 1) breakdownSections.push(`<div class="bk"><div class="bk-title">${sameYearData ? "By Month" : "By Year"}</div><table class="bkt"><tbody>${periodTableRows}</tbody></table></div>`);
    const breakdownHtml = breakdownSections.length > 0
      ? `<div class="bk-wrap">${breakdownSections.join("")}</div>`
      : "";

    const rows = [...filtered].reverse().map(e => `
      <tr>
        <td>${tds(e.date)}</td>
        <td class="t2">${tts(e.date)}</td>
        <td>${esc(getCatLabel(e))}</td>
        <td>${e.note ? esc(e.note) : "<span class='em'>\u2014</span>"}</td>
        <td class="t2">${esc(getPayLabel(e.payMode))}</td>
        <td class="amt">\u20B9${e.amount.toLocaleString("en-IN")}</td>
      </tr>`).join("");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(fileName)}</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif; color: #111; padding: 28px 32px; font-size: 13px; line-height: 1.5; }
.header { padding-bottom: 14px; margin-bottom: 20px; border-bottom: 2.5px solid #111; }
.brand { font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
.subtitle { font-size: 15px; font-weight: 700; color: #333; margin-top: 6px; }
.meta { font-size: 11.5px; color: #666; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12.5px; }
thead th { background: #111; color: #fff; padding: 8px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase; text-align: left; }
thead th.r { text-align: right; }
td { padding: 7px 10px; border-bottom: 1px solid #EBEBEB; vertical-align: top; }
tr:nth-child(even) td { background: #F8F8F8; }
td.amt { text-align: right; font-weight: 700; white-space: nowrap; }
td.t2 { color: #666; white-space: nowrap; }
.em { color: #AAA; }
.summary { display: flex; justify-content: space-between; align-items: flex-end; padding-top: 14px; border-top: 2px solid #111; margin-bottom: 28px; }
.sum-label { font-size: 11px; font-weight: 700; color: #666; letter-spacing: 0.8px; text-transform: uppercase; }
.sum-total { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; margin-top: 3px; }
.sum-meta { font-size: 12px; color: #888; }
.bk-wrap { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 24px; }
.bk { flex: 1; min-width: 160px; }
.bk-title { font-size: 11px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; color: #666; margin-bottom: 8px; }
.bkt { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 0; }
.bkt td { padding: 5px 6px; border-bottom: 1px solid #EBEBEB; }
.bkt tr:last-child td { border-bottom: none; }
td.bamt { text-align: right; font-weight: 700; white-space: nowrap; }
td.bpct { text-align: right; color: #888; font-size: 11px; width: 36px; }
.footer { margin-top: 24px; font-size: 10px; color: #BBB; text-align: center; }
@media print { body { padding: 0; } @page { margin: 1.5cm; size: A4 portrait; } }
</style>
</head>
<body>
<div class="header">
  <div class="brand">${esc(userName)}</div>
  <div class="subtitle">Expense Report &middot; ${esc(periodLabel)}</div>
  <div class="meta">Period: <b>${dateRange}</b> &nbsp;&middot;&nbsp; Generated: ${generated}${fPay !== "all" ? ` &nbsp;&middot;&nbsp; ${fPay === "cash" ? "Cash" : "Bank"} only` : ""}</div>
</div>
<table>
  <thead>
    <tr>
      <th>Date</th>
      <th>Time</th>
      <th>Category</th>
      <th>Note</th>
      <th>Mode</th>
      <th class="r">Amount</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<div class="summary">
  <div class="sum-meta">${filtered.length} entr${filtered.length === 1 ? "y" : "ies"}</div>
  <div style="text-align:right">
    <div class="sum-label">Total</div>
    <div class="sum-total">\u20B9${total.toLocaleString("en-IN")}</div>
  </div>
</div>
${breakdownHtml}
<div class="footer">Expense Tracker</div>
<script>document.title = "${esc(fileName)}"; window.addEventListener("load", () => setTimeout(() => window.print(), 250));<\/script>
</body>
</html>`;
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); }
    else sToast("Allow pop-ups to export PDF", "err");
  }, [filtered, cats, trips, selTrip, fCat, fPay, allCats, histPeriod, sToast, session, esc]);

  const doExportXLSX = useCallback(async () => {
    if (filtered.length === 0) return;
    sToast("Generating Excel…");
    const ExcelJS = (await import("exceljs")).default;
    const getCatLabel = (e) => {
      if (e.tripId) { const t = trips.find(x => x.id === e.tripId); return t ? t.name : "Trip"; }
      return cats.find(c => c.id === e.category)?.label || e.category;
    };
    const wb = new ExcelJS.Workbook();

    // ── Main expenses sheet ─────────────────────────────────────────────────
    const ws = wb.addWorksheet("Expenses");
    ws.columns = [
      { header: "Date", key: "date", width: 14 },
      { header: "Time", key: "time", width: 10 },
      { header: "Category", key: "category", width: 16 },
      { header: "Note", key: "note", width: 30 },
      { header: "Payment Mode", key: "payMode", width: 14 },
      { header: "Amount (INR)", key: "amount", width: 14 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.autoFilter = { from: "A1", to: "F1" };
    [...filtered].reverse().forEach(e => {
      ws.addRow({ date: tds(e.date), time: tts(e.date), category: getCatLabel(e), note: e.note || "", payMode: getPayLabel(e.payMode), amount: e.amount });
    });

    // ── Summary sheet ───────────────────────────────────────────────────────
    const ss = wb.addWorksheet("Summary");
    ss.columns = [{ header: "", key: "label", width: 22 }, { header: "", key: "amount", width: 16 }, { header: "", key: "pct", width: 10 }];
    const total = filtered.reduce((s, e) => s + e.amount, 0);
    const hStyle = { font: { bold: true, size: 11 }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }, alignment: { horizontal: "left" } };
    const subHStyle = { font: { bold: true, size: 10 }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } } };
    const addSection = (title, entries) => {
      if (entries.length < 2) return;
      const hr = ss.addRow([title, "Amount (INR)", "%"]);
      hr.eachCell(c => { Object.assign(c, hStyle); if (hStyle.fill) { c.fill = hStyle.fill; c.font = { ...hStyle.font, color: { argb: "FFFFFFFF" } }; } });
      entries.forEach(([label, amt]) => {
        const r = ss.addRow([label, amt, `${Math.round(amt / total * 100)}%`]);
        r.getCell(2).numFmt = "#,##0";
        r.getCell(2).alignment = { horizontal: "right" };
        r.getCell(3).alignment = { horizontal: "right" };
      });
      const tr = ss.addRow(["Total", total, "100%"]);
      tr.eachCell(c => { c.font = { bold: true }; });
      tr.getCell(2).numFmt = "#,##0";
      tr.getCell(2).alignment = { horizontal: "right" };
      tr.getCell(3).alignment = { horizontal: "right" };
      ss.addRow([]);
    };

    // By category
    const byCat = {};
    filtered.forEach(e => { const k = getCatLabel(e); byCat[k] = (byCat[k] || 0) + e.amount; });
    addSection("BY CATEGORY", Object.entries(byCat).sort((a, b) => b[1] - a[1]));

    // By payment mode
    const byPay = {};
    filtered.forEach(e => { byPay[getPayLabel(e.payMode)] = (byPay[getPayLabel(e.payMode)] || 0) + e.amount; });
    addSection("BY PAYMENT MODE", Object.entries(byPay).sort((a, b) => b[1] - a[1]));

    // By period (months or years)
    if (histPeriod !== "month") {
      const periodMap = new Map();
      const allYears = new Set(filtered.map(e => new Date(e.date).getFullYear()));
      const sameYearData = allYears.size === 1;
      filtered.forEach(e => {
        const d = new Date(e.date);
        const sortKey = sameYearData ? `${d.getFullYear()}-${String(d.getMonth()).padStart(2, "0")}` : d.getFullYear().toString();
        const label = sameYearData ? d.toLocaleDateString("en-IN", { month: "long" }) : d.getFullYear().toString();
        if (!periodMap.has(sortKey)) periodMap.set(sortKey, { label, total: 0 });
        periodMap.get(sortKey).total += e.amount;
      });
      const periodEntries = [...periodMap.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => [v.label, v.total]);
      addSection(sameYearData ? "BY MONTH" : "BY YEAR", periodEntries);
    }

    // Style header row of summary sheet
    const sh = ss.getRow(1); sh.height = 0; // hide the auto-generated blank header

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Expenses-${new Date().toISOString().slice(0, 10)}.xlsx`; a.click();
    URL.revokeObjectURL(url);
    sToast("Excel downloaded");
  }, [filtered, cats, trips, histPeriod, sToast]);

  // ── Custom categories ─────────────────────────────────────────────────────
  const openCatMod = useCallback(() => {
    setEditCats(cats.map(c => ({ ...c })));
    setNewCatIcon(""); setNewCatLabel(""); setDragIdx(null);
    setCatMod(true);
  }, [cats]);

  const saveCustomCats = useCallback(async () => {
    setCatSaving(true);
    const cleaned = editCats.filter(c => c.label.trim()).map(c => {
      const def = DEFAULT_CATEGORIES.find(d => d.id === c.id);
      return { id: c.id, label: c.label.trim() || (def ? def.label : "Custom"), icon: c.icon.trim() || (def ? def.icon : "📌"), hidden: !!c.hidden };
    });
    setCats(cleaned);
    setCatMod(false);
    if (onboardAdvance.current !== null) { setOnboardStep(onboardAdvance.current); onboardReturn.current = null; onboardAdvance.current = null; }
    const { error } = await supabase.from("user_prefs").upsert({ user_id: userId, cats_json: JSON.stringify(cleaned) });
    setCatSaving(false);
    if (error) sToast("Sync error", "err");
  }, [editCats, userId, sToast]);

  const addNewCat = useCallback(() => {
    if (!newCatLabel.trim()) return;
    const id = "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setEditCats(p => [...p, { id, label: newCatLabel.trim(), icon: newCatIcon.trim() || "📦", hidden: false }]);
    setNewCatLabel(""); setNewCatIcon("");
  }, [newCatLabel, newCatIcon]);

  const moveCat = useCallback((fromIdx, toIdx) => {
    setEditCats(p => {
      const a = [...p];
      const [item] = a.splice(fromIdx, 1);
      a.splice(toIdx, 0, item);
      return a;
    });
    setDragIdx(null);
  }, []);

  const switchToNewDefaults = useCallback(() => {
    setEditCats(NEW_DEFAULT_CATEGORIES.map(c => ({ ...c })));
  }, []);

  // ── Banks & Cards ───────────────────────────────────────────────────────
  const openBankMod = useCallback(() => {
    setEditBanks(banks.map(b => ({ ...b })));
    setBankMod(true);
  }, [banks]);

  const saveBanks = useCallback(async () => {
    setBankSaving(true);
    const cleaned = editBanks.filter(b => b.label.trim()).map(b => ({
      id: b.id, label: b.label.trim(), type: b.type || "bank", last4: (b.last4 || "").trim(),
    }));
    setBanks(cleaned);
    setBankMod(false);
    if (onboardAdvance.current !== null) { setOnboardStep(onboardAdvance.current); onboardReturn.current = null; onboardAdvance.current = null; }
    const { error } = await supabase.from("user_prefs").upsert({ user_id: userId, banks_json: JSON.stringify(cleaned) });
    setBankSaving(false);
    if (error) sToast("Sync error", "err");
  }, [editBanks, userId, sToast]);

  // ── Insights ──────────────────────────────────────────────────────────────
  const insAsPeriod = useMemo(() => insPeriod === "all"
    ? { scope: "all" }
    : insPeriod === "year"
      ? { scope: "year", year: insYear }
      : { scope: "month", year: insMonth.year, month: insMonth.month },
  [insPeriod, insMonth, insYear]);

  const insPeriodLabel = useMemo(() => periodLabel(insAsPeriod), [insAsPeriod]);

  const ins = useMemo(() => {
    const hasTripInPeriod = exps.some(e => e.tripId && e.category !== "investment" && inPeriodFor(e, insAsPeriod));
    const tm = exps.filter(e => {
      if (e.category === "investment") return false;
      if (insExTrips && e.tripId) return false;
      return inPeriodFor(e, insAsPeriod);
    });
    const bc = {}, bp = {};
    tm.forEach(e => { const k = e.tripId ? `trip_${e.tripId}` : e.category; bc[k] = (bc[k] || 0) + e.amount; bp[e.payMode] = (bp[e.payMode] || 0) + e.amount; });
    const totM = tm.reduce((s, e) => s + e.amount, 0);
    const totI = exps.filter(e =>
      e.category === "investment" && !e.tripId && inPeriodFor(e, insAsPeriod)
    ).reduce((s, e) => s + e.amount, 0);
    return { bc, bp, totM, totI, mc: tm.length, hasTripInPeriod };
  }, [exps, insAsPeriod, insExTrips]);

  // 6-month history scans are independent of the selected period — memoize separately
  // so switching period tabs doesn't trigger a full rescan.
  const mindfulHistory = useMemo(() => {
    const refDate = new Date();
    return {
      eligible: checkMindfulEligibility(exps, refDate).eligible,
      learnedEssentials: learnEssentialSigs(exps, refDate),
      baselines: computeBaselines(exps, refDate),
    };
  }, [exps]);

  const mindfulReport = useMemo(() => {
    if (!mindfulHistory.eligible) return null;
    return buildMindfulReport(exps, insAsPeriod, trips, mindfulPrefs, mindfulHistory);
  }, [mindfulHistory, exps, trips, mindfulPrefs, insAsPeriod]);

  // Yearly bar chart data: monthly breakdown for the selected year
  const yearlyBars = useMemo(() => {
    if (insPeriod !== "year") return [];
    const months = Array.from({ length: 12 }, (_, i) => ({ month: i, total: 0 }));
    exps.forEach(e => {
      if (e.category === "investment") return;
      if (insExTrips && e.tripId) return;
      const d = new Date(e.date);
      if (d.getFullYear() === insYear) months[d.getMonth()].total += e.amount;
    });
    return months;
  }, [exps, insYear, insPeriod, insExTrips]);

  const shiftPeriod = useCallback((dir) => {
    if (insPeriod === "month") {
      setInsMonth(prev => {
        let m = prev.month + dir, y = prev.year;
        if (m < 0)  { m = 11; y--; }
        if (m > 11) { m = 0;  y++; }
        return { year: y, month: m };
      });
    } else if (insPeriod === "year") {
      setInsYear(prev => prev + dir);
    }
  }, [insPeriod]);

  const cyclePeriod = useCallback(() => {
    setInsPeriod(p => p === "month" ? "year" : p === "year" ? "all" : "month");
  }, []);

  // History period helpers
  const histPeriodLabel = useMemo(() => {
    if (histPeriod === "all") return "All Time";
    if (histPeriod === "year") return histYear.toString();
    return new Date(histMonth.year, histMonth.month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  }, [histMonth, histYear, histPeriod]);

  const shiftHistPeriod = useCallback((dir) => {
    if (histPeriod === "month") {
      setHistMonth(prev => {
        let m = prev.month + dir, y = prev.year;
        if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
        const next = { year: y, month: m };
        try { localStorage.setItem("histMonth", JSON.stringify(next)); } catch {}
        return next;
      });
    } else if (histPeriod === "year") {
      setHistYear(prev => {
        const next = prev + dir;
        try { localStorage.setItem("histYear", String(next)); } catch {}
        return next;
      });
    }
  }, [histPeriod]);

  const cycleHistPeriod = useCallback(() => {
    setHistPeriod(p => {
      const next = p === "all" ? "month" : p === "month" ? "year" : "all";
      try { localStorage.setItem("histPeriod", next); } catch {}
      return next;
    });
  }, []);

  // ── Trip insights ─────────────────────────────────────────────────────────
  const getTI = useCallback((tid) => {
    const te = exps.filter(e => e.tripId === tid).sort((a, b) => new Date(a.date) - new Date(b.date));
    const tot = te.reduce((s, e) => s + e.amount, 0);
    const byPay = {};
    te.forEach(e => { byPay[e.payMode] = (byPay[e.payMode] || 0) + e.amount; });
    let d = 0;
    if (te.length > 1) d = Math.max(1, Math.ceil((new Date(te[te.length - 1].date) - new Date(te[0].date)) / 864e5) + 1);
    else if (te.length === 1) d = 1;
    return { tot, byPay, d, avg: d > 0 ? Math.round(tot / d) : 0, cnt: te.length };
  }, [exps]);

  // ── Swipe handlers ────────────────────────────────────────────────────────
  const onTS = useCallback((e, id) => { lastTouchTime.current = Date.now(); tRef.current = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, id, t: Date.now() }; }, []);
  const onTE = useCallback((e) => {
    const dx = e.changedTouches[0].clientX - tRef.current.sx;
    const dy = Math.abs(e.changedTouches[0].clientY - tRef.current.sy);
    const el = Date.now() - tRef.current.t;
    const id = tRef.current.id;
    if (dy > 50) { setSw({ id: null, dir: null }); setSwipeConf(null); return; }
    if (Math.abs(dx) < 15 && el < 300) { const ex = exps.find(x => x.id === id); if (ex) setDetMod(ex); setSw({ id: null, dir: null }); setSwipeConf(null); return; }
    if (dx < -80) { const ex = exps.find(x => x.id === id); if (ex) doEdit(ex); return; } // long swipe → edit immediately
    if (dx < -40) { setSw({ id, dir: "left" }); return; } // short swipe → peek edit panel
    if (dx > 50) setSw({ id, dir: "right" });
    else { setSw({ id: null, dir: null }); setSwipeConf(null); }
  }, [exps, doEdit]);

  const getCL = (e) => { if (e.tripId) { const t = trips.find(x => x.id === e.tripId); return t ? t.name : "Trip"; } if (e.category === "uncategorized") return UNCAT.label; return cats.find(c => c.id === e.category)?.label || e.category; };
  const getCI = (e) => { if (e.tripId) return "\u2708\uFE0F"; if (e.category === "uncategorized") return UNCAT.icon; return cats.find(c => c.id === e.category)?.icon || "?"; };

  // navTo: navigate to tab. Only clear filters when explicitly resetting (e.g., tapping ₹ logo → Add).
  // Navigating back to History preserves whatever filter the user had set.
  const navTo = (t) => { hap(); setSw({ id: null, dir: null }); setSwipeConf(null); setView(t); };
  const viewTH = (tid) => { setSelTrip(tid); setFCat("all"); setFPay("all"); setSq(""); setHistPeriod("all"); setView("list"); };

  const B = (sel, children, onClick, extra = {}) => (
    <button onClick={onClick} style={{ padding: "7px 10px", borderRadius: 18, cursor: "pointer", fontSize: 13, fontWeight: sel ? 700 : 500, border: `2px solid ${sel ? G.bk : G.bdr}`, background: sel ? G.bk : G.bg, color: sel ? G.wh : G.t2, ...extra }}>{children}</button>
  );

  // ── Auth guards (must be after all hooks) ─────────────────────────────────
  if (authLoading) return (
    <div style={{ maxWidth: 390, margin: "0 auto", minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: G.bg }}>
      <div style={{ width: 36, height: 36, border: "4px solid #E0E0E0", borderTopColor: "#000", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (needsPasswordReset) return <PasswordReset />;
  if (!session) return <Auth />;

  // ── RENDER ────────────────────────────────────────────────────────────────
  return (
    <div style={{ maxWidth: 390, margin: "0 auto", minHeight: "100dvh", display: "flex", flexDirection: "column", background: G.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif", color: G.t1, position: "relative", WebkitFontSmoothing: "antialiased", paddingTop: "env(safe-area-inset-top)" }}>

      {toast && <div style={{ position: "fixed", top: "calc(env(safe-area-inset-top, 0px) + 52px)", left: "50%", transform: "translateX(-50%)", padding: "10px 28px", borderRadius: 100, zIndex: 9999, background: G.bk, color: G.wh, fontSize: 15, fontWeight: 600, boxShadow: "0 6px 24px rgba(0,0,0,.25)", whiteSpace: "nowrap" }}>{toast.m}</div>}

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", background: G.bg, borderBottom: `1px solid ${G.bdr}`, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div onClick={() => navTo("add")} style={{ width: 34, height: 34, borderRadius: 8, background: G.bk, color: G.wh, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17, cursor: "pointer" }}>{"\u20B9"}</div>
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>
            {view === "add" ? "Add Expense" : view === "list" ? (selTrip ? (trips.find(t => t.id === selTrip)?.name || "History") : "History") : view === "insights" ? "Insights" : "Trips"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setKeyMod(true)} title="SMS Automation" style={{ background: "none", border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "5px 10px", fontSize: 15, color: G.t3, cursor: "pointer", lineHeight: 1 }}>🔑</button>
          <button onClick={() => setProfileMod(true)} title="Profile" style={{ background: "none", border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "5px 10px", fontSize: 15, color: G.t3, cursor: "pointer", lineHeight: 1 }}>👤</button>
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto", paddingBottom: 72 }}>

        {/* Skeleton while loading from DB */}
        {!dbReady && (
          <div style={{ padding: "24px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            {[1, 2, 3].map(i => <div key={i} style={{ height: 64, borderRadius: 12, background: "#F0F0F0", animation: "pulse 1.2s ease-in-out infinite alternate" }} />)}
            <style>{`@keyframes pulse { from { opacity:1 } to { opacity:0.4 } }`}</style>
          </div>
        )}

        {/* ══════ ADD ══════ */}
        {dbReady && view === "add" && (
          <div style={{ padding: "8px 18px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "center", padding: "10px 0 4px" }}>
              <span style={{ fontSize: 32, fontWeight: 300, color: G.tm, marginRight: 2 }}>{"\u20B9"}</span>
              <input ref={aRef} type="tel" inputMode="numeric" pattern="[0-9]*" placeholder="0" value={amt} onChange={e => setAmt(e.target.value.replace(/[^0-9]/g, ""))} onKeyDown={e => { if (e.key === "Enter") doSave(); }} style={{ fontSize: 46, fontWeight: 800, border: "none", outline: "none", width: "55%", textAlign: "center", color: G.t1, background: "transparent", letterSpacing: -2, caretColor: G.md }} autoFocus autoComplete="off" />
              {amt !== "" && <button onClick={() => { hap(); setAmt(""); aRef.current?.focus(); }} tabIndex={-1} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, color: G.tm, padding: "0 4px", lineHeight: 1 }}>{"\u2715"}</button>}
            </div>


            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: G.t3, textTransform: "uppercase", letterSpacing: 1.5 }}>Category</div>
                <button onClick={openCatMod} title="Customise categories" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: G.tm, padding: "2px 4px", lineHeight: 1, fontWeight: 600 }}>✎ edit</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
                {addCats.map(c => (
                  <button key={c.id} onClick={() => { hap(); setCat(c.id); }} style={{ padding: "8px 4px", borderRadius: 12, cursor: "pointer", fontSize: 12, fontWeight: cat === c.id ? 700 : 500, border: `2px solid ${cat === c.id ? G.bk : G.bdr}`, background: cat === c.id ? G.bk : G.bg, color: cat === c.id ? G.wh : G.t2, textAlign: "center", lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...gujStyle(c.label, 12) }}>
                    {c.icon ? `${c.icon} ${c.label}` : c.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: G.t3, textTransform: "uppercase", letterSpacing: 1.5 }}>Paid via</div>
                <button onClick={openBankMod} title="Manage banks" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: G.tm, padding: "2px 4px", lineHeight: 1, fontWeight: 600 }}>✎ edit</button>
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {payModes.map(p => B(pay === p.id, p.label, () => { hap(); setPay(p.id); }))}
              </div>
            </div>

            <div style={{ position: "relative" }}>
              <input type="text" placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === "Enter") doSave(); }} style={{ width: "100%", padding: "12px 14px", paddingRight: note ? "38px" : "14px", borderRadius: 12, border: `2px solid ${G.bdr}`, fontSize: 16, outline: "none", boxSizing: "border-box", color: G.t1, background: G.bg2 }} autoComplete="off" />
              {note && <button onClick={() => { hap(); setNote(""); }} tabIndex={-1} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", fontSize: 18, color: G.tm, padding: "0 2px", lineHeight: 1, zIndex: 1 }}>{"\u2715"}</button>}
            </div>

            <div>
              {editId && (() => {
                const today = new Date().toISOString().slice(0, 10);
                const shiftDay = (n) => {
                  const d = new Date(editDate + "T12:00:00"); d.setDate(d.getDate() + n);
                  const s = d.toISOString().slice(0, 10); if (s <= today) setEditDate(s);
                };
                const lbl = (() => { const d = new Date(editDate + "T12:00:00"); if (editDate === today) return "Today"; const y = new Date(); y.setDate(y.getDate() - 1); if (sameDay(d, y)) return "Yesterday"; return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" }); })();
                return (
                  <div style={{ display: "flex", alignItems: "center", background: G.bg2, borderRadius: 12, padding: "4px 4px", marginBottom: 6 }}>
                    <button onClick={() => shiftDay(-1)} style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: G.t1, fontWeight: 600 }}>‹</button>
                    <div style={{ flex: 1, textAlign: "center", fontSize: 14, fontWeight: 600, color: G.t1, position: "relative", cursor: "pointer" }}>
                      {lbl}
                      <input type="date" value={editDate} max={today} onChange={e => { if (e.target.value && e.target.value <= today) setEditDate(e.target.value); }} style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer", width: "100%", fontSize: 16 }} />
                    </div>
                    <button onClick={() => shiftDay(1)} disabled={editDate >= today} style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: "transparent", fontSize: 18, cursor: editDate >= today ? "default" : "pointer", color: editDate >= today ? G.tm : G.t1, fontWeight: 600 }}>›</button>
                  </div>
                );
              })()}
              {editId ? (
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => { setEditId(null); setEditDate(""); setAmt(""); setNote(""); setView("list"); }} style={{ flex: 1, padding: "14px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: "transparent", color: G.t2, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                  <button onClick={doSave} style={{ flex: 2, padding: "14px", borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 17, fontWeight: 700, cursor: "pointer" }}>Update</button>
                </div>
              ) : (
                <button onClick={doSave} style={{ width: "100%", padding: "15px", borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 18, fontWeight: 700, cursor: "pointer" }}>Save</button>
              )}
            </div>
          </div>
        )}

        {/* ══════ LIST ══════ */}
        {dbReady && view === "list" && (
          <div style={{ padding: "12px 14px 0" }}>
            {selTrip && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderRadius: 12, background: G.bg2, marginBottom: 10, border: `1px solid ${G.bdr}` }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>Trip: {trips.find(t => t.id === selTrip)?.name}</span>
                <button onClick={() => setSelTrip(null)} style={{ background: "none", border: "none", fontSize: 15, fontWeight: 700, color: G.t3, cursor: "pointer", padding: "4px 8px" }}>{"\u2715"} Clear</button>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", background: G.bg2, borderRadius: 12, padding: "0 14px", marginBottom: 10 }}>
              <span style={{ fontSize: 15, marginRight: 8, color: G.t3 }}>{"\u2315"}</span>
              <input type="text" placeholder="Search amount, note, category, mode..." value={sq} onChange={e => setSq(e.target.value)} style={{ flex: 1, padding: "13px 0", border: "none", outline: "none", fontSize: 16, background: "transparent", color: G.t1 }} />
              {sq && <button onClick={() => setSq("")} style={{ background: "none", border: "none", fontSize: 17, cursor: "pointer", color: G.t3, padding: "4px 6px" }}>{"\u2715"}</button>}
            </div>

            {!selTrip && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, background: G.bg2, borderRadius: 12, padding: "4px 4px" }}>
                {histPeriod !== "all" ? (
                  <button onClick={() => shiftHistPeriod(-1)} style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: G.t1, fontWeight: 600 }}>{"\u2039"}</button>
                ) : <div style={{ width: 36 }} />}
                <button onClick={cycleHistPeriod} style={{ flex: 1, padding: "7px 0", border: "none", background: "transparent", fontSize: 14, fontWeight: 700, cursor: "pointer", color: G.t1, textAlign: "center" }}>{histPeriodLabel}</button>
                {histPeriod !== "all" ? (
                  <button onClick={() => shiftHistPeriod(1)} style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: G.t1, fontWeight: 600 }}>{"\u203A"}</button>
                ) : <div style={{ width: 36 }} />}
              </div>
            )}

            {!selTrip && (
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <select value={fCat} onChange={e => setFCat(e.target.value)} style={{ flex: 1, padding: "11px 10px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, color: G.t2, background: G.bg, outline: "none" }}>
                  <option value="all">All Categories</option>
                  {activeFilterCats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <select value={fPay} onChange={e => setFPay(e.target.value)} style={{ flex: 1, padding: "11px 10px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, color: G.t2, background: G.bg, outline: "none" }}>
                  <option value="all">All Modes</option>
                  {payModes.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 2px", fontSize: 14, color: G.t3, borderBottom: `1px solid ${G.lt}`, marginBottom: 6 }}>
              <span>{filtered.length} entries{filtered.length > 0 && (() => {
                const dates = filtered.map(e => new Date(e.date));
                const oldest = new Date(Math.min(...dates));
                const newest = new Date(Math.max(...dates));
                if (sameDay(oldest, newest)) return ` · ${dayLbl(oldest)}`;
                return ` · ${oldest.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${newest.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;
              })()}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {filtered.length > 0 && (<>
                  <button onClick={doExportXLSX} style={{ background: "none", border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: G.t3, cursor: "pointer", letterSpacing: 0.3 }}>Excel</button>
                  <button onClick={doExportPDF} style={{ background: G.bg2, border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: G.t2, cursor: "pointer", letterSpacing: 0.3 }}>PDF</button>
                </>)}
                <span style={{ fontWeight: 800, fontSize: 16, color: G.t1 }}>{formatINR(filtered.reduce((s, e) => e.category === "investment" ? s : s + e.amount, 0))}</span>
              </div>
            </div>

            {filtered.length === 0 ? (
              <div style={{ textAlign: "center", padding: "50px 0", color: G.tm }}><div style={{ fontSize: 36, marginBottom: 8 }}>{"\u2014"}</div><div style={{ fontSize: 16 }}>No expenses found</div></div>
            ) : (
              <div style={{ paddingBottom: 16 }}>
                {(() => {
                  let ld = "";
                  return filtered.map(exp => {
                    const dl = dayLbl(exp.date);
                    const sd = dl !== ld; ld = dl;
                    const dir = sw.id === exp.id ? sw.dir : null;
                    return (
                      <div key={exp.id}>
                        {sd && <div style={{ fontSize: 12, fontWeight: 700, color: G.tm, textTransform: "uppercase", letterSpacing: 1.2, padding: "12px 2px 5px" }}>{dl}</div>}
                        <div style={{ position: "relative", overflow: "hidden", marginBottom: 5, borderRadius: 12 }}
                          onTouchStart={e => onTS(e, exp.id)} onTouchEnd={onTE}
                          onClick={() => {
                            // Only fires on desktop (touch events set lastTouchTime recently, so skip for touch)
                            if (Date.now() - lastTouchTime.current < 600) return;
                            if (sw.id === exp.id && sw.dir) return; // swiped open
                            const ex = exps.find(x => x.id === exp.id);
                            if (ex) setDetMod(ex);
                          }}
                        >
                          {/* Swipe right → Delete with confirmation */}
                          <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 80, background: swipeConf === exp.id ? "#FF3B30" : G.dk, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1, opacity: dir === "right" ? 1 : 0, transition: "opacity .15s, background .2s", borderRadius: "12px 0 0 12px" }}>
                            <button onClick={() => {
                              if (swipeConf === exp.id) { doDel(exp.id); }
                              else { setSwipeConf(exp.id); setTimeout(() => setSwipeConf(c => c === exp.id ? null : c), 2000); }
                            }} style={{ background: "none", border: "none", color: G.wh, fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                              <span style={{ fontSize: 18 }}>{"\u2715"}</span>
                              {swipeConf === exp.id ? "Sure?" : "Delete"}
                            </button>
                          </div>
                          {/* Swipe left → edit peek panel */}
                          <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 72, background: G.md, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1, opacity: dir === "left" ? 1 : 0, transition: "opacity .15s", borderRadius: "0 12px 12px 0" }}>
                            <button onClick={() => doEdit(exp)} style={{ background: "none", border: "none", color: G.wh, fontWeight: 700, fontSize: 12, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}><span style={{ fontSize: 20 }}>✎</span>Edit</button>
                          </div>
                          <div style={{ ...S.expCard, transform: dir === "left" ? "translateX(-72px)" : dir === "right" ? "translateX(80px)" : "translateX(0)" }}>
                            <div style={S.expIcon}>{getCI(exp)}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 800, fontSize: 17 }}>{formatINR(exp.amount)}</div>
                              <div style={{ fontSize: 14, color: G.t3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...gujStyle(exp.note || getCL(exp), 14) }}>
                                {exp.note || getCL(exp)}<span style={{ marginLeft: 6, fontSize: 12, color: G.tm }}>{"\u00B7"} {getPayLabel(exp.payMode)}</span>
                              </div>
                            </div>
                            <div style={{ fontSize: 12, color: G.tm, flexShrink: 0 }}>{tts(exp.date)}</div>
                          </div>
                        </div>
                      </div>
                    );
                  });
                })()}
              </div>
            )}
          </div>
        )}

        {/* ══════ INSIGHTS ══════ */}
        {dbReady && view === "insights" && (
          <div style={{ padding: "16px 16px" }}>

            {/* Period navigator */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, background: G.bg2, borderRadius: 12, padding: "4px 4px" }}>
              {insPeriod !== "all" ? (
                <button onClick={() => shiftPeriod(-1)}
                  style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: G.t1, fontWeight: 600 }}>‹</button>
              ) : <div style={{ width: 36 }} />}
              <button onClick={cyclePeriod}
                style={{ flex: 1, padding: "7px 0", border: "none", background: "transparent", fontSize: 14, fontWeight: 700, cursor: "pointer", color: G.t1, textAlign: "center" }}>
                {insPeriodLabel}
              </button>
              {insPeriod !== "all" ? (
                <button onClick={() => shiftPeriod(1)}
                  style={{ width: 36, height: 36, borderRadius: 9, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: G.t1, fontWeight: 600 }}>›</button>
              ) : <div style={{ width: 36 }} />}
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 18 }}>
              <div style={{ flex: 1, borderRadius: 14, padding: "14px 14px", background: G.bk, color: G.wh }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: "#888", letterSpacing: 1, textTransform: "uppercase" }}>{insPeriod === "all" ? "All Time" : "Expenses"}</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 5, letterSpacing: -.5 }}>{formatINR(ins.totM)}</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 3 }}>{ins.mc} entries</div>
              </div>
              {!cats.find(c => c.id === "investment")?.hidden && (
              <div style={{ flex: 1, borderRadius: 14, padding: "14px 14px", background: G.bg2, border: `1.5px solid ${G.bdr}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: G.t3, letterSpacing: 1, textTransform: "uppercase" }}>Savings</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 5, letterSpacing: -.5 }}>{formatINR(ins.totI)}</div>
                <div style={{ fontSize: 12, color: G.tm, marginTop: 3 }}>{insPeriod === "all" ? "all time" : insPeriod === "year" ? insYear : new Date(insMonth.year, insMonth.month).toLocaleDateString("en-IN", { month: "short" })}</div>
              </div>
              )}
            </div>

            {/* Exclude trips toggle */}
            {ins.hasTripInPeriod && (
              <div onClick={() => setInsExTrips(p => !p)} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, cursor: "pointer", padding: "8px 12px", background: insExTrips ? "#F0F7FF" : G.bg2, borderRadius: 10, border: `1.5px solid ${insExTrips ? "#4A90D9" : G.bdr}` }}>
                <div style={{ width: 18, height: 18, borderRadius: 5, border: `2px solid ${insExTrips ? "#4A90D9" : G.bdr}`, background: insExTrips ? "#4A90D9" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#FFF", fontWeight: 700, flexShrink: 0 }}>{insExTrips ? "✓" : ""}</div>
                <span style={{ fontSize: 14, fontWeight: 600, color: insExTrips ? "#4A90D9" : G.t2 }}>Exclude trips</span>
                <span style={{ fontSize: 12, color: G.tm, marginLeft: "auto" }}>high-value single categories</span>
              </div>
            )}

            {/* Mindful Insights card — only for eligible users */}
            {mindfulReport && mindfulReport.periodEntryCount > 0 && (
              <div style={{ marginBottom: 18, background: G.bg2, borderRadius: 14, padding: "16px 14px", border: `1px solid ${G.bdr}` }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Mindful — {mindfulReport.scopeLabel}</div>

                {/* Essential vs Discretionary bar */}
                <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: G.t3, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8 }}>Essential</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#34C759" }}>{formatINR(mindfulReport.essentialSpend)}</div>
                    <div style={{ fontSize: 12, color: G.tm }}>{Math.round((1 - mindfulReport.discretionaryPct) * 100)}%</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: G.t3, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8 }}>Discretionary</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#FF9500" }}>{formatINR(mindfulReport.discretionarySpend)}</div>
                    <div style={{ fontSize: 12, color: G.tm }}>{Math.round(mindfulReport.discretionaryPct * 100)}%</div>
                  </div>
                </div>
                {/* Stacked bar */}
                <div style={{ height: 8, borderRadius: 4, background: G.bg3, overflow: "hidden", display: "flex", marginBottom: 16 }}>
                  <div style={{ width: `${Math.round((1 - mindfulReport.discretionaryPct) * 100)}%`, background: "#34C759", borderRadius: "4px 0 0 4px", transition: "width .4s" }} />
                  <div style={{ flex: 1, background: "#FF9500", borderRadius: "0 4px 4px 0" }} />
                </div>

                {/* Top avoidable items */}
                {mindfulReport.topAvoidable.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, color: G.t3, marginBottom: 8, fontWeight: 600 }}>
                      Top {mindfulReport.topAvoidable.length} item{mindfulReport.topAvoidable.length > 1 ? "s" : ""} = {Math.round(mindfulReport.topAvoidablePctOfDisc * 100)}% of discretionary
                    </div>
                    {mindfulReport.topAvoidable.map((e, i) => {
                      const catObj = e.category === "uncategorized" ? UNCAT : (allCats.find(c => c.id === e.category) || { label: e.category, icon: "?" });
                      const d = new Date(e.date);
                      const isWe = d.getDay() === 0 || d.getDay() === 6;
                      const baseAvg = isWe
                        ? (mindfulReport.baselines?.weekendAvgByCat?.[e.category] || 0)
                        : (mindfulReport.baselines?.weekdayAvgByCat?.[e.category] || 0);
                      const ratio = baseAvg > 0 ? (e.amount / baseAvg) : 0;
                      const dayLabel = d.toLocaleDateString("en-IN", { weekday: "short" });
                      const hr = d.getHours();
                      const timeLabel = hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening";
                      return (
                        <div key={e.id} style={{ padding: "10px 0", borderTop: i > 0 ? `1px solid ${G.bg3}` : "none" }}>
                          <div onClick={() => setDetMod(e)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 14, fontWeight: 700, color: G.t1 }}>{formatINR(e.amount)}<span style={{ fontWeight: 400, color: G.t2, marginLeft: 8, fontSize: 13 }}>{e.note || "—"}</span></div>
                              <div style={{ fontSize: 11, color: G.tm, marginTop: 2 }}>
                                {catObj.icon} {catObj.label} · {dayLabel} {timeLabel}
                                {ratio >= 1.5 && <span style={{ color: "#FF9500", fontWeight: 600 }}> · {ratio.toFixed(1)}× {isWe ? "wkend" : "wkday"} avg</span>}
                              </div>
                            </div>
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                            <button onClick={() => { hap(); markMindfulSig(e.sig, "essential"); sToast("Marked essential"); }}
                              style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${G.bdr}`, background: G.bg, fontSize: 11, fontWeight: 600, color: "#34C759", cursor: "pointer" }}>Essential</button>
                            <button onClick={() => { hap(); markMindfulSig(e.sig, "avoidable"); sToast("Noted — we'll keep flagging"); }}
                              style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${G.bdr}`, background: G.bg, fontSize: 11, fontWeight: 600, color: "#FF9500", cursor: "pointer" }}>✓ Avoidable</button>
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}

                {/* Trip summary */}
                {mindfulReport.trips.length > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${G.bg3}` }}>
                    <div style={{ fontSize: 12, color: G.t3, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.8 }}>Trips (shown separately)</div>
                    {mindfulReport.trips.map(t => (
                      <div key={t.tripId} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginBottom: 4 }}>
                        <span>✈️ {t.name}</span>
                        <span style={{ fontWeight: 700 }}>{formatINR(t.spend)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Monthly popup toggle */}
                <div onClick={() => { hap(); saveMindfulPrefs({ autoMonthlyPopup: !mindfulPrefs.autoMonthlyPopup }); }}
                  style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, paddingTop: 10, borderTop: `1px solid ${G.bg3}`, cursor: "pointer" }}>
                  <div style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${mindfulPrefs.autoMonthlyPopup ? "#007AFF" : G.bdr}`, background: mindfulPrefs.autoMonthlyPopup ? "#007AFF" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#FFF", fontWeight: 700, flexShrink: 0 }}>{mindfulPrefs.autoMonthlyPopup ? "✓" : ""}</div>
                  <span style={{ fontSize: 12, color: G.t3 }}>Pop this up at the start of each month</span>
                </div>
              </div>
            )}

            {/* Pie Chart */}
            {Object.keys(ins.bc).length > 0 && (() => {
              const entries = Object.entries(ins.bc).sort((a, b) => b[1] - a[1]);
              const total = ins.totM || 1;
              let cumAngle = 0;
              const slices = entries.map(([cid, amt]) => {
                const frac = amt / total;
                const startAngle = cumAngle;
                cumAngle += frac * 360;
                const endAngle = cumAngle;
                const startRad = (startAngle - 90) * Math.PI / 180;
                const endRad = (endAngle - 90) * Math.PI / 180;
                const largeArc = frac > 0.5 ? 1 : 0;
                const x1 = 50 + 45 * Math.cos(startRad), y1 = 50 + 45 * Math.sin(startRad);
                const x2 = 50 + 45 * Math.cos(endRad), y2 = 50 + 45 * Math.sin(endRad);
                const d = frac >= 0.999
                  ? `M 50 5 A 45 45 0 1 1 49.99 5 Z`
                  : `M 50 50 L ${x1} ${y1} A 45 45 0 ${largeArc} 1 ${x2} ${y2} Z`;
                const catObj = cid === "uncategorized" ? UNCAT : (allCats.find(x => x.id === cid) || cats[0] || { label: "Other" });
                return { cid, d, color: catColorMap[cid] || "#8E8E93", label: catObj.label, pct: Math.round(frac * 100) };
              });
              return (
                <div style={{ marginBottom: 22, background: G.bg2, borderRadius: 14, padding: "16px 14px", border: `1px solid ${G.bdr}` }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Spending Breakdown</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                    <svg viewBox="0 0 100 100" style={{ width: 130, height: 130, flexShrink: 0 }}>
                      {slices.map((s, i) => <path key={i} d={s.d} fill={s.color} />)}
                      <circle cx="50" cy="50" r="22" fill={G.bg2} />
                    </svg>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {slices.slice(0, 6).map((s, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: s.color, flexShrink: 0 }} />
                          <span style={{ fontSize: 12, color: G.t2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, ...gujStyle(s.label, 12) }}>{s.label}</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: G.t1, flexShrink: 0 }}>{s.pct}%</span>
                        </div>
                      ))}
                      {slices.length > 6 && <div style={{ fontSize: 11, color: G.tm }}>+{slices.length - 6} more</div>}
                    </div>
                  </div>
                </div>
              );
            })()}

            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>By Category <span style={{ fontSize: 12, color: G.tm, fontWeight: 400 }}>· tap to filter history</span></div>
              {(() => { return Object.entries(ins.bc).sort((a, b) => b[1] - a[1]).map(([cid, a]) => {
                const c = cid === "uncategorized" ? UNCAT : (allCats.find(x => x.id === cid) || cats[0]);
                const p = ins.totM > 0 ? (a / ins.totM * 100) : 0;
                const barCol = catColorMap[cid] || "#8E8E93";
                return (
                  <div key={cid} onClick={() => { hap(); setSelTrip(null); setFPay("all"); setSq(""); setFCat(cid); setHistPeriod(insPeriod); setHistMonth(insMonth); setHistYear(insYear); try { localStorage.setItem("histPeriod", insPeriod); localStorage.setItem("histMonth", JSON.stringify(insMonth)); localStorage.setItem("histYear", String(insYear)); } catch {} setSw({ id: null, dir: null }); setSwipeConf(null); setView("list"); }} style={{ marginBottom: 14, cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: G.t2, marginBottom: 5 }}><span style={gujStyle(c.label, 15)}>{c.icon} {c.label}</span><span style={{ fontWeight: 700, color: G.t1 }}>{formatINR(a)}</span></div>
                    <div style={{ height: 7, background: G.bg3, borderRadius: 8, overflow: "hidden" }}><div style={{ height: 7, borderRadius: 8, background: barCol, width: `${p}%`, transition: "width .4s" }} /></div>
                    <div style={{ fontSize: 12, color: G.tm, marginTop: 3, textAlign: "right" }}>{Math.round(p)}%</div>
                  </div>
                );
              }); })()}
              {Object.keys(ins.bc).length === 0 && <div style={{ color: G.tm, padding: "14px 0", fontSize: 15 }}>No data for this period</div>}
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>By Payment Mode <span style={{ fontSize: 12, color: G.tm, fontWeight: 400 }}>{"\u00B7"} tap to filter history</span></div>
              {(() => { const PAY_COLORS = ["#3498DB", "#2ECC71", "#E74C3C", "#F39C12", "#9B59B6", "#1ABC9C"]; return Object.entries(ins.bp).sort((a, b) => b[1] - a[1]).map(([pid, a], i) => {
                const p = ins.totM > 0 ? (a / ins.totM * 100) : 0;
                return (<div key={pid} onClick={() => { hap(); setSelTrip(null); setFCat("all"); setSq(""); setFPay(pid); setHistPeriod(insPeriod); setHistMonth(insMonth); setHistYear(insYear); try { localStorage.setItem("histPeriod", insPeriod); localStorage.setItem("histMonth", JSON.stringify(insMonth)); localStorage.setItem("histYear", String(insYear)); } catch {} setSw({ id: null, dir: null }); setSwipeConf(null); setView("list"); }} style={{ marginBottom: 14, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: G.t2, marginBottom: 5 }}><span>{getPayLabel(pid)}</span><span style={{ fontWeight: 700, color: G.t1 }}>{formatINR(a)}</span></div>
                  <div style={{ height: 7, background: G.bg3, borderRadius: 8, overflow: "hidden" }}><div style={{ height: 7, borderRadius: 8, background: PAY_COLORS[i % PAY_COLORS.length], width: `${p}%`, transition: "width .4s" }} /></div>
                  <div style={{ fontSize: 12, color: G.tm, marginTop: 3, textAlign: "right" }}>{Math.round(p)}%</div>
                </div>);
              }); })()}
            </div>

            {/* Yearly bar chart — monthly breakdown (at end, trailing NIL months trimmed) */}
            {insPeriod === "year" && yearlyBars.length > 0 && (() => {
              const lastIdx = yearlyBars.reduce((last, b, i) => b.total > 0 ? i : last, -1);
              const displayBars = lastIdx >= 0 ? yearlyBars.slice(0, lastIdx + 1) : [];
              if (displayBars.length === 0) return null;
              const maxVal = Math.max(...displayBars.map(b => b.total), 1);
              const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
              return (
                <div style={{ marginBottom: 22, background: G.bg2, borderRadius: 14, padding: "16px 14px", border: `1px solid ${G.bdr}` }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Monthly Breakdown</div>
                  {displayBars.map((b, i) => (
                    <div key={i} onClick={() => { setInsPeriod("month"); setInsMonth({ year: insYear, month: i }); }} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, cursor: "pointer" }}>
                      <span style={{ width: 28, fontSize: 11, fontWeight: 600, color: G.t3, flexShrink: 0 }}>{mNames[i]}</span>
                      <div style={{ flex: 1, height: 18, background: G.bg3, borderRadius: 6, overflow: "hidden" }}>
                        <div style={{ height: 18, borderRadius: 6, background: b.total > 0 ? G.dk : "transparent", width: `${(b.total / maxVal) * 100}%`, transition: "width .4s" }} />
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 600, color: b.total > 0 ? G.t1 : G.tm, minWidth: 55, textAlign: "right" }}>{b.total > 0 ? formatINR(b.total) : "—"}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, padding: "8px 0 0", borderTop: `1px solid ${G.lt}` }}>
                    <span style={{ fontSize: 13, color: G.t3 }}>Avg/month</span>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{formatINR(Math.round(ins.totM / (displayBars.filter(b => b.total > 0).length || 1)))}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ══════ TRIPS LIST ══════ */}
        {dbReady && view === "trips" && !tripDet && (
          <div style={{ padding: "14px 16px" }}>
            <button onClick={() => { setTripMod(true); setEditTripId(null); setTName(""); setTBudg(""); }} style={{ width: "100%", padding: "14px", borderRadius: 12, border: `2px dashed ${G.bdr}`, background: "transparent", color: G.t2, fontSize: 16, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>+ New Trip</button>

            {activeTrips.length > 0 && <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: G.tm, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>Active</div>
              {activeTrips.map(t => { const te = exps.filter(e => e.tripId === t.id); const tot = te.reduce((s, e) => s + e.amount, 0); const pct = t.budget > 0 ? (tot / t.budget) * 100 : 0; const barCol = pct > 100 ? "#FF3B30" : pct > 90 ? "#FF3B30" : pct > 70 ? "#FF9500" : "#34C759"; return (
                <div key={t.id} onClick={() => setTripDet(t.id)} style={{ background: G.bg2, borderRadius: 12, padding: "14px 16px", marginBottom: 8, borderLeft: `4px solid ${G.bk}`, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div><div style={{ fontWeight: 700, fontSize: 17 }}>{t.name}</div><div style={{ color: G.t3, fontSize: 14, marginTop: 2 }}>{te.length} entries {"\u00B7"} {formatINR(tot)}{t.budget > 0 && ` / ${formatINR(t.budget)}`}</div></div>
                    <span style={{ color: G.tm, fontSize: 18 }}>{"\u203A"}</span>
                  </div>
                  {t.budget > 0 && <div style={{ marginTop: 10 }}>
                    <div style={{ height: 5, background: G.bg3, borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ height: 5, borderRadius: 5, background: barCol, width: `${Math.min(100, pct)}%`, transition: "width .4s" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: G.tm, marginTop: 4 }}>
                      <span style={{ color: barCol, fontWeight: 600 }}>{Math.round(pct)}% used</span>
                      <span>{tot > t.budget ? `${formatINR(tot - t.budget)} over` : `${formatINR(t.budget - tot)} left`}</span>
                    </div>
                  </div>}
                </div>);
              })}
            </div>}

            {inactiveTrips.length > 0 && <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: G.tm, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>Hidden (7+ days inactive)</div>
              {inactiveTrips.map(t => { const te = exps.filter(e => e.tripId === t.id); const tot = te.reduce((s, e) => s + e.amount, 0); const pct = t.budget > 0 ? (tot / t.budget) * 100 : 0; const barCol = pct > 100 ? "#FF3B30" : pct > 90 ? "#FF3B30" : pct > 70 ? "#FF9500" : "#34C759"; return (
                <div key={t.id} onClick={() => setTripDet(t.id)} style={{ background: G.bg2, borderRadius: 12, padding: "14px 16px", marginBottom: 8, borderLeft: `4px solid ${G.lt}`, cursor: "pointer", opacity: .7 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div><div style={{ fontWeight: 700, fontSize: 17 }}>{t.name}</div><div style={{ color: G.t3, fontSize: 14, marginTop: 2 }}>{te.length} entries {"\u00B7"} {formatINR(tot)}{t.budget > 0 && ` / ${formatINR(t.budget)}`}</div></div>
                    <span style={{ color: G.tm, fontSize: 18 }}>{"\u203A"}</span>
                  </div>
                  {t.budget > 0 && <div style={{ marginTop: 10 }}>
                    <div style={{ height: 5, background: G.bg3, borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ height: 5, borderRadius: 5, background: barCol, width: `${Math.min(100, pct)}%`, transition: "width .4s" }} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: G.tm, marginTop: 4 }}>
                      <span style={{ color: barCol, fontWeight: 600 }}>{Math.round(pct)}% used</span>
                      <span>{tot > t.budget ? `${formatINR(tot - t.budget)} over` : `${formatINR(t.budget - tot)} left`}</span>
                    </div>
                  </div>}
                </div>);
              })}
            </div>}

            {activeTrips.length === 0 && inactiveTrips.length === 0 && <div style={{ textAlign: "center", padding: "40px 0", color: G.tm, fontSize: 16 }}>No trips yet</div>}
          </div>
        )}

        {/* ══════ TRIP DETAIL ══════ */}
        {dbReady && view === "trips" && tripDet && (() => {
          const trip = trips.find(t => t.id === tripDet);
          if (!trip) return null;
          const act = getTAct(trip);
          const ti = getTI(tripDet);
          const cd = canDelTrip(trip);
          return (
            <div style={{ padding: "14px 16px" }}>
              <button onClick={() => { setTripDet(null); setConfDel(null); }} style={{ background: "none", border: "none", fontSize: 16, fontWeight: 600, color: G.t3, cursor: "pointer", padding: "4px 0", marginBottom: 10 }}>{"\u2190"} All Trips</button>

              <div style={{ background: G.bk, borderRadius: 14, padding: "20px 18px", color: G.wh, marginBottom: 14 }}>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -.5 }}>{trip.name}</div>
                <div style={{ display: "flex", gap: 16, marginTop: 10, fontSize: 14, color: "#999" }}>
                  <span>{ti.cnt} expenses</span><span>{ti.d} day{ti.d !== 1 ? "s" : ""}</span>
                  <span style={{ fontWeight: 700, color: G.wh }}>~{formatINR(ti.avg)}/day</span>
                </div>
                <div style={{ fontSize: 30, fontWeight: 800, marginTop: 12, letterSpacing: -1 }}>{formatINR(ti.tot)}</div>
                {trip.budget > 0 && (() => {
                  const pct = (ti.tot / trip.budget) * 100;
                  const remaining = trip.budget - ti.tot;
                  const over = remaining < 0;
                  const barCol = pct > 100 ? "#FF3B30" : pct > 90 ? "#FF3B30" : pct > 70 ? "#FF9500" : "#34C759";
                  return (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>Budget: {formatINR(trip.budget)}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: over ? "#FF6B6B" : "#AAA" }}>{over ? `${formatINR(Math.abs(remaining))} over` : `${formatINR(remaining)} left`}</span>
                      </div>
                      <div style={{ height: 8, background: "#2A2A2A", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ height: 8, borderRadius: 8, background: barCol, width: `${Math.min(100, pct)}%`, transition: "width .6s ease" }} />
                      </div>
                      <div style={{ fontSize: 12, color: barCol, fontWeight: 600, marginTop: 5, textAlign: "right" }}>{Math.round(pct)}% used</div>
                    </div>
                  );
                })()}
              </div>

              <div style={{ background: G.bg2, borderRadius: 12, padding: 16, marginBottom: 14, border: `1px solid ${G.bdr}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Payment Breakdown</div>
                {Object.entries(ti.byPay).sort((a, b) => b[1] - a[1]).map(([pid, amt]) => (
                  <div key={pid} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 15, color: G.t2 }}>{getPayLabel(pid)}</span><span style={{ fontSize: 15, fontWeight: 700 }}>{formatINR(amt)}</span></div>
                ))}
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <button onClick={() => viewTH(tripDet)} style={{ flex: 1, padding: "13px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>View All Entries</button>
                {act.isActive && trip.pinned && (
                  <button onClick={() => unpinT(tripDet)} style={{ padding: "13px 18px", borderRadius: 12, border: "none", background: G.bk, color: G.wh, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Unpin</button>
                )}
                {!act.isActive && !trip.pinned && (
                  <button onClick={() => pinT(tripDet)} style={{ padding: "13px 18px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t2, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Pin</button>
                )}
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { setEditTripId(trip.id); setTName(trip.name); setTBudg(trip.budget?.toString() || ""); setTripMod(true); }} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t2, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Edit Trip</button>
                {cd ? (
                  confDel === tripDet
                    ? <button onClick={() => doDelTrip(trip)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: G.dk, color: G.wh, fontSize: 15, fontWeight: 700, cursor: "pointer" }}>Confirm Delete</button>
                    : <button onClick={() => setConfDel(tripDet)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t3, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Delete Trip</button>
                ) : (
                  <div style={{ flex: 1, padding: "12px", borderRadius: 12, border: `1px solid ${G.lt}`, background: G.bg2, color: G.tm, fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>Delete locked</div>
                )}
              </div>
            </div>
          );
        })()}
      </main>

      {/* ══════ DETAIL MODAL ══════ */}
      {detMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => setDetMod(null)}>
          <div
            onTouchStart={e => { mRef.current.sy = e.touches[0].clientY; }}
            onTouchEnd={e => { if (e.changedTouches[0].clientY - mRef.current.sy > 80) setDetMod(null); }}
            style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 36px" }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt, margin: "0 auto 18px" }} />
            <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: -1, marginBottom: 16 }}>{formatINR(detMod.amount)}</div>
            {[["Category", getCL(detMod)], ["Payment", getPayLabel(detMod.payMode)], ["Note", detMod.note || "\u2014"], ["Date", tfd(detMod.date)], ["Time", tts(detMod.date)]].map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "11px 0", borderBottom: `1px solid ${G.lt}`, fontSize: 16 }}>
                <span style={{ color: G.t3, fontWeight: 500 }}>{l}</span><span style={{ color: G.t1, fontWeight: 600, textAlign: "right", maxWidth: "60%", ...(l === "Category" || l === "Note" ? gujStyle(v, 16) : {}) }}>{v}</span>
              </div>
            ))}
            {detMod.category === "uncategorized" && (
              <button onClick={() => doEdit(detMod)} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: "#FF9500", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer", marginTop: 16, marginBottom: -4 }}>Categorize This Expense</button>
            )}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              <button onClick={() => doEdit(detMod)} style={{ flex: 1, padding: "14px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t1, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Edit</button>
              <button onClick={() => doDel(detMod.id)} style={{ flex: 1, padding: "14px", borderRadius: 12, border: "none", background: G.dk, color: G.wh, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ TRIP MODAL ══════ */}
      {tripMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => setTripMod(false)}>
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 36px" }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt, margin: "0 auto 16px" }} />
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 18 }}>{editTripId ? "Edit Trip" : "New Trip"}</div>
            <input type="text" placeholder="Trip name" value={tName} onChange={e => setTName(e.target.value)} style={{ width: "100%", padding: 14, borderRadius: 12, border: `2px solid ${G.bdr}`, fontSize: 17, outline: "none", boxSizing: "border-box", color: G.t1, background: G.bg2, marginBottom: 10 }} autoFocus />
            <input type="tel" inputMode="numeric" placeholder="Budget (optional)" value={tBudg} onChange={e => setTBudg(e.target.value.replace(/[^0-9]/g, ""))} style={{ width: "100%", padding: 14, borderRadius: 12, border: `2px solid ${G.bdr}`, fontSize: 17, outline: "none", boxSizing: "border-box", color: G.t1, background: G.bg2, marginBottom: 16 }} />
            <button onClick={doSaveTrip} style={{ width: "100%", padding: 16, borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 18, fontWeight: 700, cursor: "pointer" }}>{editTripId ? "Update Trip" : "Create Trip"}</button>
          </div>
        </div>
      )}

      {/* ══════ KEY MODAL ══════ */}
      {keyMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => setKeyMod(false)}>
          <div
            onTouchStart={e => { mRef.current.ky = e.touches[0].clientY; mRef.current.kyScroll = e.currentTarget.scrollTop; }}
            onTouchEnd={e => { if (mRef.current.kyScroll === 0 && e.changedTouches[0].clientY - mRef.current.ky > 80) setKeyMod(false); }}
            style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 0", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ width: 30 }} />
              <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt }} />
              <button onClick={() => setKeyMod(false)} style={{ background: "none", border: "none", fontSize: 20, color: G.t3, cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>{"\u2715"}</button>
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>SMS Automation</div>
            <div style={{ fontSize: 14, color: G.t3, marginBottom: 16, lineHeight: 1.5 }}>
              Auto-log bank SMS as expenses. Generate your API key, then follow the setup for your phone.
            </div>

            {/* API Key Section */}
            {userKey ? (
              <>
                <div style={{ display: "flex", alignItems: "center", background: G.bg2, borderRadius: 12, padding: "14px 16px", marginBottom: 8, gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: G.t3, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 }}>Your Key</div>
                    <span style={{ fontFamily: "monospace", fontSize: 22, fontWeight: 800, letterSpacing: 3, color: G.t1 }}>{userKey}</span>
                  </div>
                  <button onClick={copyKey} style={{ background: G.bk, color: G.wh, border: "none", borderRadius: 8, padding: "8px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", flexShrink: 0, marginLeft: "auto" }}>Copy</button>
                </div>
                <div style={{ fontSize: 12, color: G.t3, marginBottom: 8, lineHeight: 1.4 }}>Copy this key. The shortcuts will ask for it <b>once</b> on first run, then save it to iCloud Drive automatically — you will never be asked again.</div>
                <button onClick={handleGenerateKey} disabled={keyLoading}
                  style={{ width: "100%", padding: "10px", borderRadius: 10, border: `1.5px solid ${G.bdr}`, background: G.bg, color: G.t3, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>
                  {keyLoading ? "Generating\u2026" : "Regenerate Key"}
                </button>
              </>
            ) : (
              <button onClick={handleGenerateKey} disabled={keyLoading}
                style={{ width: "100%", padding: "16px", borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 17, fontWeight: 700, cursor: "pointer", marginBottom: 16 }}>
                {keyLoading ? "Generating\u2026" : "Generate Key"}
              </button>
            )}

            {/* Platform Tabs */}
            <div style={{ display: "flex", background: G.bg2, borderRadius: 10, padding: 3, marginBottom: 16 }}>
              {[["ios", "iPhone"], ["android", "Android"]].map(([id, label]) => (
                <button key={id} onClick={() => setSetupTab(id)} style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, background: setupTab === id ? G.bk : "transparent", color: setupTab === id ? G.wh : G.t3 }}>{label}</button>
              ))}
            </div>

            {/* iPhone Setup */}
            {setupTab === "ios" && (
              <div style={{ background: G.bg2, borderRadius: 12, padding: "16px 16px", fontSize: 13, color: G.t2, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>iPhone Shortcuts Setup</div>

                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, color: G.t1, marginBottom: 4 }}>Step 1: Add Shortcuts</div>
                  <div style={{ marginBottom: 6 }}>Add both shortcuts to your iPhone. On first run each will ask for your key once, then save it to <b>iCloud Drive → Shortcuts</b> — never asked again.</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
                    <a href={SHORTCUT_ICLOUD_URL} target="_blank" rel="noopener noreferrer"
                      style={{ flex: 1, padding: "12px", borderRadius: 10, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t1, fontSize: 13, fontWeight: 700, textAlign: "center", textDecoration: "none", cursor: "pointer" }}>
                      Bank Expense {"\u2192"}
                    </a>
                    <a href={CASH_SHORTCUT_URL} target="_blank" rel="noopener noreferrer"
                      style={{ flex: 1, padding: "12px", borderRadius: 10, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t1, fontSize: 13, fontWeight: 700, textAlign: "center", textDecoration: "none", cursor: "pointer" }}>
                      Cash Expense {"\u2192"}
                    </a>
                  </div>
                  <div style={{ fontSize: 12, color: G.t3, marginTop: 4, lineHeight: 1.5 }}>
                    <b>Bank Expense</b> — auto-logs bank SMS debits. Set up an automation so it runs silently on every bank message.{"\n"}
                    <b>Cash Expense</b> — tap to manually log a cash spend: enter amount, pick category, add note.
                  </div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, color: G.t1, marginBottom: 4 }}>Step 2: Automate Bank SMS</div>
                  <div>Open <b>Shortcuts</b> app {"\u2192"} <b>Automation</b> tab {"\u2192"} <b>+</b></div>
                  <div>Select <b>Message</b> trigger</div>
                  <div style={{ background: G.bg, borderRadius: 8, padding: "10px 12px", marginTop: 6, fontSize: 12, lineHeight: 1.7 }}>
                    <div><b>Sender contains:</b> your bank SMS ID (e.g. "HDFCBK")</div>
                    <div><b>Message contains:</b> "debited"</div>
                  </div>
                  <div style={{ marginTop: 6 }}>Set the action:</div>
                  <div style={{ background: G.bg, borderRadius: 8, padding: "10px 12px", marginTop: 4, fontSize: 12, lineHeight: 1.7 }}>
                    <div><b>Run Shortcut</b> {"\u2192"} select "Bank Expense"</div>
                    <div><b>Input:</b> Message (the SMS body)</div>
                  </div>
                  <div style={{ marginTop: 6 }}>Turn off <b>"Ask Before Running"</b></div>
                </div>

                <div style={{ fontSize: 12, color: G.t3, borderTop: `1px solid ${G.lt}`, paddingTop: 10, lineHeight: 1.5 }}>
                  Tip: Add one automation per bank — they all use the same "Bank Expense" shortcut. Your key is stored once in iCloud Drive and shared across both shortcuts automatically.
                </div>
              </div>
            )}

            {/* Android Setup */}
            {setupTab === "android" && (
              <div style={{ background: G.bg2, borderRadius: 12, padding: "16px 16px", fontSize: 13, color: G.t2, lineHeight: 1.8 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Android Setup (MacroDroid)</div>

                <a href="https://play.google.com/store/apps/details?id=com.arlosoft.macrodroid" target="_blank" rel="noopener noreferrer"
                  style={{ display: "block", padding: "12px", borderRadius: 10, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t1, fontSize: 14, fontWeight: 700, textAlign: "center", textDecoration: "none", marginBottom: 12, cursor: "pointer" }}>
                  Get MacroDroid (Free) {"\u2192"}
                </a>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, color: G.t1, marginBottom: 4 }}>Setup Steps</div>
                  <div>1. Install <b>MacroDroid</b> from Play Store</div>
                  <div>2. Tap <b>Add Macro</b> {"\u2192"} <b>Trigger</b> {"\u2192"} <b>SMS Received</b></div>
                  <div>3. Set sender filter to your bank (e.g. "HDFCBK")</div>
                  <div>4. Optionally add content filter: "debited"</div>
                  <div>5. <b>Action</b> {"\u2192"} <b>HTTP Request</b></div>
                </div>

                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, color: G.t1, marginBottom: 4 }}>HTTP Request Settings</div>
                  <div style={{ background: G.bg, borderRadius: 8, padding: "10px 12px", fontSize: 12, lineHeight: 1.7 }}>
                    <div><b>Method:</b> POST</div>
                    <div><b>URL:</b> <span style={{ fontFamily: "monospace", fontSize: 11 }}>{API_BASE}/api/log-sms</span></div>
                    <div><b>Content-Type:</b> application/json</div>
                    <div><b>Body:</b></div>
                    <div style={{ fontFamily: "monospace", fontSize: 11, background: G.bg2, padding: "8px", borderRadius: 6, marginTop: 4, wordBreak: "break-all" }}>
                      {`{"sms":"[sms_body]","key":"${userKey || "YOUR_KEY"}","category":"personal"}`}
                    </div>
                    <div style={{ fontSize: 11, color: G.t3, marginTop: 4 }}>[sms_body] is a MacroDroid built-in variable for SMS text.</div>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: G.t3, borderTop: `1px solid ${G.lt}`, paddingTop: 10 }}>
                  Note: MacroDroid free tier allows 5 macros. You only need 1 for this. For category selection, use "personal" as default — or set up a Tasker/MacroDroid popup to pick before sending.
                </div>
              </div>
            )}

            {/* API Endpoint */}
            <div style={{ display: "flex", alignItems: "center", background: G.bg2, borderRadius: 10, padding: "10px 14px", marginTop: 14, gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: G.t3, letterSpacing: 1, textTransform: "uppercase" }}>API Endpoint</div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: G.t2, marginTop: 2, wordBreak: "break-all" }}>{API_BASE}/api/log-sms</div>
              </div>
              <button onClick={() => copyText(`${API_BASE}/api/log-sms`)} style={{ background: G.bk, color: G.wh, border: "none", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Copy</button>
            </div>
            {/* Sticky close button at bottom */}
            <div style={{ position: "sticky", bottom: 0, background: G.bg, paddingTop: 10, paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 20px)", paddingLeft: 0, paddingRight: 0, borderTop: `1px solid ${G.lt}`, marginTop: 14 }}>
              <button onClick={() => setKeyMod(false)} style={{ width: "100%", padding: "14px", borderRadius: 14, border: "none", background: G.bg2, color: G.t1, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ CATEGORY EDIT MODAL ══════ */}
      {catMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => { setCatMod(false); if (onboardReturn.current !== null) { setOnboardStep(onboardReturn.current); onboardReturn.current = null; onboardAdvance.current = null; } }}>
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt, margin: "0 auto 18px" }} />
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Customise Categories</div>
            <div style={{ fontSize: 13, color: G.t3, marginBottom: 20 }}>Change labels, icons, hide or add new categories.</div>
            {editCats.map((c, i) => {
              const isProtected = c.id === "investment"; // only savings is protected
              return (
              <div key={c.id}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: c.id === "investment" ? 4 : 10, opacity: c.hidden ? 0.45 : 1 }}>
                  {/* Reorder arrows */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, flexShrink: 0 }}>
                    <button onClick={() => { if (i > 0) setEditCats(p => { const a = [...p]; [a[i-1], a[i]] = [a[i], a[i-1]]; return a; }); }} disabled={i === 0} style={{ background: "none", border: "none", cursor: i > 0 ? "pointer" : "default", fontSize: 14, color: i > 0 ? G.t2 : G.bg3, padding: 0, lineHeight: 1 }}>{"\u25B2"}</button>
                    <button onClick={() => { if (i < editCats.length - 1) setEditCats(p => { const a = [...p]; [a[i], a[i+1]] = [a[i+1], a[i]]; return a; }); }} disabled={i === editCats.length - 1} style={{ background: "none", border: "none", cursor: i < editCats.length - 1 ? "pointer" : "default", fontSize: 14, color: i < editCats.length - 1 ? G.t2 : G.bg3, padding: 0, lineHeight: 1 }}>{"\u25BC"}</button>
                  </div>
                  <input type="text" value={c.icon} onChange={e => setEditCats(p => p.map((x, j) => j === i ? { ...x, icon: e.target.value } : x))} maxLength={2} style={{ width: 40, padding: "10px 0", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 20, outline: "none", textAlign: "center", background: G.bg2, color: G.t1, boxSizing: "border-box", flexShrink: 0 }} />
                  <input type="text" value={c.label} onChange={e => setEditCats(p => p.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} maxLength={14} placeholder="Category name" style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, outline: "none", background: G.bg2, color: G.t1, boxSizing: "border-box", minWidth: 0 }} />
                  <button onClick={() => setEditCats(p => p.map((x, j) => j === i ? { ...x, hidden: !x.hidden } : x))} style={{ width: 36, height: 36, borderRadius: 10, border: `2px solid ${c.hidden ? G.lt : G.bdr}`, background: c.hidden ? G.bg3 : G.bg, color: c.hidden ? G.tm : G.t2, fontSize: 15, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }} title={c.hidden ? "Show" : "Hide"}>{c.hidden ? "\u25CB" : "\u25CF"}</button>
                  {!isProtected && <button onClick={() => setEditCats(p => p.filter((_, j) => j !== i))} style={{ width: 36, height: 36, borderRadius: 10, border: `2px solid ${G.bdr}`, background: G.bg, color: "#FF3B30", fontSize: 16, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }} title="Remove">{"\u2715"}</button>}
                </div>
                {c.id === "investment" && <div style={{ fontSize: 11, color: "#E08700", marginBottom: 10, marginLeft: 46, lineHeight: 1.3 }}>This category tracks savings & investments. Name it accordingly.</div>}
              </div>);
            })}
            {editCats.length < 8 && (
              <button onClick={() => setEditCats(p => [...p, { id: "custom_" + Date.now().toString(36), label: "", icon: "📌", hidden: false }])} style={{ width: "100%", padding: "11px", borderRadius: 10, border: `2px dashed ${G.bdr}`, background: "transparent", color: G.t3, fontSize: 15, fontWeight: 600, cursor: "pointer", marginBottom: 4 }}>+ Add Category</button>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => setEditCats(DEFAULT_CATEGORIES.map(c => ({ ...c })))} style={{ padding: "12px 18px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t3, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Reset</button>
              <button onClick={saveCustomCats} disabled={catSaving} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: G.bk, color: G.wh, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>{catSaving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ BANK EDIT MODAL ══════ */}
      {bankMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => { setBankMod(false); if (onboardReturn.current !== null) { setOnboardStep(onboardReturn.current); onboardReturn.current = null; onboardAdvance.current = null; } }}>
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px", maxHeight: "80vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt, margin: "0 auto 18px" }} />
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 4 }}>Banks & Cards</div>
            <div style={{ fontSize: 13, color: G.t3, marginBottom: 20 }}>Add your banks and cards. These appear as payment options when logging expenses.</div>
            {editBanks.map((b, i) => (
              <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
                <input type="text" value={b.label} onChange={e => setEditBanks(p => p.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} placeholder="e.g. HDFC, Kotak" maxLength={20} style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, outline: "none", background: G.bg2, color: G.t1, boxSizing: "border-box", minWidth: 0 }} />
                <select value={b.type} onChange={e => setEditBanks(p => p.map((x, j) => j === i ? { ...x, type: e.target.value } : x))} style={{ padding: "10px 8px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 13, color: G.t2, background: G.bg2, outline: "none" }}>
                  <option value="bank">Account</option>
                  <option value="credit_card">Card</option>
                </select>
                <input type="text" value={b.last4 || ""} onChange={e => setEditBanks(p => p.map((x, j) => j === i ? { ...x, last4: e.target.value.replace(/[^0-9]/g, "") } : x))} placeholder="Last 4" maxLength={4} style={{ width: 56, padding: "10px 8px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 13, outline: "none", background: G.bg2, color: G.t1, boxSizing: "border-box", textAlign: "center" }} />
                <button onClick={() => setEditBanks(p => p.filter((_, j) => j !== i))} style={{ width: 36, height: 36, borderRadius: 10, border: `2px solid ${G.bdr}`, background: G.bg, color: "#FF3B30", fontSize: 16, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>{"\u2715"}</button>
              </div>
            ))}
            {editBanks.length < 10 && (
              <button onClick={() => setEditBanks(p => [...p, { id: "bnk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label: "", type: "bank", last4: "" }])} style={{ width: "100%", padding: "11px", borderRadius: 10, border: `2px dashed ${G.bdr}`, background: "transparent", color: G.t3, fontSize: 15, fontWeight: 600, cursor: "pointer", marginBottom: 4 }}>+ Add Bank / Card</button>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => setBankMod(false)} style={{ padding: "12px 18px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t3, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
              <button onClick={saveBanks} disabled={bankSaving} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: G.bk, color: G.wh, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>{bankSaving ? "Saving\u2026" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* ══════ MINDFUL POPUP MODAL ══════ */}
      {mindfulPopup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => dismissMindfulPopup()}>
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ width: 30 }} />
              <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt }} />
              <button onClick={() => dismissMindfulPopup()} style={{ background: "none", border: "none", fontSize: 20, color: G.t3, cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>{"\u2715"}</button>
            </div>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>Mindful — {mindfulPopup.scopeLabel}</div>
              <div style={{ fontSize: 14, color: G.t3, marginTop: 4 }}>A look at last month's spending</div>
            </div>

            {/* Summary row */}
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <div style={{ flex: 1, textAlign: "center", background: G.bg2, borderRadius: 12, padding: "10px 6px" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: G.t1 }}>{formatINR(mindfulPopup.totalSpend)}</div>
                <div style={{ fontSize: 10, color: G.t3, marginTop: 2 }}>Total</div>
              </div>
              <div style={{ flex: 1, textAlign: "center", background: G.bg2, borderRadius: 12, padding: "10px 6px" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#34C759" }}>{Math.round((1 - mindfulPopup.discretionaryPct) * 100)}%</div>
                <div style={{ fontSize: 10, color: G.t3, marginTop: 2 }}>Essential</div>
              </div>
              <div style={{ flex: 1, textAlign: "center", background: G.bg2, borderRadius: 12, padding: "10px 6px" }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#FF9500" }}>{Math.round(mindfulPopup.discretionaryPct * 100)}%</div>
                <div style={{ fontSize: 10, color: G.t3, marginTop: 2 }}>Discretionary</div>
              </div>
            </div>

            {/* Top avoidable (compact, max 3) */}
            {mindfulPopup.topAvoidable.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 12, color: G.t3, fontWeight: 600, marginBottom: 8 }}>
                  Top avoidable — {Math.round(mindfulPopup.topAvoidablePctOfDisc * 100)}% of discretionary
                </div>
                {mindfulPopup.topAvoidable.slice(0, 3).map((e, i) => {
                  const catObj = e.category === "uncategorized" ? UNCAT : (allCats.find(c => c.id === e.category) || { label: e.category, icon: "?" });
                  return (
                    <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: i > 0 ? `1px solid ${G.bg3}` : "none" }}>
                      <span style={{ fontSize: 14, color: G.t2 }}>{e.note || "—"} <span style={{ fontSize: 12, color: G.tm }}>· {catObj.label}</span></span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: G.t1 }}>{formatINR(e.amount)}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Trip summary (compact) */}
            {mindfulPopup.trips.length > 0 && (
              <div style={{ marginBottom: 16, paddingTop: 8, borderTop: `1px solid ${G.bg3}` }}>
                <div style={{ fontSize: 12, color: G.t3, fontWeight: 600, marginBottom: 6 }}>Trips</div>
                {mindfulPopup.trips.map(t => (
                  <div key={t.tripId} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 3 }}>
                    <span>✈️ {t.name}</span><span style={{ fontWeight: 700 }}>{formatINR(t.spend)}</span>
                  </div>
                ))}
              </div>
            )}

            <button onClick={() => { dismissMindfulPopup(); setView("insights"); }}
              style={{ width: "100%", padding: 14, borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 16, fontWeight: 700, cursor: "pointer", marginBottom: 10 }}>
              See Full Report
            </button>
            <button onClick={() => dismissMindfulPopup(true)}
              style={{ width: "100%", padding: 10, borderRadius: 10, border: "none", background: "transparent", fontSize: 13, color: G.tm, cursor: "pointer" }}>
              Don't show again
            </button>
          </div>
        </div>
      )}

      {/* ══════ PROFILE MODAL ══════ */}
      {profileMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => { setProfileMod(false); setDelConfirm(false); }}>
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div style={{ width: 30 }} />
              <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt }} />
              <button onClick={() => { setProfileMod(false); setDelConfirm(false); }} style={{ background: "none", border: "none", fontSize: 20, color: G.t3, cursor: "pointer", padding: "2px 6px", lineHeight: 1 }}>{"\u2715"}</button>
            </div>
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 20 }}>Profile</div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: G.t3, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Email</div>
              <div style={{ padding: "12px 14px", borderRadius: 10, background: G.bg2, fontSize: 15, color: G.t2 }}>{session?.user?.email || "—"}</div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: G.t3, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Display Name</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input type="text" value={profileName} onChange={e => setProfileName(e.target.value)} placeholder="Your name" maxLength={40} style={{ flex: 1, padding: "12px 14px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, outline: "none", background: G.bg2, color: G.t1, boxSizing: "border-box", minWidth: 0 }} />
                <button onClick={async () => {
                  setProfileSaving(true);
                  const { error } = await supabase.auth.updateUser({ data: { full_name: profileName.trim() } });
                  setProfileSaving(false);
                  if (error) sToast("Error saving", "err"); else sToast("Name saved");
                }} disabled={profileSaving} style={{ padding: "12px 16px", borderRadius: 10, border: "none", background: G.bk, color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>{profileSaving ? "…" : "Save"}</button>
              </div>
              <div style={{ fontSize: 11, color: G.t3, marginTop: 4 }}>Used in exported reports.</div>
            </div>

            <div style={{ borderTop: `1px solid ${G.lt}`, paddingTop: 16, marginBottom: 16 }}>
              <button onClick={async () => {
                const email = session?.user?.email;
                if (!email) return;
                const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: "https://expenses.gurjarbooks.com" });
                if (error) sToast("Error", "err"); else sToast("Reset link sent to email");
              }} style={{ width: "100%", padding: "13px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t1, fontSize: 15, fontWeight: 600, cursor: "pointer", marginBottom: 10 }}>Change Password</button>

              <button onClick={signOut} style={{ width: "100%", padding: "13px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t1, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Sign Out</button>
            </div>

            <div style={{ borderTop: `1px solid ${G.lt}`, paddingTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#CC0000", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Danger Zone</div>
              {!delConfirm ? (
                <button onClick={() => setDelConfirm(true)} style={{ width: "100%", padding: "13px", borderRadius: 12, border: "2px solid #FFCCCC", background: "#FFF5F5", color: "#CC0000", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Delete Account</button>
              ) : (
                <div>
                  <div style={{ fontSize: 13, color: "#CC0000", marginBottom: 10, lineHeight: 1.5 }}>This will permanently delete your account and all data (expenses, trips, categories). This cannot be undone.</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setDelConfirm(false)} style={{ flex: 1, padding: "13px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t2, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
                    <button onClick={async () => {
                      setDeleting(true);
                      try {
                        const { data: { session: s } } = await supabase.auth.getSession();
                        const res = await fetch(`${API_BASE}/api/delete-account`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: s?.access_token }) });
                        const json = await res.json();
                        if (json.ok) { sToast("Account deleted"); await supabase.auth.signOut(); }
                        else sToast(json.error || "Error", "err");
                      } catch { sToast("Error deleting", "err"); }
                      setDeleting(false);
                    }} disabled={deleting} style={{ flex: 1, padding: "13px", borderRadius: 12, border: "none", background: "#CC0000", color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>{deleting ? "Deleting…" : "Yes, Delete Everything"}</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════ ONBOARDING GUIDE ══════ */}
      {onboardStep !== null && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 10000, display: "flex", alignItems: "flex-end", justifyContent: "center" }} onClick={dismissOnboard}>
          <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 22px env(safe-area-inset-bottom, 20px)", maxHeight: "80dvh", overflowY: "auto" }}>
            {/* Progress dots */}
            <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 18 }}>
              {[0, 1, 2].map(i => <div key={i} style={{ width: i === onboardStep ? 24 : 8, height: 8, borderRadius: 4, background: i === onboardStep ? G.bk : G.bg3, transition: "all .2s" }} />)}
            </div>

            {onboardStep === 0 && <>
              <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Welcome to Expense Tracker!</div>
              <div style={{ fontSize: 14, color: G.t2, lineHeight: 1.6, marginBottom: 20 }}>Let's get you set up in under a minute. You can always change these later.</div>
              <div style={{ background: G.bg2, borderRadius: 14, padding: "16px 18px", marginBottom: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>1. Customise Categories</div>
                <div style={{ fontSize: 13, color: G.t2, lineHeight: 1.5, marginBottom: 12 }}>You start with Groceries, Food, Travel, Entertainment & more. Add your own or hide ones you don't need.</div>
                <button onClick={() => { onboardReturn.current = 0; onboardAdvance.current = 1; setOnboardStep(null); setCatMod(true); setEditCats(cats.map(c => ({ ...c }))); }} style={{ width: "100%", padding: "11px", borderRadius: 10, border: `2px solid ${G.bk}`, background: G.bk, color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Edit Categories</button>
              </div>
            </>}

            {onboardStep === 1 && <>
              <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Add Your Banks</div>
              <div style={{ fontSize: 14, color: G.t2, lineHeight: 1.6, marginBottom: 20 }}>Add your bank accounts and cards so expenses are tagged to the right source. If you skip this, banks will be auto-created from SMS data later.</div>
              <div style={{ background: G.bg2, borderRadius: 14, padding: "16px 18px", marginBottom: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>2. Banks & Cards</div>
                <div style={{ fontSize: 13, color: G.t2, lineHeight: 1.5, marginBottom: 12 }}>Add your bank accounts (HDFC, SBI, etc.) and credit cards. Include the last 4 digits for automatic SMS matching.</div>
                <button onClick={() => { onboardReturn.current = 1; onboardAdvance.current = 2; setOnboardStep(null); setBankMod(true); setEditBanks(banks.length > 0 ? banks.map(b => ({ ...b })) : [{ id: "bnk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), label: "", type: "bank", last4: "" }]); }} style={{ width: "100%", padding: "11px", borderRadius: 10, border: `2px solid ${G.bk}`, background: G.bk, color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Add Banks</button>
              </div>
            </>}

            {onboardStep === 2 && <>
              <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Auto-Track via SMS</div>
              <div style={{ fontSize: 14, color: G.t2, lineHeight: 1.6, marginBottom: 20 }}>Set up an iPhone Shortcut to automatically log expenses from bank SMS messages. This is optional — you can always add expenses manually.</div>
              <div style={{ background: G.bg2, borderRadius: 14, padding: "16px 18px", marginBottom: 16 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>3. iPhone Shortcut</div>
                <div style={{ fontSize: 13, color: G.t2, lineHeight: 1.5, marginBottom: 12 }}>Get your API key from the key icon (top right), then download the shortcut and set up a message automation for your bank.</div>
                <button onClick={() => { dismissOnboard(); setKeyMod(true); }} style={{ width: "100%", padding: "11px", borderRadius: 10, border: `2px solid ${G.bk}`, background: G.bk, color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Set Up Key & Shortcut</button>
              </div>
            </>}

            {/* Navigation */}
            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              {onboardStep > 0 && (
                <button onClick={() => setOnboardStep(s => s - 1)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t2, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Back</button>
              )}
              <button onClick={dismissOnboard} style={{ flex: 1, padding: "12px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t3, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Skip</button>
              {onboardStep < 2 ? (
                <button onClick={() => setOnboardStep(s => s + 1)} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: G.bk, color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Next</button>
              ) : (
                <button onClick={dismissOnboard} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: G.bk, color: G.wh, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Done</button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ══════ NAV ══════ */}
      <nav style={{ display: "flex", justifyContent: "space-around", alignItems: "center", padding: "8px 0 env(safe-area-inset-bottom, 10px)", background: G.bg, borderTop: `1px solid ${G.bdr}`, position: "fixed", bottom: 0, left: 0, right: 0, maxWidth: 390, margin: "0 auto", zIndex: 100 }}>
        {[{ id: "add", l: "Add", a: "\uFF0B", i: "\uFF0B" }, { id: "list", l: "History", a: "\u2630", i: "\u2630" }, { id: "insights", l: "Insights", a: "\u25C9", i: "\u25CB" }, { id: "trips", l: "Trips", a: "\u25C6", i: "\u25C7" }].map(t => {
          const on = view === t.id;
          return <button key={t.id} onClick={() => { navTo(t.id); if (t.id === "trips") setTripDet(null); }} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "none", border: "none", cursor: "pointer", padding: "6px 16px", color: on ? G.bk : G.tm }}>
            <span style={{ fontSize: 20, fontWeight: on ? 800 : 400 }}>{on ? t.a : t.i}</span>
            <span style={{ fontSize: 11, fontWeight: on ? 700 : 500, letterSpacing: .3 }}>{t.l}</span>
          </button>;
        })}
      </nav>
    </div>
  );
}
