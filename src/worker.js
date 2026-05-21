import * as addExpense from "../functions/api/add-expense.js";
import * as categories from "../functions/api/categories.js";
import * as deleteAccount from "../functions/api/delete-account.js";
import * as health from "../functions/api/health.js";
import * as logSms from "../functions/api/log-sms.js";
import * as manageCategories from "../functions/api/manage-categories.js";
import * as stats from "../functions/api/stats.js";
import * as uncategorized from "../functions/api/uncategorized.js";
import * as updateExpense from "../functions/api/update-expense.js";

// Belt-and-suspenders fallback. SUPABASE_URL is also declared in wrangler.jsonc
// vars so it survives every deploy, but this constant protects against any future
// misconfiguration without requiring a secret rotation.
const FALLBACK_SUPABASE_URL = "https://ecngekbnirgdynqdnxlx.supabase.co";

const API_ROUTES = {
  "/api/add-expense": addExpense,
  "/api/categories": categories,
  "/api/delete-account": deleteAccount,
  "/api/health": health,
  "/api/log-sms": logSms,
  "/api/manage-categories": manageCategories,
  "/api/stats": stats,
  "/api/uncategorized": uncategorized,
  "/api/update-expense": updateExpense,
};

const METHOD_EXPORT = {
  GET: "onRequestGet",
  POST: "onRequestPost",
  PUT: "onRequestPut",
  PATCH: "onRequestPatch",
  DELETE: "onRequestDelete",
  HEAD: "onRequestHead",
  OPTIONS: "onRequestOptions",
};

const jsonError = (status, error) =>
  new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });

export default {
  async fetch(request, env, ctx) {
    // Ensure SUPABASE_URL is always populated — wrangler.jsonc vars is the
    // primary source; this constant is a last-resort fallback.
    env.SUPABASE_URL = env.SUPABASE_URL || FALLBACK_SUPABASE_URL;

    const url = new URL(request.url);
    const module = API_ROUTES[url.pathname];
    if (!module) {
      return env.ASSETS.fetch(request);
    }

    // SUPABASE_URL is now always present (wrangler vars + code fallback above).
    // SUPABASE_SERVICE_KEY is the only remaining failure mode.
    if (url.pathname !== "/api/health" && !env.SUPABASE_SERVICE_KEY) {
      console.error("[worker] missing env: SUPABASE_SERVICE_KEY");
      return jsonError(500, "Server misconfigured");
    }

    const exportName = METHOD_EXPORT[request.method];
    const handler = (exportName && module[exportName]) || module.onRequest;
    if (!handler) {
      const allowed = Object.entries(METHOD_EXPORT)
        .filter(([, name]) => typeof module[name] === "function")
        .map(([method]) => method)
        .join(", ");
      return new Response("Method Not Allowed", {
        status: 405,
        headers: allowed ? { Allow: allowed } : undefined,
      });
    }

    try {
      return await handler({
        request,
        env,
        waitUntil: ctx.waitUntil.bind(ctx),
        passThroughOnException: ctx.passThroughOnException.bind(ctx),
      });
    } catch (err) {
      console.error("[worker]", url.pathname, err?.stack || err);
      return jsonError(500, "Internal error");
    }
  },
};
