-- ============================================================
-- Sprint 3: AI Native Profile columns
-- Project: kxkynhbulfxkibwmwrwl (Central EU)
-- Paste and run this in the Supabase SQL Editor (once only)
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS ai_level            integer,
  ADD COLUMN IF NOT EXISTS ai_level_title      text,
  ADD COLUMN IF NOT EXISTS role_category       text,
  ADD COLUMN IF NOT EXISTS company_context     text,
  ADD COLUMN IF NOT EXISTS personalised_tagline text,
  ADD COLUMN IF NOT EXISTS onboarding_complete boolean default false,
  ADD COLUMN IF NOT EXISTS q1_answer           text,
  ADD COLUMN IF NOT EXISTS q2_answer           text,
  ADD COLUMN IF NOT EXISTS profile_public      boolean default true;
