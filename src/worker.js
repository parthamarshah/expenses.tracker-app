import * as addExpense from "../functions/api/add-expense.js";
import * as categories from "../functions/api/categories.js";
import * as deleteAccount from "../functions/api/delete-account.js";
import * as health from "../functions/api/health.js";
import * as logSms from "../functions/api/log-sms.js";
import * as manageCategories from "../functions/api/manage-categories.js";
import * as stats from "../functions/api/stats.js";
import * as uncategorized from "../functions/api/uncategorized.js";
import * as updateExpense from "../functions/api/update-expense.js";

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
    const url = new URL(request.url);
    const module = API_ROUTES[url.pathname];
    if (!module) {
      return env.ASSETS.fetch(request);
    }

    // Refuse to dispatch handlers when required Worker bindings are missing.
    // Without this, supabase-js throws "supabaseUrl is required" inside every
    // handler and the unhandled exception becomes Cloudflare's HTML 1101 page,
    // which the iOS Shortcut can't parse. /api/health is exempt so operators
    // can still ask the Worker which vars are missing.
    if (url.pathname !== "/api/health" && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY)) {
      console.error("[worker] missing env: SUPABASE_URL or SUPABASE_SERVICE_KEY");
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
