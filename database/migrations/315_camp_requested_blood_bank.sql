-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 315: the camp organiser may REQUEST a blood bank
--
-- Motivation:
-- A first-time camp organiser — a sarpanch, a college principal, an HR
-- manager — fills the public hosting form, receives a camp id, and is left
-- with the one question the platform never answers: who is actually going to
-- come and collect the blood? Nothing in the flow asks them, and nothing tells
-- them. donation_camps.partnered_blood_bank_id has existed since migration 033
-- and is set by nothing, anywhere: POST /camps/:id/verify accepts the field but
-- the admin UI has never sent it, and the apply form has no field at all. So
-- every organiser-facing surface that renders "Partnered with …" renders blank.
--
-- This column lets the organiser name a preference from the blood banks
-- onboarded in their own district, so the NGO admin has something to confirm
-- rather than a blank to guess at.
--
--   ⚠ BOUNDARY — THIS IS A REQUEST, NEVER A PARTNERSHIP.
--   requested_blood_bank_id is what the organiser asked for. It carries no
--   authority and no consequence. partnered_blood_bank_id remains the NGO's
--   verdict and the ONLY column any collection or visibility logic may read —
--   GET /camps/collectable is the one that matters, and it is unchanged by
--   this migration. Writing an unconfirmed preference into the partnered
--   column would put a camp in a blood bank's collection queue that nobody
--   agreed to staff, cold-chain or attend. The admin's click on verify is what
--   promotes request → partner; that promotion is the whole point of the
--   feature, and it must stay a human decision.
--
-- Nullable, no default: "I don't know, please arrange one for us" is the
-- expected answer from exactly the organiser this feature exists for, and it
-- must not need a sentinel value or block the application.
--
-- Deliberately NO CHECK that the target is kind='BB'. Postgres cannot express
-- a predicate against another table in a CHECK, and this matches the existing
-- (equally unconstrained) partnered_blood_bank_id. The handler validates kind,
-- onboarding_status, is_active and district match before the INSERT; the worst
-- a bad value could do here is mis-populate an admin dropdown, never route
-- blood.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE donation_camps
  ADD COLUMN requested_blood_bank_id UUID REFERENCES institutions(id);

COMMENT ON COLUMN donation_camps.requested_blood_bank_id IS
  'Blood bank the organiser asked for on the public hosting form, scoped to '
  'the camp district. A request only — it grants nothing. The NGO admin '
  'promotes it to partnered_blood_bank_id at verify, or overrides it. Never '
  'read by collection, visibility or matching logic.';

-- ROLLBACK
-- ALTER TABLE donation_camps DROP COLUMN requested_blood_bank_id;
