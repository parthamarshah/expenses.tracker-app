import * as addExpense from "../functions/api/add-expense.js";
import * as categories from "../functions/api/categories.js";
import * as deleteAccount from "../functions/api/delete-account.js";
import * as logSms from "../functions/api/log-sms.js";
import * as manageCategories from "../functions/api/manage-categories.js";
import * as stats from "../functions/api/stats.js";
import * as uncategorized from "../functions/api/uncategorized.js";
import * as updateExpense from "../functions/api/update-expense.js";

const API_ROUTES = {
  "/api/add-expense": addExpense,
  "/api/categories": categories,
  "/api/delete-account": deleteAccount,
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const module = API_ROUTES[url.pathname];
    if (!module) {
      return env.ASSETS.fetch(request);
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

    return handler({
      request,
      env,
      waitUntil: ctx.waitUntil.bind(ctx),
      passThroughOnException: ctx.passThroughOnException.bind(ctx),
    });
  },
};
