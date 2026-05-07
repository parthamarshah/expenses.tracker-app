# Production Incidents

Append-only log. Newest first. One entry per production incident, using the template below. When something in `KNOWN_RISKS.md` actually fires, move it here.

**Template per entry**

- **Symptom** — what users saw (their words where possible).
- **Detection** — how we learned about it, and how long it took.
- **Root cause** — the actual technical cause, with file/line/log references.
- **Fix** — what restored service.
- **Learnings** — short, blunt observations.
- **Long-term mitigations** — links to the work that prevents recurrence.

---

## 2026-05-07 — Supabase URL missing on Worker after Pages → Workers migration

**Symptom**

- iOS Shortcut "Expense Log" failed with: *"Conversion Error: Get Dictionary Value failed because Shortcuts couldn't convert from Rich Text to Dictionary."*
- SPA cash-expense save showed a "Sync error" toast and the entry never persisted server-side.
- Both surfaces had been working until shortly before the report.

**Detection**

- User-reported. No automated alert was in place.
- Time-to-diagnose ≈ 1 hour, almost all of it spent manually paging through Cloudflare Workers Logs.

**Root cause**

The runtime env var `SUPABASE_URL` was missing on the Cloudflare Worker. Every `/api/*` handler does `createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, …)`; with the URL undefined, supabase-js threw at construction time:

```
supabaseUrl is required.
  at validateSupabaseUrl   (vendor-supabase-D6pgPe9c.js:11229:26)
  at new SupabaseClient    (vendor-supabase-D6pgPe9c.js:11267:21)
  at createClient          (vendor-supabase-D6pgPe9c.js:11446:10)
  at onRequestGet$3        (index.js:131:20)
GET /api/categories?key=… → outcome: exception
Ray ID: 9f8042ce3b2e9c77
```

`src/worker.js` (pre-fix) invoked the handler with no `try/catch`, so the throw bubbled up to the runtime and Cloudflare served its default **HTML 1101 "Worker threw exception"** page. The iOS Shortcut, expecting JSON, parsed the HTML as Rich Text and failed the next `Get Dictionary Value` step with the very confusing message above.

The trigger was PR #14 (Apr 23) migrating the deployment from Cloudflare **Pages** to a Cloudflare **Worker with static assets**. Env vars on Pages projects do not auto-migrate to Workers projects — they live on different objects in the dashboard. The build-time vars (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` under "Build → Variables and Secrets") and the runtime vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` under top-level "Variables and Secrets") all needed to be re-added; neither set was. CLAUDE.md ("Environment variables") had warned about this exact failure mode in prose, but prose is not a check.

**Fix**

- Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` under Worker → Settings → **Variables and Secrets**.
- Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` under Worker → Settings → **Build → Variables and Secrets**.
- Re-ran the latest build from the Cloudflare dashboard so the new build-time values were inlined into the SPA bundle.
- Verified end-to-end: iOS Shortcut posted successfully, SPA cash-expense save synced.

**Learnings**

1. A missing config produced an HTML response, not a JSON error — the worst possible failure mode for an API consumed by a brittle iOS Shortcut.
2. The Worker shim swallowed all context: the actual exception and stack only became visible by manually pulling Workers Logs.
3. We had no programmatic way to verify a deploy was healthy short of manually exercising both surfaces.
4. CLAUDE.md correctly predicted this failure class. Prose warnings aren't enough; they need to be executable checks.

**Long-term mitigations** (this PR)

- `src/worker.js` now refuses to dispatch to handlers when `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` is missing — returns JSON `{ ok: false, error: "Server misconfigured" }` 500 with permissive CORS, never HTML.
- `src/worker.js` wraps handler dispatch in `try/catch`. Any uncaught exception (current or future) becomes JSON `{ ok: false, error: "Internal error" }` 500. Full stack still goes to `console.error` for Workers Logs; clients only see a generic message.
- New `functions/api/health.js` endpoint reports which env vars are missing (operator-facing, no auth, no DB round-trip).
- New `npm run smoke` script hits `/api/health` against production for a one-shot post-deploy check.
- New `.github/workflows/ci.yml` runs `build` (required) and `lint` (informational, `continue-on-error`) on every PR. `auto-merge-claude.yml` switched to GitHub's auto-merge so a failing build blocks the merge once branch protection requiring the `build` check is enabled on `master`. Lint stays informational until the existing 50+ pre-existing eslint errors in `src/App.jsx` are cleaned up.
- `src/supabase.js` shows a visible red banner at the top of the SPA when build-time vars are missing, instead of silently 500'ing every read/write.
