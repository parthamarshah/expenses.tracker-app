# Privacy Policy

_Last updated: 2026-07-16_

This document describes what data Expense Tracker (`expenses.gurjarbooks.com`) collects, how it's used, and what control you have over it. This is a small, personally-run app — this policy describes exactly what the code does, not generic legal boilerplate.

## What we store

- **Account**: your email address and authentication credentials, via Supabase Auth.
- **Expenses & trips**: amounts, categories, notes, payment mode, and dates you enter — either manually in the app or via the iOS Shortcut integration.
- **Bank SMS parsing**: if you use the iOS Shortcut integration, the text of forwarded bank SMS is sent to our server to extract an amount, merchant note, and payment mode, then discarded — the raw SMS text itself is not stored, only the extracted expense record.
- **Preferences**: your categories, configured banks/cards (label and last 4 digits only — never full card or account numbers), and app settings.

All of this data is scoped to your account and protected by database-level access rules (Postgres Row Level Security) — no other user can query it, and internal server functions that bypass this protection for the Shortcut integration explicitly filter every query by your account.

## Anonymized SMS samples for improving parsing accuracy

To improve how accurately we parse bank SMS (a genuinely hard problem — banks change their message formats without notice), we sample **at most one SMS message per user per week** from messages you forward via the iOS Shortcut, and store a **redacted** version to build a test corpus.

What this means concretely:

- **Redaction happens before anything is stored.** Amounts, card/account digits, phone numbers, dates, and UPI transaction IDs are replaced with placeholder characters. Free-text payee names or unfamiliar merchant strings are also removed — if we can't confidently redact a message, it's simply not sampled that week, rather than storing something under-redacted.
- **The stored sample cannot be linked back to your account.** No user ID, email, or account reference is ever stored alongside it — not even in a disguised or hashed form. There is no way for us, or anyone with database access, to determine which user a given sample came from.
- **Because there's no linkage, these samples are not covered by account deletion.** When you delete your account, all of your expenses, trips, preferences, and API keys are permanently erased — but any anonymized sample already contributed can't be identified as yours to remove, since it was never connected to your account in the first place.
- **This is on by default**, since it's the only way to meaningfully improve parsing for everyone (including you). You can turn it off at any time in **Profile → Help improve SMS parsing**. Turning it off takes effect going forward — it doesn't (and can't) retroactively find and remove a past sample, again because nothing links it back to you.

## What we don't do

- We don't sell or share your data with third parties.
- We don't use your expense data, notes, or SMS content for advertising.
- We don't store raw SMS text, full card numbers, or bank account numbers.

## Questions

This is a small, independently-run project. If you have questions about your data, reach out via the contact information on the app or the project's GitHub repository.
