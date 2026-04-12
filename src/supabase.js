import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(url, key, {
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
});
