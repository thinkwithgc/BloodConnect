-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 309: Human-in-the-loop (HITL) state machine for
--                donors.blood_group_verified
--
-- Motivation:
-- Vendor push (webhooks/v1/donor-registration) trusts the pushing BB's
-- blood-group attestation on first contact. When a SECOND BB pushes the
-- SAME donor with a DIFFERENT verified value, we can't silently overwrite —
-- clinical safety demands human review before deciding which value is
-- authoritative. Once resolved, the value LOCKS: no further push or manual
-- edit can change it. This is the "one change after verified" invariant.
--
-- The state machine:
--   UV (unverified)  →  VE (verified by first BB)
--   VE               →  DP (discrepancy pending — a second BB disagrees)
--   DP               →  LK (locked — a human resolved the discrepancy)
--   LK               →  (terminal — immutable)
--
-- New columns:
--   blood_group_verification_state CHAR(2) NOT NULL DEFAULT 'UV'
--   blood_group_discrepancy_new      SMALLINT (only non-NULL while state=DP)
--   blood_group_discrepancy_source_id UUID  → institutions
--   blood_group_locked_at            TIMESTAMPTZ (when the HITL resolution ran)
--   blood_group_locked_by            UUID → platform_users (who resolved)
--
-- Immutability guarantee:
--   trg_donors_blood_group_immutability_lock fires BEFORE UPDATE. When
--   state=LK, any UPDATE that changes blood_group_verified raises
--   check_violation (SQLSTATE 23514) — RLS actor doesn't matter; the DB
--   itself refuses. This is the clinical-safety belt to go with the
--   application-layer suspenders.
--
-- Backfill:
--   All existing donors with blood_group_verified IS NOT NULL move to
--   state='VE'. Their next push will trigger a real HITL check if it
--   disagrees.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE donors
  ADD COLUMN blood_group_verification_state    CHAR(2) NOT NULL DEFAULT 'UV'
    CHECK (blood_group_verification_state IN ('UV','VE','DP','LK')),
  ADD COLUMN blood_group_discrepancy_new       SMALLINT REFERENCES blood_groups(id),
  ADD COLUMN blood_group_discrepancy_source_id UUID    REFERENCES institutions(id),
  ADD COLUMN blood_group_locked_at             TIMESTAMPTZ,
  ADD COLUMN blood_group_locked_by             UUID    REFERENCES platform_users(id);

COMMENT ON COLUMN donors.blood_group_verification_state IS
  'HITL state machine: UV=unverified (blood_group_verified=NULL), VE=verified by BB attestation, DP=discrepancy pending (2 BBs disagree; awaiting NGO admin review), LK=locked (human resolved; immutable).';
COMMENT ON COLUMN donors.blood_group_discrepancy_new IS
  'The disputed incoming blood_group_id from the second BB. Non-NULL only while state=DP. Cleared on resolve.';
COMMENT ON COLUMN donors.blood_group_discrepancy_source_id IS
  'Institution that pushed the disputed value. Non-NULL only while state=DP.';

-- Partial index for the admin discrepancy queue.
CREATE INDEX idx_donors_blood_group_discrepancy_pending
  ON donors(created_at DESC)
  WHERE blood_group_verification_state = 'DP';

-- Backfill: any existing donor with a verified blood group is VE.
UPDATE donors
   SET blood_group_verification_state = 'VE'
 WHERE blood_group_verified IS NOT NULL
   AND blood_group_verification_state = 'UV';

-- ── Immutability trigger ────────────────────────────────────────────────────
-- Refuse to change blood_group_verified once state=LK. This is the DB-level
-- clinical-safety enforcement: even a super_admin cannot bypass without
-- explicitly first flipping state OUT of LK, which only migration DDL can
-- do (nothing in the app has permission to write the state column back to
-- DP or VE from LK; see trg_donors_blood_group_state_transitions below).
CREATE OR REPLACE FUNCTION fn_donors_blood_group_immutability_lock()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.blood_group_verification_state = 'LK'
     AND NEW.blood_group_verified IS DISTINCT FROM OLD.blood_group_verified THEN
    RAISE EXCEPTION 'blood_group_verified is locked (state=LK) and cannot be modified'
      USING ERRCODE = 'check_violation',
            HINT = 'This donor''s blood group was locked via HITL review. To change it, migration DDL is required (deliberately painful).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_donors_blood_group_immutability_lock
  BEFORE UPDATE OF blood_group_verified ON donors
  FOR EACH ROW EXECUTE FUNCTION fn_donors_blood_group_immutability_lock();

-- ── State-transition trigger ────────────────────────────────────────────────
-- Reject invalid state transitions at the DB layer. Valid transitions:
--   UV → VE   (first attestation from a BB)
--   VE → DP   (a second BB disagrees)
--   DP → LK   (HITL resolution)
-- Any other transition is a bug in application code and gets rejected here.
-- Same trip-wire philosophy as the immutability lock above.
CREATE OR REPLACE FUNCTION fn_donors_blood_group_state_transitions()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_from CHAR(2) := OLD.blood_group_verification_state;
  v_to   CHAR(2) := NEW.blood_group_verification_state;
BEGIN
  IF v_from = v_to THEN
    RETURN NEW;
  END IF;
  IF v_from = 'UV' AND v_to = 'VE' THEN RETURN NEW; END IF;
  IF v_from = 'VE' AND v_to = 'DP' THEN RETURN NEW; END IF;
  IF v_from = 'DP' AND v_to = 'LK' THEN RETURN NEW; END IF;
  -- Recovery hatch — VE → UV / DP → VE / LK → * are all forbidden.
  -- Rollback via erasure is the only way to "reset" a donor.
  RAISE EXCEPTION 'invalid blood_group_verification_state transition: % → %', v_from, v_to
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER trg_donors_blood_group_state_transitions
  BEFORE UPDATE OF blood_group_verification_state ON donors
  FOR EACH ROW EXECUTE FUNCTION fn_donors_blood_group_state_transitions();

-- ROLLBACK
-- DROP TRIGGER IF EXISTS trg_donors_blood_group_state_transitions ON donors;
-- DROP FUNCTION IF EXISTS fn_donors_blood_group_state_transitions;
-- DROP TRIGGER IF EXISTS trg_donors_blood_group_immutability_lock ON donors;
-- DROP FUNCTION IF EXISTS fn_donors_blood_group_immutability_lock;
-- DROP INDEX IF EXISTS idx_donors_blood_group_discrepancy_pending;
-- ALTER TABLE donors
--   DROP COLUMN blood_group_locked_by,
--   DROP COLUMN blood_group_locked_at,
--   DROP COLUMN blood_group_discrepancy_source_id,
--   DROP COLUMN blood_group_discrepancy_new,
--   DROP COLUMN blood_group_verification_state;
