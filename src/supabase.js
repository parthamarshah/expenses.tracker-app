import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// If the build-time Supabase vars are missing the SPA would otherwise fail
// silently on every read/write. Surface a visible banner so a misconfigured
// production deploy is obvious instead of looking like a generic sync bug.
if (!url || !key) {
  console.error("[supabase] missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in build env");
  if (typeof document !== "undefined") {
    const showBanner = () => {
      if (!document.body || document.getElementById("supabase-config-error")) return;
      const el = document.createElement("div");
      el.id = "supabase-config-error";
      el.textContent = "Configuration error. Contact admin.";
      el.style.cssText =
        "background:#b00020;color:#fff;padding:12px;text-align:center;font:14px system-ui,sans-serif;position:sticky;top:0;z-index:9999";
      document.body.insertBefore(el, document.body.firstChild);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showBanner, { once: true });
    } else {
      showBanner();
    }
  }
}

export const supabase = createClient(url || "https://invalid.local", key || "invalid", {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  realtime: { params: { eventsPerSecond: 10 } },
});

// DB (snake_case) → App (camelCase)
export const dbToExp = (r) => ({
  id: r.id, amount: r.amount, note: r.note || "",
  category: r.category, payMode: r.pay_mode,
  date: r.date, tripId: r.trip_id ?? null,
});

export const dbToTrip = (r) => ({
  id: r.id, name: r.name, budget: r.budget, icon: r.icon || "\u2708\uFE0F",
  createdAt: r.created_at, pinned: r.pinned, archived: r.archived,
  hidden: r.hidden === true,
});

// App (camelCase) → DB (snake_case)
export const expToDb = (e, userId) => ({
  id: e.id, user_id: userId, amount: e.amount, note: e.note || "",
  category: e.category, pay_mode: e.payMode,
  date: e.date, trip_id: e.tripId ?? null,
});

export const tripToDb = (t, userId) => ({
  id: t.id, user_id: userId, name: t.name, budget: t.budget || 0, icon: t.icon || "\u2708\uFE0F",
  created_at: t.createdAt, pinned: t.pinned, archived: t.archived,
  hidden: t.hidden === true,
});
