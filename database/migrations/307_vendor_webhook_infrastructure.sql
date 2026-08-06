-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 307: vendor webhook infrastructure + consent-pending purge support
--
-- Groundwork for the public vendor push API (PR (a) of the Safetrans / generic
-- BB-software integration plan). Three new tables + minimal donor-side
-- additions so vendor-pushed rows can flow through the existing consent path
-- without disturbing the direct-registration flow.
--
-- Design decisions and their reasoning:
--
--  1. New tables: `vendor_partners`, `partner_keys`, `vendor_events`.
--     - `vendor_partners`: one row per software company (Strides, e-RaktKosh,
--       BLIS, RAKT, …).
--     - `partner_keys`: one row per HOSPITAL INSTALLATION of a vendor's
--       software. Each install gets a distinct HMAC secret so revocation is
--       per-hospital, not per-vendor. `hmac_secret` is sealed with the main
--       encryption key at rest (via services/pii/seal()) — the app decrypts
--       once per webhook to verify the HMAC.
--     - `vendor_events`: idempotency store. Composite PK (partner_key,
--       vendor_event_id) so a vendor retrying a request gets the same
--       processing outcome without side effects. Rows > 30 days pruned by an
--       existing scheduled job (data-retention-purge).
--
--  2. `donors.registration_source` gets a new allowed value `VPS`
--     ('Vendor Push Sync'). This mirrors the existing convention (`WAB`,
--     `QRC`, etc.) and lets any downstream analytics segment vendor-sourced
--     donors without joining to a new table.
--
--  3. `donors.consent_pending_since` (TIMESTAMPTZ) marks a donor whose
--     consent is still awaiting the donor's own tap on /consent/:token.
--     `consent_data_use = FALSE` + `consent_pending_since IS NOT NULL`
--     ⇒ pending push. The nightly purge job scrubs rows still pending after
--     14 days. Direct-registration donors and consented donors both have
--     `consent_pending_since = NULL`.
--
--  4. `donors.pushed_by_partner_key` audit / observability trail for which
--     BB installation the row came from. Not enforced as an FK because
--     rotating/revoking a partner_key mustn't cascade-delete donor rows.
--
-- What this migration does NOT do:
--   - No RLS policies on the new tables (admin-managed, API-layer-scoped).
--     A follow-up may add RLS if we surface partner-keys to non-admin roles.
--   - No changes to `consent_data_use` semantics or `trg_donors_consent_protect`
--     (migration 099). Vendor pushes INSERT with consent_data_use=FALSE which
--     doesn't trigger the trigger (which only fires on UPDATE).
--   - No HITL blood-group state machine. That's PR (b) / migration 308.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. vendor_partners ─────────────────────────────────────────────────────
CREATE TABLE vendor_partners (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL UNIQUE,
  contact_email      CITEXT,
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         UUID REFERENCES platform_users(id)
);

COMMENT ON TABLE vendor_partners IS
  'Software vendors integrated via the /webhooks/v1/* API (Strides Safetrans, e-RaktKosh, BLIS, etc.). One row per vendor company; per-hospital secrets live in partner_keys.';

-- ── 2. partner_keys ────────────────────────────────────────────────────────
CREATE TABLE partner_keys (
  partner_key         TEXT PRIMARY KEY,
  vendor_partner_id   UUID NOT NULL REFERENCES vendor_partners(id),
  institution_id      UUID NOT NULL REFERENCES institutions(id),
  hmac_secret         TEXT NOT NULL,                        -- sealed via services/pii/seal()
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          UUID REFERENCES platform_users(id),
  rotated_from        TEXT REFERENCES partner_keys(partner_key),
  revoked_at          TIMESTAMPTZ,
  revoked_by          UUID REFERENCES platform_users(id),
  notes               TEXT,
  CONSTRAINT partner_key_format CHECK (partner_key ~ '^pk_[A-Za-z0-9_-]{16,}$')
);

CREATE INDEX idx_partner_keys_institution
  ON partner_keys(institution_id) WHERE is_active = TRUE;
