# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## At a glance

**What this is:** A personal expense tracker — React SPA + Cloudflare Workers, backed by Supabase. Live at `expenses.gurjarbooks.com`. **There is no staging environment.**

**Stack:** React 19 + Vite · Supabase (Postgres + Auth + Realtime) · Cloudflare Workers (static assets + API routing)

**Key files / folders:**

| Path | Purpose |
|---|---|
| `src/App.jsx` | ~2200-line main component — owns all UI state |
| `src/supabase.js` | Only place with DB ↔ app mapping (`dbToExp`, `expToDb`, `dbToTrip`, `tripToDb`) |
| `src/AuthContext.jsx` | Auth wrapper — do not remove the `visibilitychange` listener |
| `src/worker.js` | Hand-rolled Worker router — dispatches `/api/*` to `functions/api/` handlers |
| `functions/api/` | Worker-mounted API handlers — use service key, bypass RLS, must scope by `user_id` |
| `*.sql` (top-level) | Migration files — applied manually in Supabase SQL editor, never run autonomously |

**Four things to know before touching anything:**

1. No staging — every merge to `master` ships to production immediately via Cloudflare Workers Git integration.
2. PRs with a `claude/` head branch auto-merge without human review.
3. Worker functions bypass Postgres RLS — the per-query `user_id` filter is the *only* guard.
4. The iOS Shortcut response shape (`labels`, `categories_map`, `categories_list`) is a live contract — renaming keys silently breaks every user's Shortcut.

---

## Review process

Output from this repo gets piped through a second AI model upstream before it's pushed — this is a quality practice, not an enforced merge gate, and the `claude/`-branch auto-merge workflow is intentional. The practical implication is that another model reads the diff cold, so optimize for that reader: name things plainly, keep control flow obvious, and add a short comment when a decision relies on context outside the diff (e.g. Supabase RLS, iOS Shortcut response contract, OLD vs NEW default-category back-compat). Don't golf, don't fold logic into one-liners to save lines, don't lean on side-effects in expressions.

## Hard rules

These are non-negotiable regardless of what is being asked:

- **Never access cross-user data.** Every query in a Worker function must be scoped by the resolved `user_id`. A query that can return another user's expenses is a P0 security bug, not a style issue.
- **Never run schema migrations autonomously.** All `.sql` migration files are applied manually in the Supabase SQL editor. Do not run them, generate migration commands, or modify existing migration files without explicit confirmation.
- **Never change the iOS Shortcut response contract.** The shape returned by `categories.js` and `log-sms.js` (`labels`, `categories_map`, `categories_list`) is parsed by the iOS Shortcut directly. Renaming or removing keys silently breaks the Shortcut for every user. If a change is needed, flag it explicitly and confirm before touching.
- **Never remove the `visibilitychange` listener in `AuthContext.jsx`.** It fixes a real Safari PWA bug where `onAuthStateChange` doesn't fire after OAuth redirect. It looks like dead code. It is not.
- **Never log secrets, user API keys, or raw SMS bodies.** The `key_value` tokens in `user_keys` are credentials. Raw SMS text contains bank transaction data. Neither should appear in Cloudflare logs, error responses, or console output.
- **Never force-push to `master`.** The `claude/` auto-merge workflow means PRs from that branch prefix merge without human review — be more careful on those branches, not less.
- **Never add a GitHub Actions deploy workflow.** Cloudflare Workers Git integration handles deploys on push to `master`. A parallel workflow causes double-deploys.

## Production safety

There is no staging environment. Every merged change goes live immediately on expenses.gurjarbooks.com.

- Before touching any Worker function, verify locally with `npm run preview` (runs full Worker + assets via wrangler/miniflare).
- For frontend changes, `npm run dev` and exercise the affected flow manually.
- The `claude/` auto-merge workflow squash-merges any PR whose head ref starts with `claude/` without human review. Treat every such PR as if it deploys immediately.
- Observability: Cloudflare dashboard has real-time log tail for Workers. Supabase has query logs. If something breaks silently, check those first.
- The `categories.js` endpoint has a 5-minute edge cache (`caches.default`, keyed by full URL). If a category change isn't showing up, cache is the first suspect — not a bug.
- Run `npm run smoke` after any deploy that touches Workers config — it hits `/api/health` in production to confirm runtime env vars are present.

## Pre-approved commands

These are safe to run without asking:

- `npm install`, `npm run dev`, `npm run build`, `npm run preview`, `npm run lint`, `npm run smoke`
- `npx eslint <path>` for targeted lint checks
- `git status`, `git diff`, `git log`, `git show`, `git branch`, `git remote -v`
- `gh pr view`, `gh pr list`, `gh run list`, `gh run view`
- Read-only file operations: `ls`, `cat` (via Read tool), `grep`, `find`, `wc`

Anything that mutates state — `git push`, `git commit`, `git checkout -B`, `npm run deploy`, Supabase migrations, `rm`, dependency upgrades — needs explicit confirmation.

