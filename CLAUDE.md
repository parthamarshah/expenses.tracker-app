# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

Personal expense tracker (production at `expenses.gurjarbooks.com`) with two distinct surfaces:

- **Browser SPA** for manual expense management.
- **`/api/*` HTTP endpoints** consumed by an iOS Shortcut that auto-logs expenses from bank-debit SMS messages.

Stack: React 19 + Vite SPA, Cloudflare Workers (static assets + Worker entry), Supabase (Postgres + Auth).

## Commands

```
npm run dev      # vite dev server (browser-only; /api/* routes are not served)
npm run build    # vite build (uses @cloudflare/vite-plugin → dist/client + dist/expenses_tracker_app)
npm run preview  # build + wrangler dev (full Worker + assets locally on miniflare)
npm run lint     # eslint .
npm run deploy   # build + wrangler deploy (manual prod deploy; normally CI does this)
```

`npm run dev` does NOT run the Worker — it only serves the SPA. To exercise `/api/*` locally use `npm run preview`. Both require `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in env (a `.dev.vars` file is loaded by wrangler for runtime vars).

## Deploy pipeline

- **Cloudflare Workers Git integration** auto-deploys on every `master` push. There is no GitHub Actions deploy workflow — don't add one.
- **`.github/workflows/auto-merge-claude.yml`** squash-merges any open PR whose head branch starts with `claude/` immediately after it's opened. Treat any commit on a `claude/*` branch as effectively going to production within seconds of opening a PR.

## Architecture: the two API surfaces

This is the single biggest thing to understand before editing.

**1. Browser → Supabase directly.** `src/supabase.js` creates a client with the anon key. RLS policies in Supabase enforce per-user isolation. All SPA reads/writes (expenses, trips, prefs) go through this path.

**2. iOS Shortcut → `/api/*` → Worker → Supabase service-role.** The Worker uses `SUPABASE_SERVICE_KEY` (bypasses RLS) and authenticates each request itself by looking up the caller's `key` query param / body field / `Authorization` header against the `user_keys` table. This is a separate auth scheme from Supabase Auth — a per-user opaque token the user sees in the SPA's Profile screen.

`/api/delete-account` is the exception: uses Supabase access token + `auth.getUser()`, and CORS is locked to `https://expenses.gurjarbooks.com` (every other `/api/*` is `Access-Control-Allow-Origin: *`).

## The Worker routing shim

`src/worker.js` is a hand-rolled router. It imports each `functions/api/*.js` module and dispatches `request.url.pathname` → `onRequestGet` / `onRequestPost` / `onRequestOptions` based on method. Non-`/api/*` requests fall through to `env.ASSETS.fetch(request)` (the SPA, with `not_found_handling: single-page-application`).

Quirks:

- **Lowercase paths only.** The router keys are `/api/foo`. `/API/FOO` does not match — it falls through to the SPA fallback and returns `index.html`.
- **Adding a new endpoint** = create `functions/api/your-endpoint.js` with `onRequest*` exports AND register it in `API_ROUTES` in `src/worker.js`. The shim does not auto-discover.
- **The handlers retain Pages-Functions context shape** (`{ request, env, waitUntil, passThroughOnException }`) so they can be edited without thinking about Workers semantics. Don't pass `params`, `next`, or `data` — nothing uses them and the shim doesn't construct them.

## Environment variables

Build-time (Vite inlines into the JS bundle):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Runtime (Worker bindings, used by `functions/api/*`):
- `SUPABASE_URL` (same value as above, but available to the Worker)
- `SUPABASE_SERVICE_KEY` (service-role key, bypasses RLS — treat as a root password)

In Cloudflare's dashboard the build vars live under "Build → Variables and Secrets" and runtime vars under the top-level "Variables and Secrets". Both must be set; missing either breaks a different half of the app.

## Database

Postgres on Supabase. Tables (defined in the `*_migration.sql` files at repo root, run manually in Supabase SQL Editor):

- `expenses`, `trips` — main data, per-user via `user_id` FK to `auth.users`
- `user_prefs` — per-user JSON blobs: `cats_json` (categories), `banks_json` (bank/card config for SMS matching), `mindful_json`
- `user_categories` — older categories table; current code primarily reads from `user_prefs.cats_json`
- `user_keys` — opaque per-user API tokens for Shortcut auth

**Casing convention**: DB columns are `snake_case`, app objects are `camelCase`. Conversions live in `src/supabase.js` as `dbToExp` / `expToDb` / `dbToTrip` / `tripToDb` — use them at every Supabase boundary; don't pass raw DB rows into UI state or vice versa.

## Code layout notes

- **`src/App.jsx` is ~2200 lines** and contains the entire UI (every screen, every modal, all state). Resist splitting it without a clear reason — it's intentionally one file for this app's scale.
- **`API_BASE` is hardcoded to `https://expenses.gurjarbooks.com`** in `src/App.jsx`. Used for: the SMS endpoint string shown to the user for Shortcut setup, and the `/api/delete-account` fetch. Don't make it dynamic — the Shortcut needs a stable URL even when developing on a different origin.
- **`functions/api/log-sms.js`** is the largest Function (~580 lines). It identifies the bank, classifies debit-vs-other, parses amount, extracts the merchant note, and matches against the user's configured cards/accounts via `last4`. Most edits to SMS support land here.
- **No tests.** When changing parser logic in `log-sms.js`, manually exercise via curl with representative SMS strings before merging.

## Operational docs

- **`INCIDENTS.md`** — append-only log of production incidents (symptom, root cause, fix, learnings).
- **`KNOWN_RISKS.md`** — latent issues we've identified but haven't fixed. Triage with this list before adding "could we also…" items mid-PR.
- **`/api/health`** — no-auth GET endpoint that reports missing runtime env vars. Run `npm run smoke` after a deploy to verify production.
