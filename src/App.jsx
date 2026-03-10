import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { supabase, dbToExp, dbToTrip, expToDb, tripToDb } from "./supabase";
import { useAuth } from "./AuthContext";
import Auth, { PasswordReset } from "./Auth";
import * as XLSX from "xlsx";

// Categories for users who signed up before the new defaults
const OLD_DEFAULT_CATEGORIES = [
  { id: "personal",   label: "Personal", icon: "👤" },
  { id: "work",       label: "Work",     icon: "💼" },
  { id: "home",       label: "Home",     icon: "🏠" },
  { id: "investment", label: "Savings",  icon: "₹" },
];
// Categories for new users
const NEW_DEFAULT_CATEGORIES = [
  { id: "groceries",  label: "Groceries",         icon: "🛒" },
  { id: "food",       label: "Food",              icon: "🍔" },
  { id: "travel",     label: "Travel",            icon: "✈️" },
  { id: "entertain",  label: "Entertainment",     icon: "🎬" },
  { id: "personal",   label: "Personal Care",     icon: "💄" },
  { id: "others",     label: "Others",            icon: "📦" },
  { id: "investment", label: "Savings",           icon: "₹"  },
];
const PAY = [
  { id: "cash", label: "Cash" },
  { id: "bank", label: "Bank" },
  { id: "card", label: "Card" },
  { id: "upi",  label: "UPI"  },
];

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

const G = {
  bg: "#FFF", bg2: "#F5F5F5", bg3: "#EBEBEB", bdr: "#D4D4D4",
  t1: "#111", t2: "#555", t3: "#888", tm: "#AAA",
  bk: "#000", wh: "#FFF", dk: "#1A1A1A", md: "#333", lt: "#E0E0E0", ac: "#444",
};

