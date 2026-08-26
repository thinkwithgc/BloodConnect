-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 314: camp attendance derives from the donation record
--
-- Motivation:
-- Attendance is currently a manual tap. A volunteer at a camp gate opens the
-- organizer roster and marks each donor Attended — which means the number is
-- only as good as whoever was holding the tablet at the busiest moment of the
-- day, and at a 200-donor camp it simply does not get done. Meanwhile the
-- blood bank is already recording the one fact that proves attendance beyond
-- dispute: a donation. donation_history has carried donation_camp_id (FK to
-- donation_camps, indexed) and source='CA' — "at camp" — since migration 020,
-- and NOTHING in the application has ever set either one.
--
-- So the roster stops being something anyone ticks. The blood bank records the
-- donation against the camp, as it must anyway, and the roster follows.
--
-- WHY A TRIGGER AND NOT ROUTE CODE:
-- there are already three ways a donation reaches this table — POST /donations,
-- the partner-system vendor webhook, and bulk upload. Handler-level derivation
-- would be correct in whichever one it was written into and quietly absent from
-- the other two, and the absence would look exactly like "nobody donated". The
-- rule belongs where every path must pass, per hard rule 1 of CLAUDE.md.
--
-- trust_level GATE: only 'V' (verified) and 'R' (retroactive) derive attendance.
-- A self-reported 'S' donation is a donor's own claim, entered with no blood
-- bank and no ISBT barcode; letting it write the roster would let anyone
-- manufacture attendance at any camp, inflating a camp's public impact numbers
-- and, once reliability scoring is wired, their own standing.
--
-- WHY 'AT' IS NEVER UNWOUND: a TTI-reactive result invalidates the donation
-- (is_invalidated, cascading to lookback and bag recall) but the person still
-- came and still gave. Attendance is an attendance fact, not a clinical one.
-- Reversing it would also retro-delete their thank-you message and erase the
-- camp from their history — punishing a donor for a result they did not choose.
-- There is deliberately no reverse trigger, and no is_invalidated gate here.
--
-- Timing note: this derivation is same-day, which is what makes it safe.
-- camp-donor-thankyou fires on scheduled_date + 1 day selecting status='AT', so
-- deriving from the donation keeps that job working and lets the organiser
-- watch attendance climb during the camp. Deriving from the TTI panel instead
-- would NOT — TTI entry lags the camp by days, and the thank-you would go out
-- to an empty roster.
-- ─────────────────────────────────────────────────────────────────────────────

-- 'WI' — reached the roster via a donation record, having never registered.
-- This is the walk-in the blood bank found at the desk and the platform did not
-- know about. Note a QR walk-in does NOT land here: they self-register on their
-- own phone through the donor wizard and carry source='QR', which is the path
-- that gets real consent and duplicate detection.
ALTER TABLE camp_registrations
  DROP CONSTRAINT camp_registrations_source_check;

ALTER TABLE camp_registrations
  ADD CONSTRAINT camp_registrations_source_check
  CHECK (source IN ('WB', 'WA', 'CO', 'QR', 'WI'));

COMMENT ON COLUMN camp_registrations.source IS
  'WB Web, WA WhatsApp bot, CO Coordinator-added, QR QR scan, '
  'WI derived from a donation record (never registered — unknown walk-in).';

CREATE OR REPLACE FUNCTION fn_donation_marks_camp_attendance()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO camp_registrations (camp_id, donor_id, status, source, status_changed_at)
  VALUES (NEW.donation_camp_id, NEW.donor_id, 'AT', 'WI', clock_timestamp())
  ON CONFLICT (camp_id, donor_id) DO UPDATE
     SET status            = 'AT',
         status_changed_at = clock_timestamp()
   WHERE camp_registrations.status <> 'AT';
   -- The upsert deliberately overwrites RG, NS and DF. A recorded donation is
   -- stronger evidence than a pre-registration, than a batch job's guess that
   -- nobody came, and than a desk marking someone deferred before the blood
   -- bank's entry landed. It leaves an existing AT alone so status_changed_at
   -- keeps pointing at the first donation, not the most recent edit.
   --
   -- source is only written on INSERT: a donor who registered as 'WB' and then
   -- donated keeps 'WB'. 'WI' means "we only ever learned of this person from a
   -- donation", so overwriting it would destroy exactly the distinction that
   -- tells an organiser how many people their mobilisation actually brought.
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION fn_donation_marks_camp_attendance() IS
  'Derives camp_registrations.status = AT from a verified/retroactive donation '
  'recorded against a camp. SECURITY DEFINER so it holds when RLS stops being '
  'inert — the blood_bank role has no write policy on camp_registrations.';

-- UPDATE OF donation_camp_id is covered as well as INSERT: attributing a
-- donation to a camp after the fact is a real correction (the blood bank
-- recorded 30 donations and forgot to pick the camp), and without it the roster
-- would stay empty while the data sat right there. Re-tagging from camp A to
-- camp B adds attendance at B without removing it from A — consistent with
-- attendance never being unwound, and a re-tag is rare enough to correct by
-- hand.
CREATE TRIGGER trg_donation_marks_camp_attendance
  AFTER INSERT OR UPDATE OF donation_camp_id ON donation_history
  FOR EACH ROW
  WHEN (NEW.donation_camp_id IS NOT NULL AND NEW.trust_level IN ('V', 'R'))
  EXECUTE FUNCTION fn_donation_marks_camp_attendance();

-- ROLLBACK
-- DROP TRIGGER IF EXISTS trg_donation_marks_camp_attendance ON donation_history;
-- DROP FUNCTION IF EXISTS fn_donation_marks_camp_attendance();
-- -- Rows the trigger created cannot be told apart from hand-marked ones except
-- -- by source='WI'; drop only those before narrowing the CHECK back.
-- DELETE FROM camp_registrations WHERE source = 'WI';
-- ALTER TABLE camp_registrations DROP CONSTRAINT camp_registrations_source_check;
-- ALTER TABLE camp_registrations ADD CONSTRAINT camp_registrations_source_check
--   CHECK (source IN ('WB', 'WA', 'CO', 'QR'));
