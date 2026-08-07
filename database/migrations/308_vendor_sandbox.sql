-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 308: sandbox mode for vendor push webhook
--
-- Vendors integrating with the /webhooks/v1/* API often want to send test
-- payloads before wiring up real donor traffic. Rather than stand up a
-- separate sandbox environment (Azure App Service slot, separate DB), we
-- flag both the partner_key and the donor rows it creates so:
--
--   - The webhook processes sandbox pushes on the same code path (fewer
--     surprises during vendor cutover from sandbox to prod).
--   - Sandbox donors are NEVER sent the DONOR_CONSENT_INVITE WhatsApp
--     (don't spam real mobile numbers with test data).
--   - Sandbox donors are auto-purged after 24 hours by a scheduler job
--     (see backend/src/services/scheduler/jobs/sandbox-donor-purge.js).
--   - Sandbox donors are invisible to the matching engine (existing
--     consent_data_use=TRUE filter already handles this — sandbox donors
--     land with consent_data_use=FALSE, matching skips them).
--
-- Design non-goal: this is NOT a fully isolated sandbox environment. Sandbox
-- writes hit the same prod DB, they're just tagged and purged fast. That's
-- deliberately simple for a v1 — a proper sandbox env (Neon target via a
-- second App Service slot) is a follow-up if vendor volume justifies it.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE partner_keys
  ADD COLUMN is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN partner_keys.is_sandbox IS
  'When TRUE, pushes signed by this key create donor rows tagged is_sandbox=TRUE (auto-purged after 24h) and no DONOR_CONSENT_INVITE WhatsApp fires. Used for vendor integration testing.';

ALTER TABLE donors
  ADD COLUMN is_sandbox BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN donors.is_sandbox IS
  'When TRUE, this donor row was created by a sandbox partner_key. Auto-purged 24 hours after created_at by the sandbox_donor_purge scheduler job. Invisible to matching (consent_data_use always stays FALSE for sandbox donors).';

-- Partial index for the nightly purge job's WHERE clause.
CREATE INDEX idx_donors_sandbox_purge
  ON donors(created_at)
  WHERE is_sandbox = TRUE AND is_active = TRUE;

-- ROLLBACK
-- DROP INDEX IF EXISTS idx_donors_sandbox_purge;
-- ALTER TABLE donors DROP COLUMN is_sandbox;
-- ALTER TABLE partner_keys DROP COLUMN is_sandbox;