CREATE INDEX idx_partner_keys_vendor
  ON partner_keys(vendor_partner_id) WHERE is_active = TRUE;

COMMENT ON COLUMN partner_keys.hmac_secret IS
  'Sealed via services/pii/seal() using the main encryption key. Opened once per webhook by the HMAC verify middleware. Rotating replaces the ciphertext; the previous partner_key row is kept for 24h overlap and then revoked.';

-- ── 3. vendor_events (idempotency store) ────────────────────────────────────
CREATE TABLE vendor_events (
  partner_key         TEXT NOT NULL,
  vendor_event_id     TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_status       SMALLINT,                             -- HTTP status returned
  result_action       TEXT,                                 -- 'created' | 'updated' | 'noop' | 'rejected'
  raktify_donor_id    UUID REFERENCES donors(id),
  error_code          TEXT,
  PRIMARY KEY (partner_key, vendor_event_id),
  CONSTRAINT vendor_events_endpoint_check
    CHECK (endpoint IN ('donor-registration', 'donation'))
);

CREATE INDEX idx_vendor_events_received ON vendor_events(received_at);

COMMENT ON TABLE vendor_events IS
  'Idempotency store for /webhooks/v1/*. On a duplicate (partner_key, vendor_event_id), the original result is replayed instead of re-processing. Rows > 30 days pruned by scheduler/jobs/data-retention-purge.';

-- ── 4. donors: additive columns for the push flow ──────────────────────────

-- Extend registration_source CHECK to allow vendor push. Drop-and-add is
-- required because a CHECK constraint's expression cannot be altered in place.
ALTER TABLE donors DROP CONSTRAINT donors_registration_source_check;
ALTER TABLE donors ADD CONSTRAINT donors_registration_source_check
  CHECK (registration_source IN ('QRC','WAB','WEB','APP','BBK','CAM','VPS'));

ALTER TABLE donors
  ADD COLUMN consent_pending_since  TIMESTAMPTZ,
  ADD COLUMN pushed_by_partner_key  TEXT;

COMMENT ON COLUMN donors.consent_pending_since IS
  'Non-NULL while a vendor-pushed donor is awaiting their /consent/:token acceptance. Cleared to NULL when consent_data_use flips to TRUE (accept) OR when the row is erased (decline / 14-day purge).';

COMMENT ON COLUMN donors.pushed_by_partner_key IS
  'Audit trail: the partner_key that first pushed this donor. NULL for direct-registration donors. Not a foreign key so partner_key rotation/revocation cannot cascade-delete donor rows.';

-- Partial index for the nightly purge job: only rows with a pending timestamp
-- older than the cutoff are candidates.
CREATE INDEX idx_donors_consent_pending
  ON donors(consent_pending_since)
  WHERE consent_pending_since IS NOT NULL;

-- ── 5. GRANTs ──────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE ON vendor_partners TO app_user;
GRANT SELECT, INSERT, UPDATE ON partner_keys   TO app_user;
GRANT SELECT, INSERT         ON vendor_events  TO app_user;

-- ROLLBACK
-- REVOKE ALL ON vendor_events   FROM app_user;
-- REVOKE ALL ON partner_keys    FROM app_user;
-- REVOKE ALL ON vendor_partners FROM app_user;
-- DROP INDEX IF EXISTS idx_donors_consent_pending;
-- ALTER TABLE donors DROP COLUMN pushed_by_partner_key;
-- ALTER TABLE donors DROP COLUMN consent_pending_since;
-- ALTER TABLE donors DROP CONSTRAINT donors_registration_source_check;
-- ALTER TABLE donors ADD  CONSTRAINT donors_registration_source_check
--   CHECK (registration_source IN ('QRC','WAB','WEB','APP','BBK','CAM'));
-- DROP INDEX IF EXISTS idx_vendor_events_received;
-- DROP TABLE IF EXISTS vendor_events;
-- DROP INDEX IF EXISTS idx_partner_keys_vendor;
-- DROP INDEX IF EXISTS idx_partner_keys_institution;
-- DROP TABLE IF EXISTS partner_keys;
-- DROP TABLE IF EXISTS vendor_partners;
