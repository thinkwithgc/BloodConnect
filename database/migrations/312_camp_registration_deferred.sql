-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 312: camp attendance distinguishes "deferred" from "no-show"
--
-- Motivation:
-- camp_registrations.status has four values (RG/AT/NS/CN), so a donor who
-- turned up and was turned away at the screening desk is indistinguishable
-- from one who never came. At a camp that is routinely 10-15% of the roster —
-- low haemoglobin, a recent tattoo, a fever, weight under 45 kg — and it is
-- the single most useful number an organiser has: it tells them whether their
-- mobilisation failed (no-shows) or their pre-screening messaging did
-- (deferrals). Collapsing the two makes a good camp look like a bad one and
-- gives the organiser nothing to act on.
--
-- DF also protects the donor. A no-show is a broken promise; a deferral is
-- someone who kept theirs. Once reliability scoring is wired (donors.
-- reliability_score is read in four places and written nowhere today), NS is
-- the value that would eventually cost a donor standing. A deferred donor must
-- never take that penalty for arriving.
--
--   ⚠ BOUNDARY — DF IS AN ATTENDANCE FACT, NOT A CLINICAL DEFERRAL.
--   Setting camp_registrations.status = 'DF' must NEVER write
--   donors.deferral_until, donors.next_eligible_date, donors.deferral_reason
--   or any other eligibility field. Those are patient-safety state and they
--   are owned by the blood bank's donation path — validateDonation() plus the
--   DB triggers on donation_history and donor_screening. A volunteer tapping a
--   roster on a phone at a camp gate is not a clinical assessment, and per
--   hard rule 1 of CLAUDE.md a clinical rule never moves out of the database
--   into a UI affordance. DF records only "this person came and did not
--   donate".
--
-- Deliberately NO note/reason column. The reason a donor was deferred is
-- clinical PII; the blood bank already records it in donor_screening and in
-- the donor's own deferral fields, both of which are column-encrypted and
-- access-controlled. A free-text field on this table would be a fifth,
-- unencrypted copy filled in by whoever is holding the tablet, reachable from
-- a no-login magic-link session. The count is what the roster needs.
--
-- deferred_donor_count is denormalised onto donation_camps alongside the two
-- counts already there; migration 313 makes all three derive from the roster.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE camp_registrations
  DROP CONSTRAINT camp_registrations_status_check;

ALTER TABLE camp_registrations
  ADD CONSTRAINT camp_registrations_status_check
  CHECK (status IN ('RG', 'AT', 'NS', 'CN', 'DF'));

COMMENT ON COLUMN camp_registrations.status IS
  'RG Registered, AT Attended (a donation is recorded against this camp), '
  'NS No-show, CN Cancelled, DF Deferred at the camp (came, could not donate). '
  'DF is an attendance fact only — it never implies a clinical deferral on the '
  'donor record.';

ALTER TABLE donation_camps
  ADD COLUMN deferred_donor_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN donation_camps.deferred_donor_count IS
  'Donors who attended but could not donate. Maintained by trg_camp_reg_counts '
  '(migration 313). Turnout = attended + deferred; absent = registered - both.';

-- ROLLBACK
-- ALTER TABLE donation_camps DROP COLUMN deferred_donor_count;
-- UPDATE camp_registrations SET status = 'NS' WHERE status = 'DF';
-- ALTER TABLE camp_registrations DROP CONSTRAINT camp_registrations_status_check;
-- ALTER TABLE camp_registrations ADD CONSTRAINT camp_registrations_status_check
--   CHECK (status IN ('RG', 'AT', 'NS', 'CN'));
