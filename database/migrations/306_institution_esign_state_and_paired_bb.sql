-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 306: eSign state persistence + paired-BB admin token surface
--
-- Two related additions to `institutions` that together fix the hospital
-- onboarding flow end-to-end:
--
--  1. eSign state on the institution row itself. Send-MoU used to hold the
--     Leegality sign URL only in the admin's React Query mutation state — a
--     page refresh lost it, and clicking Send-MoU again created a duplicate
--     Leegality document + a new `mou_versions` row. These columns persist
--     the current in-flight eSign request so re-clicks are idempotent and the
--     admin can refresh the page without losing the URL. Cleared by the
--     mou-signed webhook on success.
--
--  2. Paired-BB admin setup token surface. When an applicant onboards a
--     hospital with an in-house blood bank (has_inhouse_blood_bank=true), the
--     mou-signed webhook now provisions TWO admin users: <short>_admin for
--     the HO parent and <short>-bb_admin for the BB child. The HO admin's
--     setup link goes on WhatsApp (existing institution_link template). The
--     BB admin's plaintext setup token is stashed on the parent row here so
--     the HO admin can surface it via the "In-house blood bank — activate BB
--     admin" panel on their dashboard (copy URL / resend WhatsApp). A trigger
--     clears it as soon as the BB admin consumes the token, so the panel
--     disappears once activation is complete.
--
-- Both concerns share this migration because they land together as the fix
-- to the same feature — the onboarding flow. Splitting into two migrations
-- would separate columns that are only meaningful in concert.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. eSign state ──────────────────────────────────────────────────────────
ALTER TABLE institutions
  ADD COLUMN current_esign_doc_id     TEXT,
  ADD COLUMN current_esign_url        TEXT,
  ADD COLUMN current_esign_expires_at TIMESTAMPTZ,
  ADD COLUMN current_esign_sent_at    TIMESTAMPTZ;

COMMENT ON COLUMN institutions.current_esign_doc_id IS
  'In-flight Leegality documentId while onboarding_status=VE. NULL once webhook activates the institution.';
COMMENT ON COLUMN institutions.current_esign_url IS
  'In-flight Leegality signatory URL. Persisted so admin refresh + re-render Send-MoU idempotently.';

-- Partial index for the (rare) case where the webhook payload lacks the irn
-- field and we need to resolve institution_id by doc_id.
CREATE INDEX idx_institutions_esign_doc
  ON institutions(current_esign_doc_id)
  WHERE current_esign_doc_id IS NOT NULL;

-- ── 2. Paired-BB admin setup token surface ──────────────────────────────────
ALTER TABLE institutions
  ADD COLUMN bb_admin_pending_setup_token TEXT;

COMMENT ON COLUMN institutions.bb_admin_pending_setup_token IS
  'Plaintext setup token for the child BB admin, stored on the PARENT HO row so the HO admin can surface it via their dashboard. Cleared automatically when the BB admin consumes the token (see fn_clear_bb_admin_pending_token trigger). NULL for standalone BBs and for hospitals without an in-house BB.';

-- Trigger: when the BB admin (role='blood_bank' user linked to a child
-- institution) marks their setup token used, wipe the pending token from the
-- parent HO's row so the "activate BB admin" panel disappears cleanly.
CREATE OR REPLACE FUNCTION fn_clear_bb_admin_pending_token()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  parent_id UUID;
BEGIN
  -- Fire only on the NULL → non-NULL transition, and only for staff of a
  -- child BB institution.
  IF NEW.setup_token_used_at IS NOT NULL
     AND (OLD.setup_token_used_at IS NULL)
     AND NEW.role = 'blood_bank'
     AND NEW.institution_id IS NOT NULL THEN

    SELECT parent_institution_id INTO parent_id
      FROM institutions
     WHERE id = NEW.institution_id;

    IF parent_id IS NOT NULL THEN
      UPDATE institutions
         SET bb_admin_pending_setup_token = NULL
       WHERE id = parent_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clear_bb_admin_pending_token
  AFTER UPDATE OF setup_token_used_at ON platform_users
  FOR EACH ROW
  EXECUTE FUNCTION fn_clear_bb_admin_pending_token();

-- ROLLBACK
-- DROP TRIGGER IF EXISTS trg_clear_bb_admin_pending_token ON platform_users;
-- DROP FUNCTION IF EXISTS fn_clear_bb_admin_pending_token;
-- ALTER TABLE institutions DROP COLUMN bb_admin_pending_setup_token;
-- DROP INDEX IF EXISTS idx_institutions_esign_doc;
-- ALTER TABLE institutions DROP COLUMN current_esign_sent_at;
-- ALTER TABLE institutions DROP COLUMN current_esign_expires_at;
-- ALTER TABLE institutions DROP COLUMN current_esign_url;
-- ALTER TABLE institutions DROP COLUMN current_esign_doc_id;