## Commands

```bash
npm run dev      # Vite dev server (HMR, browser-only — /api/* not served)
npm run build    # production build (uses @cloudflare/vite-plugin → dist/client + dist/expenses_tracker_app)
npm run preview  # build + wrangler dev (full Worker + assets on miniflare)
npm run lint     # eslint . (flat config in eslint.config.js)
npm run deploy   # build + wrangler deploy (manual prod deploy; normally CI does this)
npm run smoke    # hit /api/health in production to confirm runtime env vars are present
```

`npm run dev` does NOT run the Worker — it only serves the SPA. To exercise `/api/*` locally use `npm run preview`. Both require `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in env (a `.dev.vars` file is loaded by wrangler for runtime vars).

## Architecture

### The two API surfaces

This is the single biggest thing to understand before editing.

**1. Browser → Supabase directly.** `src/supabase.js` creates a client with the anon key. RLS policies in Supabase enforce per-user isolation. All SPA reads/writes (expenses, trips, prefs) go through this path.

**2. iOS Shortcut → `/api/*` → Worker → Supabase service-role.** The Worker uses `SUPABASE_SERVICE_KEY` (bypasses RLS) and authenticates each request itself by looking up the caller's `key` query param / body field / `Authorization` header against the `user_keys` table. This is a separate auth scheme from Supabase Auth — a per-user opaque token the user sees in the SPA's Profile screen.

`/api/delete-account` is the exception: uses Supabase access token + `auth.getUser()`, and CORS is locked to `https://expenses.gurjarbooks.com` (every other `/api/*` is `Access-Control-Allow-Origin: *`).

### Worker routing shim (`src/worker.js`)

A hand-rolled router that imports each `functions/api/*.js` module and dispatches `request.url.pathname` → `onRequestGet` / `onRequestPost` / `onRequestOptions` based on method. Non-`/api/*` requests fall through to `env.ASSETS.fetch(request)` (the SPA, with `not_found_handling: single-page-application`).

Quirks:

- **Lowercase paths only.** The router keys are `/api/foo`. `/API/FOO` does not match — it falls through to the SPA and returns `index.html`.
- **Adding a new endpoint** = create `functions/api/your-endpoint.js` with `onRequest*` exports AND register it in `API_ROUTES` in `src/worker.js`. The shim does not auto-discover.
- **The handlers retain Pages-Functions context shape** (`{ request, env, waitUntil, passThroughOnException }`) so they can be edited without thinking about Workers semantics. Don't pass `params`, `next`, or `data` — nothing uses them and the shim doesn't construct them.
- **Missing env vars are caught early.** The Worker checks for `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` before dispatching and returns JSON 500 (never HTML) if either is absent. See `INCIDENTS.md` (2026-05-07) for why this matters.

### Worker functions (`functions/api/`)

⚠️ **Security model — read this first:** Worker functions use `SUPABASE_SERVICE_KEY`, which bypasses Row Level Security entirely. The *only* thing preventing user A from reading user B's data is the manual `user_id` filter in each query. There is no RLS safety net here. Every function must: (1) authenticate by looking up the bearer token or `?key=` param in `user_keys`, (2) resolve the `user_id` from that lookup, and (3) scope every subsequent Supabase query by that `user_id`. Skip any of these steps and the endpoint leaks data.

- `log-sms.js` — the largest one (~580 lines). Pipeline: `identifyBank` → `isDebitSms` (rejects OTPs, declines, balance-only) → `detectPayMode` → match against the user's configured `banks_json` (last4 first, then bank name) → resolve category from `user_prefs.cats_json` → insert. When changing parser logic, manually exercise via curl with representative SMS strings before merging.
- `add-expense.js` — manual cash/Shortcut entry. Has a special `category === "do_not_log"` short-circuit and a `trip_*` prefix that routes to `trips`.
- `categories.js` (GET) and `manage-categories.js` (GET/POST add/edit/delete/reorder) — drive the iOS Shortcut category picker. `categories.js` uses `caches.default` with a 5-minute TTL keyed by full request URL — invalidate by changing the key or waiting it out when iterating.
- `update-expense.js`, `uncategorized.js`, `stats.js` (public anonymous aggregate for the landing page, 10-min edge cache).
- `delete-account.js` — deletes all data for the authenticated user across all tables. This is irreversible. Confirm the deletion scope before modifying — it is also the user's only GDPR-style erasure path.
- `health.js` — unauthenticated, no DB round-trip, reports which required env vars are present. Use for post-deploy verification (`npm run smoke`).

The shape returned to Shortcuts (`labels`, `categories_map`, `categories_list`) is a contract — the iOS Shortcut parses these names. Don't rename keys without updating both shortcuts.

**Secret handling:** Never log `SUPABASE_SERVICE_KEY`, `key_value` tokens, or raw SMS text at any log level. Never return a token value in an error response. If a function needs to report an auth failure, return a 401 with a generic message — not the token that was received.

### Frontend (`src/`)

- **`App.jsx`** is a single ~2200-line `ExpenseTracker` component that owns all UI state (expenses, trips, categories, banks, filters, modals, mindful-insights). Section headers (`// ── State ──`, `// ── CRUD ──`, `// ── Render ──`, etc.) divide it; navigate by those rather than scrolling.
- **`API_BASE` is hardcoded to `https://expenses.gurjarbooks.com`** in `src/App.jsx`. Used for the SMS endpoint string shown in Shortcut setup and the `/api/delete-account` fetch. Don't make it dynamic — the Shortcut needs a stable URL even when developing on a different origin.
- **`AuthContext.jsx`** wraps Supabase auth. Note the `visibilitychange` listener — it works around a Safari PWA bug where `onAuthStateChange` doesn't fire after returning from an OAuth redirect.
- **`Auth.jsx`** has both the sign-in screen and a `PasswordReset` flow gated by the `PASSWORD_RECOVERY` event from Supabase.
- **`supabase.js`** is the only place that knows about the snake_case ↔ camelCase mapping: `dbToExp` / `expToDb` / `dbToTrip` / `tripToDb`. Everywhere else in the app uses camelCase. Always go through these helpers when crossing the DB boundary, including in Worker functions when responding with app-shaped objects.

### Data model (Supabase Postgres)

Migrations are top-level `*.sql` files, applied manually in the Supabase SQL editor:

- `migration.sql` — `expenses`, `trips` + RLS + realtime publication.
- `user_keys_migration.sql` — per-user API tokens used by iOS Shortcuts. Worker functions look up `user_id` by `key_value`.
- `user_prefs_migration.sql` — `cats_json`, plus added-later columns `banks_json` and `mindful_json` (code is resilient to those columns missing).
- `categories_migration.sql` — `user_categories` table (declared but the live category source of truth is `user_prefs.cats_json` — keep that in mind before reaching for `user_categories`).
- `trip_hidden_migration.sql` — `trips.hidden` boolean.

Every user table has RLS `auth.uid() = user_id`. Realtime is enabled on `expenses`, `trips`, `user_categories`. The frontend subscribes per-user (`exp:${userId}`, `trp:${userId}`) and reconciles INSERT/UPDATE/DELETE optimistically.

**Casing convention:** DB columns are `snake_case`, app objects are `camelCase`. Conversions live in `src/supabase.js` — use them at every Supabase boundary; don't pass raw DB rows into UI state or vice versa.

### Environment variables

Build-time (Vite inlines into the JS bundle — set under "Build → Variables and Secrets" in Cloudflare dashboard):
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Runtime (Worker bindings — set under top-level "Variables and Secrets" in Cloudflare dashboard):
- `SUPABASE_URL` (same value as above, but available to the Worker at runtime)
- `SUPABASE_SERVICE_KEY` (service-role key, bypasses RLS — treat as a root password)

**These are two separate sections of the Cloudflare dashboard.** Missing build-time vars: SPA shows a red banner, every read/write fails. Missing runtime vars: every `/api/*` call returns JSON 500. The 2026-05-07 incident (`INCIDENTS.md`) was caused by forgetting to set runtime vars after migrating from Pages to Workers. Run `npm run smoke` after any deploy that touches Workers config to verify both halves.

### Categories quirks

There are two default category sets: `OLD_DEFAULT_CATEGORIES` (Personal/Work/Home/Savings) for users who signed up before the redesign, and `NEW_DEFAULT_CATEGORIES` (Groceries/Food/Travel/Entertainment/...) seeded only when a brand-new user has zero expenses. The `investment` id is special-cased throughout (excluded from spend totals, mindful analysis, etc.) and is force-added back if missing in `manage-categories.js`. `UNCAT` (`"uncategorized"`) is a system sentinel for orphaned expenses and is never shown in the Add form.

### Mindful Insights

Pure client-side, in the top of `App.jsx`. `learnEssentialSigs` builds per-user "essential" signatures (≥3 occurrences, CV ≤ 0.6, across ≥2 weeks, last 6 months); `computeBaselines` produces weekday/weekend per-category averages used by `timeDayWeight` to rank "avoidable" discretionary spend. User can override via `essentialSigs` / `avoidableSigs` in `user_prefs.mindful_json`. The monthly auto-popup is gated on prior-3-month activity (`checkMindfulEligibility`) and a per-user `localStorage` "shown this month" key.

### Deployment

Cloudflare Workers Git integration auto-deploys on every `master` push. There is no GitHub Actions deploy workflow — don't add one. `vite.config.js` splits `vendor-react` and `vendor-supabase` into separate cached chunks so the app chunk is the only thing that re-downloads on update. `public/_headers` sets security headers and a 1-year immutable cache on `/assets/*`. The GitHub workflow `auto-merge-claude.yml` squash-merges any PR whose head ref starts with `claude/`.