// Static styles hoisted to avoid re-allocation on every render
const S = {
  expCard: { display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", background: "#F5F5F5", borderRadius: 12, position: "relative", zIndex: 2, transition: "transform .2s ease", willChange: "transform" },
  expIcon: { width: 38, height: 38, borderRadius: 10, background: "#1A1A1A", color: "#FFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, flexShrink: 0 },
};

export default function ExpenseTracker() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const { session, loading: authLoading, signOut, userId, needsPasswordReset } = useAuth();

  // ── State ─────────────────────────────────────────────────────────────────
  const [exps,      setExps]      = useState([]);
  const [trips,     setTrips]     = useState([]);
  const [dbReady,   setDbReady]   = useState(false);
  const [view,      setView]      = useState("add");
  const [amt,       setAmt]       = useState("");
  const [note,      setNote]      = useState("");
  const [cat,       setCat]       = useState("personal");
  const [pay,       setPay]       = useState("bank");
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
  const [insPeriod,   setInsPeriod]   = useState("month");
  const [insMonth,    setInsMonth]    = useState(() => { const n = new Date(); return { year: n.getFullYear(), month: n.getMonth() }; });
  const [insYear,     setInsYear]     = useState(() => new Date().getFullYear());
  const [editDate,  setEditDate]  = useState("");
  const [keyMod,     setKeyMod]     = useState(false);
  const [userKey,    setUserKey]    = useState(null);
  const [keyLoading, setKeyLoading] = useState(false);
  const [cats,       setCats]       = useState(OLD_DEFAULT_CATEGORIES);
  const [catMod,     setCatMod]     = useState(false);
  const [editCats,   setEditCats]   = useState(OLD_DEFAULT_CATEGORIES);
  const [newCatIcon, setNewCatIcon] = useState("");
  const [newCatLabel,setNewCatLabel]= useState("");
  const [dragIdx,    setDragIdx]    = useState(null); // index of cat being moved
  const [catSaving,  setCatSaving]  = useState(false);
  const [fDateFrom,   setFDateFrom]   = useState(null);
  const [fDateTo,     setFDateTo]     = useState(null);
  const [dispName,    setDispName]    = useState("");
  const [savingName,  setSavingName]  = useState(false);
  const [profPwSent,  setProfPwSent]  = useState(false);
  const [confirmDel,  setConfirmDel]  = useState(false);
  const [deletingAcc, setDeletingAcc] = useState(false);

  const aRef = useRef(null);
  const tRef = useRef({});
  const mRef = useRef({}); // modal swipe-down tracking
  const lastTouchTime = useRef(0); // desktop click detection

  // ── Load data + realtime ──────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    let expsChannel, tripsChannel;

    const init = async () => {
      const [{ data: expRows }, { data: tripRows }, { data: prefsRow }] = await Promise.all([
        supabase.from("expenses").select("*").eq("user_id", userId).order("date", { ascending: false }),
        supabase.from("trips").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
        supabase.from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle(),
      ]);
      setExps((expRows  || []).map(dbToExp));
      setTrips((tripRows || []).map(dbToTrip));
      if (prefsRow?.cats_json) {
        try {
          const saved = JSON.parse(prefsRow.cats_json);
          // New format: full array of {id, label, icon} objects
          if (Array.isArray(saved) && saved.length > 0) setCats(saved);
        } catch {}
      } else {
        // No prefs yet — detect new vs existing user
        const isNewUser = (expRows || []).length === 0;
        if (isNewUser) {
          setCats(NEW_DEFAULT_CATEGORIES);
          // Seed prefs so future loads use new defaults
          supabase.from("user_prefs").upsert({ user_id: userId, cats_json: JSON.stringify(NEW_DEFAULT_CATEGORIES) });
        }
        // else: existing user with no customisation → keep OLD_DEFAULT_CATEGORIES (initial state)
      }
      setDbReady(true);

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
    return () => { expsChannel?.unsubscribe(); tripsChannel?.unsubscribe(); };
  }, [userId]);

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
    ...cats,
    ...activeTrips.map(t => ({ id: `trip_${t.id}`, label: t.name, icon: "\u2708\uFE0F", isTrip: true })),
  ], [cats, activeTrips]);

  const allCats = useMemo(() => [
    ...cats,
    ...[...activeTrips, ...inactiveTrips].map(t => ({ id: `trip_${t.id}`, label: t.name, icon: "\u2708\uFE0F", isTrip: true })),
  ], [cats, activeTrips, inactiveTrips]);


  const sToast = useCallback((m, t = "ok") => { setToast({ m, t }); setTimeout(() => setToast(null), 1500); }, []);

  useEffect(() => { if (view === "add" && aRef.current) setTimeout(() => aRef.current?.focus(), 80); }, [view]);

  // ── Shortcut key management ───────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    supabase.from("user_keys").select("key_value").eq("user_id", userId).maybeSingle()
      .then(({ data }) => setUserKey(data?.key_value || null));
  }, [userId]);

  // Load display name from user metadata
  useEffect(() => {
    const name = session?.user?.user_metadata?.display_name;
    if (name) setDispName(name);
  }, [session]);

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

  // ── Export ────────────────────────────────────────────────────────────────
  const doExportPDF = useCallback(() => {
    if (filtered.length === 0) return;
    const getCatLabel = (e) => {
      if (e.tripId) { const t = trips.find(x => x.id === e.tripId); return t ? t.name : "Trip"; }
      return cats.find(c => c.id === e.category)?.label || e.category;
    };
    const periodLabel = selTrip
      ? `Trip: ${trips.find(t => t.id === selTrip)?.name || ""}`
      : fCat !== "all" ? (allCats.find(c => c.id === fCat)?.label || "Category") : "All Categories";
    const dates = filtered.map(e => new Date(e.date).getTime());
    const dateRange = sameDay(Math.min(...dates), Math.max(...dates))
      ? tds(Math.min(...dates))
      : `${tds(Math.min(...dates))} \u2013 ${tds(Math.max(...dates))}`;
    const total = filtered.reduce((s, e) => s + e.amount, 0);
    const generated = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const fileName = `Gurjar-Books-${periodLabel.replace(/[^\w]/g, "-")}-${new Date().toISOString().slice(0, 10)}`;
    const rows = [...filtered].reverse().map(e => `
      <tr>
        <td>${tds(e.date)}</td>
        <td class="t2">${tts(e.date)}</td>
        <td>${getCatLabel(e)}</td>
        <td>${e.note ? e.note.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "<span class='em'>\u2014</span>"}</td>
        <td class="t2">${e.payMode === "cash" ? "Cash" : "Bank"}</td>
        <td class="amt">\u20B9${e.amount.toLocaleString("en-IN")}</td>
      </tr>`).join("");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${fileName}</title>
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
.summary { display: flex; justify-content: space-between; align-items: flex-end; padding-top: 14px; border-top: 2px solid #111; }
.sum-label { font-size: 11px; font-weight: 700; color: #666; letter-spacing: 0.8px; text-transform: uppercase; }
.sum-total { font-size: 26px; font-weight: 800; letter-spacing: -0.5px; margin-top: 3px; }
.sum-meta { font-size: 12px; color: #888; }
.footer { margin-top: 24px; font-size: 10px; color: #BBB; text-align: center; }
@media print { body { padding: 0; } @page { margin: 1.5cm; size: A4 portrait; } }
</style>
</head>
<body>
<div class="header">
  <div class="brand">\u20B9 Expense Tracker</div>
  <div class="subtitle">Expense Report &middot; ${periodLabel}</div>
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
<div class="footer">Expense Tracker &nbsp;&middot;&nbsp; expenses.gurjarbooks.com</div>
<script>document.title = "${fileName}"; window.addEventListener("load", () => setTimeout(() => window.print(), 250));<\/script>
</body>
</html>`;
    const win = window.open("", "_blank");
    if (win) { win.document.write(html); win.document.close(); }
    else sToast("Allow pop-ups to export PDF", "err");
  }, [filtered, cats, trips, selTrip, fCat, fPay, allCats, sToast]);

  const doExportCSV = useCallback(() => {
    if (filtered.length === 0) return;
    const getCatLabel = (e) => {
      if (e.tripId) { const t = trips.find(x => x.id === e.tripId); return t ? t.name : "Trip"; }
      return cats.find(c => c.id === e.category)?.label || e.category;
    };
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const header = ["Date", "Time", "Category", "Note", "Payment Mode", "Amount (INR)"].join(",");
    const csvRows = [...filtered].reverse().map(e =>
      [tds(e.date), tts(e.date), esc(getCatLabel(e)), esc(e.note || ""), e.payMode === "cash" ? "Cash" : "Bank", e.amount].join(",")
    );
    const csv = [header, ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Gurjar-Books-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
    sToast("CSV downloaded");
  }, [filtered, cats, trips, sToast]);

  // ── Custom categories ─────────────────────────────────────────────────────
  const openCatMod = useCallback(() => {
    setEditCats(cats.map(c => ({ ...c })));
    setNewCatIcon(""); setNewCatLabel(""); setDragIdx(null);
    setCatMod(true);
  }, [cats]);

  const saveCustomCats = useCallback(async () => {
    setCatSaving(true);
    const cleaned = editCats
      .filter(c => c.label.trim())
      .map(c => ({ id: c.id, label: c.label.trim(), icon: c.icon.trim() || "📦" }));
    // Ensure investment (savings) is always present
    if (!cleaned.find(c => c.id === "investment")) cleaned.push({ id: "investment", label: "Savings", icon: "₹" });
    setCats(cleaned);
    setCatMod(false);
    setCatSaving(false);
    await supabase.from("user_prefs").upsert({ user_id: userId, cats_json: JSON.stringify(cleaned) });
  }, [editCats, userId]);

  const addNewCat = useCallback(() => {
    if (!newCatLabel.trim()) return;
    const id = "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    setEditCats(p => [...p, { id, label: newCatLabel.trim(), icon: newCatIcon.trim() || "📦" }]);
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

  const switchToNewDefaults = useCallback(async () => {
    setEditCats(NEW_DEFAULT_CATEGORIES.map(c => ({ ...c })));
  }, []);

  // ── CRUD — all optimistic ─────────────────────────────────────────────────
  const doSave = useCallback(async () => {
    const v = Math.round(Number(amt));
    if (!v || v <= 0) { sToast("Enter amount", "err"); return; }
    hap();
    const tid = cat.startsWith("trip_") ? cat.replace("trip_", "") : null;
    if (editId) {
      const orig = exps.find(e => e.id === editId);
      const updated = { ...orig, amount: v, note: note.trim(), category: tid ? "trip" : cat, payMode: pay, tripId: tid, date: editDate ? new Date(editDate + "T12:00:00").toISOString() : orig?.date };
      setExps(p => p.map(e => e.id === editId ? updated : e).sort((a, b) => new Date(b.date) - new Date(a.date)));
      setEditId(null); setEditDate(""); sToast("Updated");
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
    supabase.from("trips").update({ archived: true }).eq("id", t.id)
      .then(({ error }) => { if (error) sToast("Sync error", "err"); });
    supabase.from("expenses").update({ trip_id: null, category: "personal" }).eq("trip_id", t.id)
      .then(({ error }) => { if (error) sToast("Sync error", "err"); });
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
        const payLabel = (PAY.find(p => p.id === e.payMode)?.label || e.payMode).toLowerCase();
        return (e.note || "").toLowerCase().includes(q) || e.amount.toString().includes(q) || catLabel.includes(q) || payLabel.includes(q);
      });
    }
    return l;
  }, [exps, fCat, fPay, sq, selTrip, allCats]);

  // ── Insights ──────────────────────────────────────────────────────────────
  const insPeriodLabel = useMemo(() => {
    if (insPeriod === "all") return "All Time";
    if (insPeriod === "year") return insYear.toString();
    return new Date(insMonth.year, insMonth.month, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  }, [insMonth, insYear, insPeriod]);

  const ins = useMemo(() => {
    const tm = exps.filter(e => {
      if (e.category === "investment") return false;
      if (insPeriod === "all") return true;
      const d = new Date(e.date);
      if (insPeriod === "year") return d.getFullYear() === insYear;
      return d.getMonth() === insMonth.month && d.getFullYear() === insMonth.year;
    });
    const bc = {}, bp = {};
    tm.forEach(e => { const k = e.tripId ? `trip_${e.tripId}` : e.category; bc[k] = (bc[k] || 0) + e.amount; bp[e.payMode] = (bp[e.payMode] || 0) + e.amount; });
    const totM = tm.reduce((s, e) => s + e.amount, 0);
    const savFilter = insPeriod === "year"
      ? e => e.category === "investment" && !e.tripId && new Date(e.date).getFullYear() === insYear
      : insPeriod === "month"
        ? e => e.category === "investment" && !e.tripId && new Date(e.date).getMonth() === insMonth.month && new Date(e.date).getFullYear() === insMonth.year
        : e => e.category === "investment" && !e.tripId;
    const totI = exps.filter(savFilter).reduce((s, e) => s + e.amount, 0);
    return { bc, bp, totM, totI, mc: tm.length };
  }, [exps, insMonth, insYear, insPeriod]);

  // Yearly bar chart data: monthly breakdown for the selected year
  const yearlyBars = useMemo(() => {
    if (insPeriod !== "year") return [];
    const months = Array.from({ length: 12 }, (_, i) => ({ month: i, total: 0 }));
    exps.forEach(e => {
      if (e.category === "investment") return;
      const d = new Date(e.date);
      if (d.getFullYear() === insYear) months[d.getMonth()].total += e.amount;
    });
    return months;
  }, [exps, insYear, insPeriod]);

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

  // ── Trip insights ─────────────────────────────────────────────────────────
  const getTI = useCallback((tid) => {
    const te = exps.filter(e => e.tripId === tid).sort((a, b) => new Date(a.date) - new Date(b.date));
    const tot = te.reduce((s, e) => s + e.amount, 0);
    const cash = te.filter(e => e.payMode === "cash").reduce((s, e) => s + e.amount, 0);
    const bank = te.filter(e => e.payMode === "bank").reduce((s, e) => s + e.amount, 0);
    let d = 0;
    if (te.length > 1) d = Math.max(1, Math.ceil((new Date(te[te.length - 1].date) - new Date(te[0].date)) / 864e5) + 1);
    else if (te.length === 1) d = 1;
    return { tot, cash, bank, d, avg: d > 0 ? Math.round(tot / d) : 0, cnt: te.length };
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

  const getCL = (e) => { if (e.tripId) { const t = trips.find(x => x.id === e.tripId); return t ? t.name : "Trip"; } return cats.find(c => c.id === e.category)?.label || e.category; };
  const getCI = (e) => { if (e.tripId) return "\u2708\uFE0F"; return cats.find(c => c.id === e.category)?.icon || "?"; };

  const navTo = (t) => { hap(); if (t === "list") { setSelTrip(null); setFCat("all"); setFPay("all"); setSq(""); } setSw({ id: null, dir: null }); setSwipeConf(null); setView(t); };
  const viewTH = (tid) => { setSelTrip(tid); setFCat("all"); setFPay("all"); setSq(""); setView("list"); };

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
    <div style={{ maxWidth: 390, margin: "0 auto", minHeight: "100dvh", display: "flex", flexDirection: "column", background: G.bg, fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Helvetica Neue', sans-serif", color: G.t1, position: "relative", WebkitFontSmoothing: "antialiased" }}>

      {toast && <div style={{ position: "fixed", top: 52, left: "50%", transform: "translateX(-50%)", padding: "10px 28px", borderRadius: 100, zIndex: 9999, background: G.bk, color: G.wh, fontSize: 15, fontWeight: 600, boxShadow: "0 6px 24px rgba(0,0,0,.25)" }}>{toast.m}</div>}

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", background: G.bg, borderBottom: `1px solid ${G.bdr}`, position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div onClick={() => navTo("add")} style={{ width: 34, height: 34, borderRadius: 8, background: G.bk, color: G.wh, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 17, cursor: "pointer" }}>{"\u20B9"}</div>
          <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: -0.5 }}>
            {view === "add" ? "Add Expense" : view === "list" ? (selTrip ? (trips.find(t => t.id === selTrip)?.name || "History") : "History") : view === "insights" ? "Insights" : "Trips"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setKeyMod(true)} title="API Key" style={{ background: "none", border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "5px 10px", fontSize: 15, color: G.t3, cursor: "pointer", lineHeight: 1 }}>🔑</button>
          <button onClick={signOut} style={{ background: "none", border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "5px 11px", fontSize: 13, fontWeight: 600, color: G.t3, cursor: "pointer" }}>Out</button>
        </div>
      </header>

      <main style={{ flex: 1, overflowY: view === "add" ? "hidden" : "auto", paddingBottom: 72 }}>

        {/* Skeleton while loading from DB */}
        {!dbReady && (
          <div style={{ padding: "24px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
            {[1, 2, 3].map(i => <div key={i} style={{ height: 64, borderRadius: 12, background: "#F0F0F0", animation: "pulse 1.2s ease-in-out infinite alternate" }} />)}
            <style>{`@keyframes pulse { from { opacity:1 } to { opacity:0.4 } }`}</style>
          </div>
        )}

        {/* ══════ ADD ══════ */}
        {dbReady && view === "add" && (
          <div style={{ padding: "8px 18px 0", display: "flex", flexDirection: "column", height: "calc(100dvh - 48px - 64px)", overflow: "hidden", justifyContent: "space-between" }}>
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
              <div style={{ display: "flex", gap: 5, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 2, scrollbarWidth: "none", msOverflowStyle: "none" }}>
                {addCats.map(c => B(cat === c.id, `${c.icon} ${c.label}`, () => { hap(); setCat(c.id); }, { flexShrink: 0 }))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: G.t3, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 6 }}>Paid via</div>
              <div style={{ display: "flex", background: G.bg2, borderRadius: 12, padding: 3 }}>
                {PAY.map(p => (
                  <button key={p.id} onClick={() => { hap(); setPay(p.id); }} style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 16, fontWeight: 700, background: pay === p.id ? G.bk : "transparent", color: pay === p.id ? G.wh : G.t3 }}>{p.label}</button>
                ))}
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
              <button onClick={doSave} style={{ width: "100%", padding: "15px", borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 18, fontWeight: 700, cursor: "pointer" }}>{editId ? "Update" : "Save"}</button>
              {editId && <button onClick={() => { setEditId(null); setEditDate(""); setAmt(""); setNote(""); }} style={{ width: "100%", padding: "11px", borderRadius: 12, marginTop: 5, border: `2px solid ${G.bdr}`, background: "transparent", color: G.t2, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>}
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
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <select value={fCat} onChange={e => setFCat(e.target.value)} style={{ flex: 1, padding: "11px 10px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, color: G.t2, background: G.bg, outline: "none" }}>
                  <option value="all">All Categories</option>
                  {allCats.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
                <select value={fPay} onChange={e => setFPay(e.target.value)} style={{ flex: 1, padding: "11px 10px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, color: G.t2, background: G.bg, outline: "none" }}>
                  <option value="all">All Modes</option>
                  {PAY.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
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
                  <button onClick={doExportCSV} style={{ background: "none", border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: G.t3, cursor: "pointer", letterSpacing: 0.3 }}>CSV</button>
                  <button onClick={doExportPDF} style={{ background: G.bg2, border: `1.5px solid ${G.bdr}`, borderRadius: 8, padding: "3px 9px", fontSize: 11, fontWeight: 700, color: G.t2, cursor: "pointer", letterSpacing: 0.3 }}>PDF</button>
                </>)}
                <span style={{ fontWeight: 800, fontSize: 16, color: G.t1 }}>{formatINR(filtered.reduce((s, e) => s + e.amount, 0))}</span>
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
                              <div style={{ fontSize: 14, color: G.t3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {exp.note || getCL(exp)}<span style={{ marginLeft: 6, fontSize: 12, color: G.tm }}>{"\u00B7"} {exp.payMode === "cash" ? "Cash" : "Bank"}</span>
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
              <div style={{ flex: 1, borderRadius: 14, padding: "14px 14px", background: G.bg2, border: `1.5px solid ${G.bdr}` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: G.t3, letterSpacing: 1, textTransform: "uppercase" }}>Savings</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 5, letterSpacing: -.5 }}>{formatINR(ins.totI)}</div>
                <div style={{ fontSize: 12, color: G.tm, marginTop: 3 }}>{insPeriod === "all" ? "all time" : insPeriod === "year" ? insYear : new Date(insMonth.year, insMonth.month).toLocaleDateString("en-IN", { month: "short" })}</div>
              </div>
            </div>

            {/* Yearly bar chart — monthly breakdown */}
            {insPeriod === "year" && yearlyBars.length > 0 && (() => {
              const maxVal = Math.max(...yearlyBars.map(b => b.total), 1);
              const mNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
              return (
                <div style={{ marginBottom: 22, background: G.bg2, borderRadius: 14, padding: "16px 14px", border: `1px solid ${G.bdr}` }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Monthly Breakdown</div>
                  {yearlyBars.map((b, i) => (
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
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{formatINR(Math.round(ins.totM / (yearlyBars.filter(b => b.total > 0).length || 1)))}</span>
                  </div>
                </div>
              );
            })()}

            <div style={{ marginBottom: 22 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>By Category <span style={{ fontSize: 12, color: G.tm, fontWeight: 400 }}>· tap to filter history</span></div>
              {Object.entries(ins.bc).sort((a, b) => b[1] - a[1]).map(([cid, a]) => {
                const c = allCats.find(x => x.id === cid) || cats[0];
                const p = ins.totM > 0 ? (a / ins.totM * 100) : 0;
                return (
                  <div key={cid} onClick={() => { hap(); setSelTrip(null); setFPay("all"); setSq(""); setFCat(cid); setSw({ id: null, dir: null }); setSwipeConf(null); setView("list"); }} style={{ marginBottom: 14, cursor: "pointer" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: G.t2, marginBottom: 5 }}><span>{c.label}</span><span style={{ fontWeight: 700, color: G.t1 }}>{formatINR(a)}</span></div>
                    <div style={{ height: 7, background: G.bg3, borderRadius: 8, overflow: "hidden" }}><div style={{ height: 7, borderRadius: 8, background: G.dk, width: `${p}%`, transition: "width .4s" }} /></div>
                    <div style={{ fontSize: 12, color: G.tm, marginTop: 3, textAlign: "right" }}>{Math.round(p)}%</div>
                  </div>
                );
              })}
              {Object.keys(ins.bc).length === 0 && <div style={{ color: G.tm, padding: "14px 0", fontSize: 15 }}>No data for this period</div>}
            </div>

            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>By Payment Mode <span style={{ fontSize: 12, color: G.tm, fontWeight: 400 }}>{"\u00B7"} tap to filter history</span></div>
              {Object.entries(ins.bp).sort((a, b) => b[1] - a[1]).map(([pid, a]) => {
                const p = ins.totM > 0 ? (a / ins.totM * 100) : 0;
                return (<div key={pid} onClick={() => { hap(); setSelTrip(null); setFCat("all"); setSq(""); setFPay(pid); setSw({ id: null, dir: null }); setSwipeConf(null); setView("list"); }} style={{ marginBottom: 14, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: G.t2, marginBottom: 5 }}><span>{PAY.find(x => x.id === pid)?.label || pid}</span><span style={{ fontWeight: 700, color: G.t1 }}>{formatINR(a)}</span></div>
                  <div style={{ height: 7, background: G.bg3, borderRadius: 8, overflow: "hidden" }}><div style={{ height: 7, borderRadius: 8, background: G.ac, width: `${p}%`, transition: "width .4s" }} /></div>
                  <div style={{ fontSize: 12, color: G.tm, marginTop: 3, textAlign: "right" }}>{Math.round(p)}%</div>
                </div>);
              })}
            </div>
          </div>
        )}

        {/* ══════ TRIPS LIST ══════ */}
        {dbReady && view === "trips" && !tripDet && (
          <div style={{ padding: "14px 16px" }}>
            <button onClick={() => { setTripMod(true); setEditTripId(null); setTName(""); setTBudg(""); }} style={{ width: "100%", padding: "14px", borderRadius: 12, border: `2px dashed ${G.bdr}`, background: "transparent", color: G.t2, fontSize: 16, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>+ New Trip</button>

            {activeTrips.length > 0 && <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: G.tm, textTransform: "uppercase", letterSpacing: 1.2, marginBottom: 10 }}>Active</div>
              {activeTrips.map(t => { const te = exps.filter(e => e.tripId === t.id); const tot = te.reduce((s, e) => s + e.amount, 0); const pct = t.budget > 0 ? Math.min(100, (tot / t.budget) * 100) : 0; const barCol = pct > 90 ? "#FF3B30" : pct > 70 ? "#FF9500" : "#34C759"; return (
                <div key={t.id} onClick={() => setTripDet(t.id)} style={{ background: G.bg2, borderRadius: 12, padding: "14px 16px", marginBottom: 8, borderLeft: `4px solid ${G.bk}`, cursor: "pointer" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div><div style={{ fontWeight: 700, fontSize: 17 }}>{t.name}</div><div style={{ color: G.t3, fontSize: 14, marginTop: 2 }}>{te.length} entries {"\u00B7"} {formatINR(tot)}{t.budget > 0 && ` / ${formatINR(t.budget)}`}</div></div>
                    <span style={{ color: G.tm, fontSize: 18 }}>{"\u203A"}</span>
                  </div>
                  {t.budget > 0 && <div style={{ marginTop: 10 }}>
                    <div style={{ height: 5, background: G.bg3, borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ height: 5, borderRadius: 5, background: barCol, width: `${pct}%`, transition: "width .4s" }} />
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
              {inactiveTrips.map(t => { const te = exps.filter(e => e.tripId === t.id); const tot = te.reduce((s, e) => s + e.amount, 0); const pct = t.budget > 0 ? Math.min(100, (tot / t.budget) * 100) : 0; const barCol = pct > 90 ? "#FF3B30" : pct > 70 ? "#FF9500" : "#34C759"; return (
                <div key={t.id} onClick={() => setTripDet(t.id)} style={{ background: G.bg2, borderRadius: 12, padding: "14px 16px", marginBottom: 8, borderLeft: `4px solid ${G.lt}`, cursor: "pointer", opacity: .7 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div><div style={{ fontWeight: 700, fontSize: 17 }}>{t.name}</div><div style={{ color: G.t3, fontSize: 14, marginTop: 2 }}>{te.length} entries {"\u00B7"} {formatINR(tot)}{t.budget > 0 && ` / ${formatINR(t.budget)}`}</div></div>
                    <span style={{ color: G.tm, fontSize: 18 }}>{"\u203A"}</span>
                  </div>
                  {t.budget > 0 && <div style={{ marginTop: 10 }}>
                    <div style={{ height: 5, background: G.bg3, borderRadius: 5, overflow: "hidden" }}>
                      <div style={{ height: 5, borderRadius: 5, background: barCol, width: `${pct}%`, transition: "width .4s" }} />
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
                  const pct = Math.min(100, (ti.tot / trip.budget) * 100);
                  const remaining = trip.budget - ti.tot;
                  const over = remaining < 0;
                  const barCol = pct > 90 ? "#FF3B30" : pct > 70 ? "#FF9500" : "#34C759";
                  return (
                    <div style={{ marginTop: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: "#888" }}>Budget: {formatINR(trip.budget)}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: over ? "#FF6B6B" : "#AAA" }}>{over ? `${formatINR(Math.abs(remaining))} over` : `${formatINR(remaining)} left`}</span>
                      </div>
                      <div style={{ height: 8, background: "#2A2A2A", borderRadius: 8, overflow: "hidden" }}>
                        <div style={{ height: 8, borderRadius: 8, background: barCol, width: `${pct}%`, transition: "width .6s ease" }} />
                      </div>
                      <div style={{ fontSize: 12, color: barCol, fontWeight: 600, marginTop: 5, textAlign: "right" }}>{Math.round(pct)}% used</div>
                    </div>
                  );
                })()}
              </div>

              <div style={{ background: G.bg2, borderRadius: 12, padding: 16, marginBottom: 14, border: `1px solid ${G.bdr}` }}>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Cash Flow</div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 15, color: G.t2 }}>Cash</span><span style={{ fontSize: 15, fontWeight: 700 }}>{formatINR(ti.cash)}</span></div>
                <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 15, color: G.t2 }}>Bank</span><span style={{ fontSize: 15, fontWeight: 700 }}>{formatINR(ti.bank)}</span></div>
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
            {[["Category", getCL(detMod)], ["Payment", detMod.payMode === "cash" ? "Cash" : "Bank"], ["Note", detMod.note || "\u2014"], ["Date", tfd(detMod.date)], ["Time", tts(detMod.date)]].map(([l, v]) => (
              <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "11px 0", borderBottom: `1px solid ${G.lt}`, fontSize: 16 }}>
                <span style={{ color: G.t3, fontWeight: 500 }}>{l}</span><span style={{ color: G.t1, fontWeight: 600, textAlign: "right", maxWidth: "60%" }}>{v}</span>
              </div>
            ))}
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
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px" }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt, margin: "0 auto 18px" }} />
            <div style={{ fontSize: 20, fontWeight: 800, marginBottom: 6 }}>Shortcut API Key</div>
            <div style={{ fontSize: 14, color: G.t3, marginBottom: 20, lineHeight: 1.5 }}>
              Generate a key and enter it once in the iPhone Shortcut. Anyone with this key can log expenses to your account — keep it private.
            </div>

            {userKey ? (
              <>
                <div style={{ display: "flex", alignItems: "center", background: G.bg2, borderRadius: 12, padding: "14px 16px", marginBottom: 12, gap: 12 }}>
                  <span style={{ fontFamily: "monospace", fontSize: 24, fontWeight: 800, letterSpacing: 4, flex: 1, color: G.t1 }}>{userKey}</span>
                  <button onClick={copyKey} style={{ background: G.bk, color: G.wh, border: "none", borderRadius: 8, padding: "8px 16px", fontSize: 14, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>Copy</button>
                </div>
                <button onClick={handleGenerateKey} disabled={keyLoading}
                  style={{ width: "100%", padding: "13px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t2, fontSize: 14, fontWeight: 600, cursor: "pointer", marginBottom: 16 }}>
                  {keyLoading ? "Generating…" : "Regenerate Key"}
                </button>
                <div style={{ fontSize: 12, color: G.tm, textAlign: "center", marginBottom: 16 }}>Regenerating will break the old Shortcut — update the key value in Shortcuts too.</div>
              </>
            ) : (
              <button onClick={handleGenerateKey} disabled={keyLoading}
                style={{ width: "100%", padding: "16px", borderRadius: 14, border: "none", background: G.bk, color: G.wh, fontSize: 17, fontWeight: 700, cursor: "pointer", marginBottom: 16 }}>
                {keyLoading ? "Generating…" : "Generate Key"}
              </button>
            )}

            <div style={{ background: G.bg2, borderRadius: 12, padding: "14px 16px", fontSize: 13, color: G.t2, lineHeight: 1.7 }}>
              <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 13 }}>Setup steps</div>
              <div>1. Tap <b>Generate Key</b> and copy the key</div>
              <div>2. Open <b>Shortcuts → My Shortcuts</b></div>
              <div>3. Edit your bank SMS shortcut</div>
              <div>4. Set the <b>key</b> field to your copied key</div>
              <div>5. Done — bank SMS will auto-log expenses</div>
            </div>
          </div>
        </div>
      )}

      {/* ══════ CATEGORY EDIT MODAL ══════ */}
      {catMod && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 999 }} onClick={() => { setCatMod(false); setDragIdx(null); }}>
          <div style={{ width: "100%", maxWidth: 390, background: G.bg, borderRadius: "20px 20px 0 0", padding: "24px 20px 40px", maxHeight: "85vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: G.lt, margin: "0 auto 18px" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>Manage Categories</div>
              <button onClick={switchToNewDefaults} title="Switch to new default categories" style={{ fontSize: 12, fontWeight: 600, color: G.t3, background: G.bg2, border: `1px solid ${G.bdr}`, borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}>✦ New defaults</button>
            </div>
            <div style={{ fontSize: 13, color: G.t3, marginBottom: 16 }}>Tap ≡ to pick a category, then tap ≡ on another to drop it there. Existing entries are unaffected.</div>

            {editCats.map((c, i) => {
              const locked = c.id === "investment";
              const isPicked = dragIdx === i;
              const isTarget = dragIdx !== null && dragIdx !== i;
              return (
                <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, borderRadius: 10, background: isPicked ? "#E8F4FF" : isTarget ? G.bg2 : "transparent", border: isPicked ? "2px dashed #4A90D9" : "2px solid transparent", transition: "background .15s" }}>
                  {/* Drag handle */}
                  <button
                    onClick={() => {
                      if (dragIdx === null) { setDragIdx(i); }
                      else if (dragIdx === i) { setDragIdx(null); }
                      else { moveCat(dragIdx, i); }
                    }}
                    title={dragIdx === null ? "Tap to pick up" : dragIdx === i ? "Tap to cancel" : "Tap to place here"}
                    style={{ background: isPicked ? "#4A90D9" : G.bg3, border: "none", borderRadius: 8, padding: "10px 8px", cursor: "pointer", fontSize: 14, color: isPicked ? "#fff" : G.t3, flexShrink: 0, lineHeight: 1 }}
                  >≡</button>
                  {/* Icon input */}
                  {locked ? (
                    <div style={{ width: 42, padding: "9px 0", borderRadius: 10, border: `2px solid ${G.lt}`, fontSize: 20, textAlign: "center", background: G.bg3, color: G.t3, boxSizing: "border-box", flexShrink: 0 }}>{c.icon}</div>
                  ) : (
                    <input type="text" value={c.icon} onChange={e => setEditCats(p => p.map((x, j) => j === i ? { ...x, icon: e.target.value } : x))} maxLength={2} style={{ width: 42, padding: "9px 0", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 20, outline: "none", textAlign: "center", background: G.bg2, color: G.t1, boxSizing: "border-box", flexShrink: 0 }} />
                  )}
                  {/* Label input */}
                  {locked ? (
                    <div style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: `2px solid ${G.lt}`, fontSize: 15, background: G.bg3, color: G.t3, boxSizing: "border-box", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>{c.label}</span>
                      <span style={{ fontSize: 10, color: G.tm, fontWeight: 600, letterSpacing: 0.3 }}>locked</span>
                    </div>
                  ) : (
                    <input type="text" value={c.label} onChange={e => setEditCats(p => p.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} maxLength={20} placeholder="Category name" style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, outline: "none", background: G.bg2, color: G.t1, boxSizing: "border-box" }} />
                  )}
                  {/* Delete button — not for investment */}
                  {!locked && (
                    <button onClick={() => { setEditCats(p => p.filter((_, j) => j !== i)); if (dragIdx === i) setDragIdx(null); }} title="Delete category" style={{ background: "none", border: "none", fontSize: 18, color: G.t3, cursor: "pointer", padding: "8px 4px", flexShrink: 0, lineHeight: 1 }}>{"\u2715"}</button>
                  )}
                </div>
              );
            })}

            {/* Add new category row */}
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
              <input type="text" value={newCatIcon} onChange={e => setNewCatIcon(e.target.value)} maxLength={2} placeholder="📦" style={{ width: 42, padding: "9px 0", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 20, outline: "none", textAlign: "center", background: G.bg2, color: G.t1, boxSizing: "border-box", flexShrink: 0 }} />
              <input type="text" value={newCatLabel} onChange={e => setNewCatLabel(e.target.value)} maxLength={20} placeholder="New category name…" onKeyDown={e => { if (e.key === "Enter") addNewCat(); }} style={{ flex: 1, padding: "9px 12px", borderRadius: 10, border: `2px solid ${G.bdr}`, fontSize: 15, outline: "none", background: G.bg2, color: G.t1, boxSizing: "border-box" }} />
              <button onClick={addNewCat} style={{ padding: "9px 14px", borderRadius: 10, border: "none", background: newCatLabel.trim() ? G.bk : G.bg3, color: newCatLabel.trim() ? G.wh : G.tm, fontSize: 14, fontWeight: 700, cursor: newCatLabel.trim() ? "pointer" : "default", flexShrink: 0 }}>+ Add</button>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setEditCats(OLD_DEFAULT_CATEGORIES.map(c => ({ ...c }))); setDragIdx(null); }} style={{ padding: "12px 14px", borderRadius: 12, border: `2px solid ${G.bdr}`, background: G.bg, color: G.t3, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Reset</button>
              <button onClick={saveCustomCats} disabled={catSaving} style={{ flex: 1, padding: "12px", borderRadius: 12, border: "none", background: G.bk, color: G.wh, fontSize: 16, fontWeight: 700, cursor: "pointer" }}>{catSaving ? "Saving…" : "Save"}</button>
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
