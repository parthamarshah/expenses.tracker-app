// Cloudflare Pages Function: /api/manage-categories
// iOS Shortcut API for managing user categories (list, add, edit, delete, reorder)
//
// GET  /api/manage-categories?key=xxx
//   → { ok: true, categories: [{id, label, icon}, ...] }
//
// POST /api/manage-categories?key=xxx
//   body: { action: "add",    label: "Gym",       icon: "🏋️" }
//   body: { action: "edit",   id: "custom_xyz",   label: "New Name", icon: "🏋️" }
//   body: { action: "delete", id: "custom_xyz" }
//   body: { action: "reorder", ids: ["groceries", "food", ...] }
//   → { ok: true, categories: [...updated...] }

import { createClient } from "@supabase/supabase-js";

const OLD_DEFAULT_CATEGORIES = [
  { id: "personal",   label: "Personal", icon: "👤" },
  { id: "work",       label: "Work",     icon: "💼" },
  { id: "home",       label: "Home",     icon: "🏠" },
  { id: "investment", label: "Savings",  icon: "₹"  },
];

async function getUserCats(supabase, userId) {
  const { data: prefsData } = await supabase
    .from("user_prefs").select("cats_json").eq("user_id", userId).maybeSingle();
  if (prefsData?.cats_json) {
    try {
      const parsed = JSON.parse(prefsData.cats_json);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  return OLD_DEFAULT_CATEGORIES.map(c => ({ ...c }));
}

async function saveUserCats(supabase, userId, cats) {
  // Ensure investment is always present
  if (!cats.find(c => c.id === "investment")) {
    cats.push({ id: "investment", label: "Savings", icon: "₹" });
  }
  await supabase.from("user_prefs").upsert({ user_id: userId, cats_json: JSON.stringify(cats) });
  return cats;
}

async function authenticate(supabase, token, cors) {
  if (!token) return { error: new Response(JSON.stringify({ ok: false, error: "No key provided" }), { status: 401, headers: cors }) };
  const { data: keyRow } = await supabase.from("user_keys").select("user_id").eq("key_value", token).maybeSingle();
  if (!keyRow) return { error: new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), { status: 401, headers: cors }) };
  return { userId: keyRow.user_id };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const token = (new URL(request.url).searchParams.get("key") || "").trim();

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { userId, error } = await authenticate(supabase, token, cors);
  if (error) return error;

  const cats = await getUserCats(supabase, userId);
  return new Response(JSON.stringify({ ok: true, categories: cats }), { headers: cors });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const token = (new URL(request.url).searchParams.get("key") || "").trim();

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { userId, error } = await authenticate(supabase, token, cors);
  if (error) return error;

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "Invalid JSON" }), { status: 400, headers: cors });
  }

  const { action } = body;
  let cats = await getUserCats(supabase, userId);

  if (action === "add") {
    const label = (body.label || "").trim();
    const icon  = (body.icon  || "📦").trim();
    if (!label) return new Response(JSON.stringify({ ok: false, error: "label required" }), { status: 400, headers: cors });
    const id = "custom_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    cats.push({ id, label, icon: icon || "📦" });

  } else if (action === "edit") {
    const { id, label, icon } = body;
    if (!id) return new Response(JSON.stringify({ ok: false, error: "id required" }), { status: 400, headers: cors });
    const idx = cats.findIndex(c => c.id === id);
    if (idx === -1) return new Response(JSON.stringify({ ok: false, error: "Category not found" }), { status: 404, headers: cors });
    if (label !== undefined) cats[idx].label = label.trim() || cats[idx].label;
    if (icon  !== undefined) cats[idx].icon  = icon.trim()  || cats[idx].icon;

  } else if (action === "delete") {
    const { id } = body;
    if (!id) return new Response(JSON.stringify({ ok: false, error: "id required" }), { status: 400, headers: cors });
    if (id === "investment") return new Response(JSON.stringify({ ok: false, error: "Savings category cannot be deleted" }), { status: 400, headers: cors });
    cats = cats.filter(c => c.id !== id);

  } else if (action === "reorder") {
    const { ids } = body;
    if (!Array.isArray(ids)) return new Response(JSON.stringify({ ok: false, error: "ids array required" }), { status: 400, headers: cors });
    const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
    const reordered = ids.filter(id => catMap[id]).map(id => catMap[id]);
    // Append any cats not in the ids list at the end
    const inList = new Set(ids);
    cats.filter(c => !inList.has(c.id)).forEach(c => reordered.push(c));
    cats = reordered;

  } else {
    return new Response(JSON.stringify({ ok: false, error: "Unknown action. Use: add, edit, delete, reorder" }), { status: 400, headers: cors });
  }

  const saved = await saveUserCats(supabase, userId, cats);
  return new Response(JSON.stringify({ ok: true, categories: saved }), { headers: cors });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
