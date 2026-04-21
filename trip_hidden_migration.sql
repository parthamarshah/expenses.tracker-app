-- ============================================================
-- Migration: Add `hidden` column to trips for explicit "Mark Inactive"
-- Run this in Supabase → SQL Editor BEFORE deploying the app
-- ============================================================

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
