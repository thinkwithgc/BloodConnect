-- ─────────────────────────────────────────────────────────────────────────────
-- 319_camp_branding.sql
--
-- An organiser may put their own identity on the camp page they share: a logo
-- or photo, and one line of their own words. Both are invisible to the public
-- until an NGO admin approves them.
--
-- ⚠ THE LOGO IS A data: URI, NOT A STORAGE KEY. services/storage is not used
--   here, for four independent reasons:
--     1. Nothing in this codebase can serve an uploaded file back to a browser.
--        There is no express.static and no /uploads/local/:key route;
--        getDownloadUrl (services/storage/localProvider.js:35) has ZERO callers.
--     2. Signed MoU PDFs share LOCAL_STORAGE_DIR (mou/<shortname>/v<N>-scan.pdf).
--        A public static mount over that directory would publish every
--        institution's signed MoU.
--     3. env.js defaults storageDir to a RELATIVE './.local-storage', and only
--        /home is persisted on App Service Linux. Disk uploads are lost on
--        restart today.
--     4. A cross-origin image taints a <canvas>, so toBlob() throws
--        SecurityError. The social-post PNG export depends on drawing the logo,
--        and a data: URI is never cross-origin.
--
-- ⚠ THE BYTES LIVE IN THEIR OWN TABLE, camp_branding_logo, AND THAT TABLE IS
--   DELIBERATELY NOT AUDITED. fn_audit_row() (migration 025) writes one
--   audit_log row PER CHANGED FIELD carrying the full old_value AND new_value
--   as text, and 099_attach_audit_triggers.sql attaches it to donation_camps.
--   A ~67 KB base64 string on donation_camps would therefore append ~134 KB to
--   audit_log on every re-upload — and audit_log is INSERT-only by hard rule 2,
--   so it can never be pruned. The review columns below stay on donation_camps,
--   where their history SHOULD be recorded: who approved what, when, and why a
--   rejection happened is exactly what the audit trail is for. The payload is
--   not audit-worthy; it is just bytes.
--
-- ⚠ camp_branding_logo HAS NO COLUMN NAMED id, ON PURPOSE. fn_audit_row()
--   hardcodes NEW.id / OLD.id, so attach_audit_trigger('camp_branding_logo')
--   would fail loudly with 'record "new" has no field "id"' — migration 318's
--   exact error. That failure is the point: it is a tripwire that stops anyone
--   re-introducing the bloat this table exists to prevent. Do not "fix" it by
--   adding an id.
--
-- The 50 KB decoded ceiling lives in POST /camps/access/:token/logo-raw, not in
-- a CHECK. It is a payload-budget decision about rural 4G (50 KB decoded is
-- ~67 KB of base64 riding the JSON the RSVP page already fetches; 100 KB would
-- be ~133 KB, 25x today's payload), not a patient-safety invariant, and it will
-- be retuned as we learn. The CHECK below is a loose backstop against something
-- pathological, not the product cap.
--
-- ⚠ NOTHING AN ORGANISER UPLOADS IS PUBLIC UNTIL AN NGO ADMIN APPROVES IT.
--   The gate is expressed in SQL in GET /camps/public/:slug
--   (CASE WHEN c.branding_status = 'AP' THEN a.logo_data_uri END) rather than in
--   JS, so a future caller physically cannot forget it and there is exactly one
--   place to audit. GET /camps/access/:token returns it UNGATED — that is the
--   organiser's own view of their own upload, and on 'RJ' they must be able to
--   read why.
--
-- ⚠ ANY ORGANISER EDIT RESETS branding_status TO 'PE' IN THE SAME STATEMENT
--   that writes the new value, and clears branding_reviewed_at/_by/_note.
--   Otherwise an organiser gets a benign logo approved and swaps it afterwards.
--
-- organiser_tagline rides the same approval gate as the logo. The founder's
-- decision was about the logo, but 280 characters of free text on a public page
-- beside a PENDING trade mark is the larger abuse surface of the two, and one
-- review action covering both is less admin work than two.
--
-- poster_storage_key (migration 033) is deliberately UNTOUCHED. It is already
-- SELECTed by GET /camps/public/:slug and written by no route; repurposing it
-- would permanently confuse the schema.
--
-- donation_camps has a literal id column, so its existing audit trigger keeps
-- working for the review columns added here.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE donation_camps
  ADD COLUMN organiser_tagline    TEXT,
  ADD COLUMN branding_status      CHAR(2),
  ADD COLUMN branding_reviewed_at TIMESTAMPTZ,
  ADD COLUMN branding_reviewed_by UUID REFERENCES platform_users(id),
  ADD COLUMN branding_review_note TEXT;

ALTER TABLE donation_camps
  ADD CONSTRAINT camp_tagline_len
    CHECK (organiser_tagline IS NULL OR char_length(organiser_tagline) <= 280);

ALTER TABLE donation_camps
  ADD CONSTRAINT camp_branding_status_valid
    CHECK (branding_status IS NULL OR branding_status IN ('PE', 'AP', 'RJ'));

-- A review outcome with nobody who made it is meaningless — the same invariant
-- migration 317 imposes with bb_decline_reason_needs_decline. 'PE' and NULL are
-- both reviewer-free by definition.
ALTER TABLE donation_camps
  ADD CONSTRAINT camp_branding_review_needs_reviewer
    CHECK (branding_status IS NULL
           OR branding_status = 'PE'
           OR branding_reviewed_by IS NOT NULL);

-- A rejection the organiser cannot read is a dead end: they would see
-- "नाकारले" with no way to know what to change. Mandatory on 'RJ' only.
ALTER TABLE donation_camps
  ADD CONSTRAINT camp_branding_reject_needs_note
    CHECK (branding_status <> 'RJ' OR branding_review_note IS NOT NULL);

COMMENT ON COLUMN donation_camps.organiser_tagline IS
  'One organiser-authored line (<=280 chars) shown under their name on the '
  'public camp page. Rides the same branding_status approval gate as the logo.';

COMMENT ON COLUMN donation_camps.branding_status IS
  'NULL nothing submitted · PE awaiting the NGO admin · AP visible on the public '
  'camp page and all printed collateral · RJ rejected (branding_review_note says '
  'why). Governs BOTH organiser_tagline and camp_branding_logo. ANY organiser '
  'edit resets this to ''PE'' in the same UPDATE.';

-- The payload table. One row per camp at most; overwritten in place, so an
-- organiser cannot inflate storage across requests.
CREATE TABLE camp_branding_logo (
  camp_id           UUID PRIMARY KEY REFERENCES donation_camps(id) ON DELETE CASCADE,

  -- A complete 'data:image/(jpeg|png);base64,...' string, ready to drop into an
  -- <img src> or a canvas drawImage with no serve route and no CORS.
  logo_data_uri     TEXT NOT NULL,

  -- Decoded byte length, recorded so the admin review screen can show a size
  -- without decoding, and so a future retune of the ceiling has real data.
  logo_bytes        INTEGER NOT NULL CHECK (logo_bytes > 0),

  logo_content_type TEXT NOT NULL CHECK (logo_content_type IN ('image/jpeg', 'image/png')),

  -- Lets a re-upload of the identical file be recognised, and gives the admin
  -- something stable to reference if the same logo is queried twice.
  logo_sha256       CHAR(64) NOT NULL,

  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  -- Shape invariants, not the product cap — see the header. 200 KB of text is
  -- ~4x the route's 50 KB decoded ceiling: generous headroom, while still
  -- refusing something pathological if a future caller skips the route check.
  CONSTRAINT camp_logo_is_data_uri
    CHECK (logo_data_uri LIKE 'data:image/%;base64,%'),
  CONSTRAINT camp_logo_backstop_len
    CHECK (char_length(logo_data_uri) <= 200000)
);

COMMENT ON TABLE camp_branding_logo IS
  'The organiser''s logo/photo bytes, kept OFF donation_camps so a 67 KB base64 '
  'string never reaches the INSERT-only audit_log via fn_audit_row(). NOT '
  'audited, and intentionally has no id column so attach_audit_trigger() fails '
  'loudly if anyone tries — see this migration''s header. Visible to the public '
  'only when donation_camps.branding_status = ''AP''.';

-- The admin's review queue reads this: "which camps are waiting on me".
CREATE INDEX idx_camps_branding_pending
  ON donation_camps(branding_status)
  WHERE branding_status = 'PE';

-- ROLLBACK
-- DROP INDEX idx_camps_branding_pending;
-- DROP TABLE camp_branding_logo;
-- ALTER TABLE donation_camps DROP CONSTRAINT camp_branding_reject_needs_note;
-- ALTER TABLE donation_camps DROP CONSTRAINT camp_branding_review_needs_reviewer;
-- ALTER TABLE donation_camps DROP CONSTRAINT camp_branding_status_valid;
-- ALTER TABLE donation_camps DROP CONSTRAINT camp_tagline_len;
-- ALTER TABLE donation_camps
--   DROP COLUMN branding_review_note,
--   DROP COLUMN branding_reviewed_by,
--   DROP COLUMN branding_reviewed_at,
--   DROP COLUMN branding_status,
--   DROP COLUMN organiser_tagline;
