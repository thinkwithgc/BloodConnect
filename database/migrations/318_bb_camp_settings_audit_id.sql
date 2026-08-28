-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 318: give bb_camp_settings the `id` column its audit trigger needs
--
-- Migration 316 line 136 attached the generic audit trigger to bb_camp_settings:
--
--   SELECT attach_audit_trigger('bb_camp_settings');
--
-- fn_audit_row() (migration 025, lines 134-140) resolves the audited row's
-- identity by reading NEW.id / OLD.id LITERALLY:
--
--   v_record_id := COALESCE(NEW.id::text, NULL);
--
-- bb_camp_settings is the first audited table in the schema whose primary key is
-- not called `id` — it is keyed on blood_bank_id, one row per blood bank. So
-- every INSERT and UPDATE on it raised
--
--   record "new" has no field "id"
--
-- and PUT /camps/bb/settings returned 500. bb_camp_capacity (316:92) already had
-- an `id`, which is exactly why capacity writes worked and settings writes did
-- not — the same feature, two tables, one silently broken.
--
-- ── Why a surrogate column and not one of the alternatives ──────────────────
--
-- fn_audit_row() is NOT touched. It serves ~20 tables through
-- attach_audit_trigger() and is the most safety-critical audit path in the
-- system (hard rule 2: audit_log is INSERT-only and has no override). Teaching
-- it to discover a table's PK dynamically would mean rewriting the identity
-- resolution for every audited table in order to fix one.
--
-- The trigger is NOT dropped either. 316's own header states the requirement:
-- "a BB that closed a day and reopened it, or an NGO admin who bootstrapped
-- capacity on a BB's behalf, must be reconstructable". auto_accept_within_capacity
-- in particular commits a blood bank to camps without a human clicking accept —
-- who switched that on, and when, is precisely the thing an audit trail is for.
--
-- 316 itself is NOT edited: it is applied, and hard rule 5 makes an applied
-- migration immutable (the runner refuses a changed checksum).
--
-- So bb_camp_settings gains a surrogate `id`. blood_bank_id STAYS the primary
-- key — the one-row-per-blood-bank invariant is the useful one and nothing
-- references settings by id. `id` exists to be read by the audit trigger, is
-- stable for the life of the row, and is UNIQUE so audit_log.record_id resolves
-- to exactly one blood bank's settings.
--
-- No backfill concern: gen_random_uuid() as a column default populates existing
-- rows in the same statement, and on dev there are none — the trigger made it
-- impossible to ever write one.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bb_camp_settings
  ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE bb_camp_settings
  ADD CONSTRAINT bb_camp_settings_id_key UNIQUE (id);

COMMENT ON COLUMN bb_camp_settings.id IS
  'Surrogate row identity. NOT the primary key — blood_bank_id is, and one row '
  'per blood bank is the real invariant. This column exists because '
  'fn_audit_row() (migration 025) reads NEW.id literally, so every table passed '
  'to attach_audit_trigger() must carry a column with exactly this name. '
  'Nothing in the application references it.';

-- ROLLBACK
-- Dropping this column re-breaks every write to the table while the audit
-- trigger from 316 is attached. Drop the trigger first if that is the intent:
--   DROP TRIGGER IF EXISTS trg_audit_bb_camp_settings ON bb_camp_settings;
-- ALTER TABLE bb_camp_settings DROP CONSTRAINT bb_camp_settings_id_key;
-- ALTER TABLE bb_camp_settings DROP COLUMN id;
