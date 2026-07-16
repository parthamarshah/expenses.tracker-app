-- ============================================================
-- Migration: SMS training-sample corpus (anonymized parser training data)
-- Run this in Supabase → SQL Editor
--
-- Adds:
--   1. sms_training_samples — one redacted SMS per user per ISO week, with
--      NO user_id column and no other linkage back to any account. RLS is
--      enabled with zero policies (deny-all via PostgREST for both anon and
--      authenticated roles); the Worker's service-role client bypasses RLS
--      entirely regardless, so this is defense-in-depth, not the real access
--      control. This table is never queried by the SPA.
--   2. user_prefs.sms_training_opt_out — per-user opt-out flag, defaults to
--      false (collection is on by default per the product's T&C).
--   3. user_prefs.sms_sample_state — ephemeral per-user reservoir-sampling
--      working state (already-redacted text only, never raw SMS — see
--      functions/api/_smsRedact.js and the sampling logic in log-sms.js).
--
-- This feature is inert until this migration is applied AND the
-- SMS_TRAINING_SAMPLING_ENABLED env var is set to "true" in the Cloudflare
-- Workers dashboard — the code fails safe (sampling skipped, main
-- expense-logging flow unaffected) if either is missing.
-- ============================================================

CREATE TABLE IF NOT EXISTS sms_training_samples (
  id         bigint generated always as identity primary key,
  bank       text        not null default 'unknown',
  message    text        not null,
  week       text        not null,
  created_at timestamptz not null default now()
);

ALTER TABLE sms_training_samples ENABLE ROW LEVEL SECURITY;
-- No policies added deliberately — deny-all for anon/authenticated PostgREST
-- access. Only the Worker's service-role client (which bypasses RLS) writes here.

ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS sms_training_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS sms_sample_state text;
