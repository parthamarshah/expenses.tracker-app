# Known Risks

Living document. Latent issues we know about but haven't fixed. Items get moved to `INCIDENTS.md` if they ever fire, or deleted from this file once mitigated. Triage roughly: **High** = could realistically take down production or leak data; **Medium** = silent data corruption / poor user experience; **Low** = footgun, not yet bitten by it.

---

## High

### Service-role key is a single root credential

`functions/api/*.js` all initialize Supabase with `SUPABASE_SERVICE_KEY`, which bypasses every RLS policy. Anyone with read access to the Cloudflare Worker's "Variables and Secrets" — or any future log line that prints `env` — has full database access for every user. CLAUDE.md flags this ("treat as a root password") but it bears repeating here.

*Mitigation:* Never log `env` or any object derived from it. Rotate the key whenever the Cloudflare dashboard access list changes. Any future logging or error-reporting work must explicitly audit for service-key leakage before shipping.

### No rate limiting on shortcut endpoints

`/api/log-sms`, `/api/categories`, `/api/add-expense`, `/api/update-expense`, `/api/manage-categories`, `/api/uncategorized`, and `/api/stats` authenticate via key lookup in `user_keys`. There is no per-IP or per-key throttle. A brute-force attacker could enumerate live keys, and a single buggy iOS Shortcut could hammer the Worker with no backstop.

*Mitigation:* add a Cloudflare Workers Ratelimits binding keyed on the request `key` query param + IP. Cap at, say, 60 req/min/key.

---

## Medium

### Optimistic UI never rolls back on Supabase failure

`src/App.jsx`:
- `doSave` (~`:582-614`)
- `doDel` (~`:616-623`)
- `doSaveTrip` (~`:634-651`)
- `doDelTrip` (~`:655-666`)

All update local React state and then fire-and-forget the Supabase call inside `.then()`. On DB error the user sees a toast but the UI keeps showing the (now phantom) entry. The user's view diverges from the server.

*Mitigation:* capture prior state before each mutation, restore on error. Needs care because some of these mutations are batched (e.g. trip archive).

### No React error boundary

`src/main.jsx` wraps `<App />` in `<AuthProvider>` and `<StrictMode>` only. Any render exception inside the 2200-line `App.jsx` white-screens the entire app — the user has no path back short of a hard reload.

*Mitigation:* add a top-level error boundary with a "Reload" fallback. Log the error to `console.error` (visible in browser devtools).

### `functions/api/stats.js` returns `ok: true` on DB failure

Around `stats.js:40-45`, when the Supabase query errors out, the handler still responds with `{ ok: true, …null counts }`. Clients can't distinguish "user has no expenses this period" from "DB query failed". Pre-existing bug, not from this incident.

*Mitigation:* return `{ ok: false, error }` 500 on Supabase error.

### No tests on the SMS parser

`functions/api/log-sms.js` is ~580 lines of bank-specific regex/string parsing. Every change is verified manually by curling a few representative SMS strings. Bank message formats change without notice, and regressions are silent — the iOS Shortcut just stops categorizing correctly.

*Mitigation:* a Vitest suite with fixtures for HDFC, ICICI, SBI, Axis, Kotak, IndusInd, IDFC, Yes, PNB, BOB, Federal, Canara (the banks already in the parser's table). Run as part of `ci.yml`.

### `API_BASE` is hardcoded in `src/App.jsx`

If the production domain ever changes, the iOS Shortcut breaks silently — the SPA still works against Supabase directly, so we won't notice from the UI. CLAUDE.md says don't make it dynamic (the Shortcut needs a stable URL even when developing on a different origin) — fair, but we should have a runbook entry for "domain change → update API_BASE in `App.jsx` and re-publish the iOS Shortcut".

*Mitigation:* add a runbook entry. Not a code change.

---

## Low

### Build-vs-runtime env vars are easy to confuse

Two separate sections of the Cloudflare dashboard, four total var names. The 2026-05-07 incident hinged on this. CLAUDE.md documents both, but a one-page production env checklist would make it harder to miss again.

*Mitigation:* add a "Production env checklist" section to CLAUDE.md or the project README, with the four var names, where they live, and how to test each one (`npm run smoke` for runtime, hard-reload + check banner absence for build-time).

### `/api/log-sms` echoes parsed transaction details

The successful response includes `amount`, parsed merchant note, last4, and bank name. Nothing logs these server-side today. If anyone ever adds request/response logging for debugging, those fields must be redacted before they hit Workers Logs (which retain for ≥ 24h).

*Mitigation:* add a comment to `log-sms.js` near the response builder noting "do not log this object verbatim". Consider a structured logger that whitelists fields when added.

### Auto-merge runs on every push, including draft PRs after they're marked ready

The new `auto-merge-claude.yml` includes `ready_for_review` so draft → ready transitions trigger auto-merge enablement. This is intended, but worth flagging — pushing a draft `claude/` branch and then marking it ready will deploy it the moment CI passes.

*Mitigation:* none needed; documented here for awareness. If unwanted, drop `ready_for_review` from the trigger types.
