-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 310: paper (offline) MoU signing mode
--
-- Motivation:
-- Until now the ONLY code path that could activate an institution was the
-- Leegality Aadhaar-eSign webhook (POST /onboarding/mou-signed). Leegality is
-- a vendor signup that is not in place, so institution onboarding was blocked
-- end-to-end. The MoU is now signed OFFLINE ON PAPER: the NGO admin holds the
-- signed document and records it on the platform when approving.
--
-- `mou_versions` was shaped entirely around eSign — leegally_doc_id,
-- pdf_storage_key and pdf_sha256 were all NOT NULL. A paper MoU has no
-- Leegality document id at all, and the scanned copy is optional (the admin
-- may file the paper original without scanning it). Rather than fake a doc id
-- (which would corrupt a legal archive that audit/legal queries read), this
-- migration makes the eSign-specific columns nullable and adds an explicit
-- discriminator so every row states how it was actually signed.
--
-- Nothing here relaxes a patient-safety rule: the MoU is a commercial/legal
-- artifact, and no trigger, RLS policy or scheduled job gates clinical
-- behaviour on it. The pre-existing eSign invariant (an eSign row MUST carry a
-- Leegality doc id) is preserved as a CHECK now that the column is nullable.
--
-- Additive only. Existing rows are genuinely eSign rows, so DEFAULT 'ES'
-- backfills them correctly and no data migration is required.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. mou_versions: discriminator + relax eSign-only NOT NULLs ─────────────
ALTER TABLE mou_versions
  ADD COLUMN signing_mode CHAR(2) NOT NULL DEFAULT 'ES'
    CHECK (signing_mode IN ('ES','PA'));

COMMENT ON COLUMN mou_versions.signing_mode IS
  'How this MoU version was executed. ES = Aadhaar eSign via Leegality. PA = signed offline on paper, recorded by an NGO admin. Determines which of the eSign-specific columns are expected to be populated.';

ALTER TABLE mou_versions ALTER COLUMN leegally_doc_id  DROP NOT NULL;
ALTER TABLE mou_versions ALTER COLUMN pdf_storage_key  DROP NOT NULL;
ALTER TABLE mou_versions ALTER COLUMN pdf_sha256       DROP NOT NULL;

COMMENT ON COLUMN mou_versions.leegally_doc_id IS
  'Leegality documentId. NOT NULL for signing_mode=ES (enforced by esign_requires_doc_id); always NULL for signing_mode=PA.';
COMMENT ON COLUMN mou_versions.pdf_storage_key IS
  'Storage key for the MoU document. For signing_mode=PA this is the OPTIONAL scan of the signed paper original — NULL means the paper was filed without being scanned.';

-- Preserve the invariant the old NOT NULL gave us, scoped to eSign rows.
ALTER TABLE mou_versions
  ADD CONSTRAINT esign_requires_doc_id
    CHECK (signing_mode <> 'ES' OR leegally_doc_id IS NOT NULL);

-- A stored document without its integrity hash is unverifiable, and a hash
-- with no document is meaningless. Both or neither.
ALTER TABLE mou_versions
  ADD CONSTRAINT scan_key_and_hash_together
    CHECK ((pdf_storage_key IS NULL) = (pdf_sha256 IS NULL));

-- ── 2. institutions: mirror the latest version's signing mode ───────────────
-- Mirrors the existing mou_signed_at / mou_leegally_doc_id / mou_signatory_name
-- convenience-pointer pattern (see migration 004) so onboarding list + detail
-- queries don't need a join to render "Paper" vs "Aadhaar eSign".
ALTER TABLE institutions
  ADD COLUMN mou_signing_mode CHAR(2)
    CHECK (mou_signing_mode IN ('ES','PA'));

COMMENT ON COLUMN institutions.mou_signing_mode IS
  'Mirror of mou_versions.signing_mode for the LATEST MoU version. NULL until an MoU is filed. Authoritative history lives in mou_versions.';

-- ROLLBACK
-- ALTER TABLE institutions DROP COLUMN mou_signing_mode;
-- ALTER TABLE mou_versions DROP CONSTRAINT scan_key_and_hash_together;
-- ALTER TABLE mou_versions DROP CONSTRAINT esign_requires_doc_id;
-- -- NOTE: re-adding these NOT NULLs will FAIL if any signing_mode='PA' rows
-- -- exist. Delete or backfill paper rows first.
-- ALTER TABLE mou_versions ALTER COLUMN pdf_sha256      SET NOT NULL;
-- ALTER TABLE mou_versions ALTER COLUMN pdf_storage_key SET NOT NULL;
-- ALTER TABLE mou_versions ALTER COLUMN leegally_doc_id SET NOT NULL;
-- ALTER TABLE mou_versions DROP COLUMN signing_mode;
