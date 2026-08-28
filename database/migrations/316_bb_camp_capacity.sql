-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 316: a blood bank publishes how many camps it can staff, per day
--
-- Motivation:
-- Migration 315 let a camp organiser NAME a blood bank and let the NGO admin
-- confirm it. It never asked the blood bank. Today the admin partners a BB by
-- fiat and everything after that is phone calls — can you do the 14th, how many
-- staff can you spare, are you closed for Diwali. The BB is the only party who
-- knows the answer and the only party the platform never asks.
--
-- So it asks in advance. A blood bank with 50 staff that needs 8 people per
-- camp publishes "6 camps a day, closed the 12th–15th" once, for the month, and
-- every organiser who opens the hosting form afterwards can already see which
-- days that BB can serve. The per-camp accept/decline (migration 317) becomes
-- the exception path instead of the normal one — which is the only way the
-- volume of messages actually goes down.
--
-- Two tables because there are two lifetimes. Settings change when the BB hires
-- or restructures; capacity changes every month. One row per BB, many rows per
-- BB per date.
--
--   ⚠ max_camps = 0 IS HOW A HOLIDAY IS EXPRESSED.
--   There is deliberately no separate blackout / holiday table. "Closed on the
--   14th" and "only 2 camps on the 14th" are the same edit to the same column,
--   so the calendar has one number to read and the booking gate has one number
--   to check. A second table would mean two sources of truth for one question.
--
--   ⚠ ABSENCE OF A ROW MEANS "NOT PUBLISHED", NEVER "CLOSED".
--   On the day this ships no blood bank has published anything. If a missing
--   row read as closed, camp hosting would stop platform-wide for a live pilot.
--   Unpublished dates behave exactly as they do today: unconstrained.
--   services/camps/capacity.js encodes this as published:false, and the gate
--   in routes/camps.js only ever blocks a day it can see a row for.
--
-- staff_total / staff_per_camp are ADVISORY. They drive a suggested max_camps
-- (floor(total / per_camp)) and the "48 of 50 staff committed" readout on the
-- calendar. They never bind: max_camps is the number the BB actually commits
-- to, so a BB borrowing two techs from another branch for one big camp is never
-- blocked by arithmetic it did not ask for.
--
-- Staff means NUMBERS, not named people. No leave calendar, no shift roster, no
-- per-person allocation — that is a different product, and institution users
-- are a separate track. This table answers "how many camps", nothing else.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE bb_camp_settings (
  blood_bank_id      UUID PRIMARY KEY REFERENCES institutions(id),

  -- Advisory staffing arithmetic. Nullable: a BB may publish max_camps per day
  -- without ever telling us its headcount, and that is a complete answer.
  staff_total        SMALLINT CHECK (staff_total BETWEEN 0 AND 500),
  staff_per_camp     SMALLINT CHECK (staff_per_camp BETWEEN 1 AND 100),

  -- Used by POST /camps/bb/capacity/publish-month to generate a month of rows.
  -- Not a live gate — a day with no row is unpublished, not defaulted.
  default_max_camps  SMALLINT NOT NULL DEFAULT 1
                     CHECK (default_max_camps BETWEEN 0 AND 20),

  -- ISO dow, 0 = Sunday .. 6 = Saturday. A TEMPLATE for publish-month, not a
  -- live gate: a BB that agrees to one exceptional Sunday simply sets that
  -- single day's max_camps and the array stays as it is.
  weekly_closed_days SMALLINT[] NOT NULL DEFAULT '{}',

  -- When true, a camp requesting this BB on a day inside published capacity is
  -- stamped bb_response='AC' at apply time instead of 'PE'. Opt-in, default
  -- off: silently committing a BB to a venue it has not seen is exactly the
  -- surprise this feature exists to remove.
  auto_accept_within_capacity BOOLEAN NOT NULL DEFAULT FALSE,

  updated_by_user_id UUID REFERENCES platform_users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  -- Arithmetic that cannot be true. Caught here rather than surfacing as a
  -- nonsense suggested-capacity number on the calendar.
  CONSTRAINT staff_per_camp_fits_total
    CHECK (staff_total IS NULL OR staff_per_camp IS NULL
           OR staff_per_camp <= staff_total)
);

COMMENT ON TABLE bb_camp_settings IS
  'One row per blood bank: its standing camp-hosting posture. staff_total and '
  'staff_per_camp are advisory (they suggest a max_camps); default_max_camps '
  'and weekly_closed_days are the template for publish-month. Nothing here '
  'gates a booking — bb_camp_capacity does that, per date.';

COMMENT ON COLUMN bb_camp_settings.weekly_closed_days IS
  'ISO day-of-week numbers (0=Sunday) the BB is normally closed for camps. A '
  'template applied by publish-month, never a live predicate.';

CREATE TABLE bb_camp_capacity (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blood_bank_id   UUID NOT NULL REFERENCES institutions(id),

  -- DATE, not TIMESTAMPTZ. donation_camps.scheduled_date is a DATE too, so the
  -- comparison is a plain date equality and donation_camps.timezone never
  -- enters into it. One convention, no timezone arithmetic.
  capacity_date   DATE NOT NULL,

  -- 0 = closed. The binding number.
  max_camps       SMALLINT NOT NULL CHECK (max_camps BETWEEN 0 AND 20),

  -- Advisory readout for the calendar header ("48 of 50 committed"). Never
  -- checked against staff_total — a BB may legitimately over-commit by
  -- borrowing, and being told it cannot is not this table's job.
  staff_committed SMALLINT CHECK (staff_committed BETWEEN 0 AND 500),

  -- "Diwali", "2 techs on leave", "AC plant service". Shown to the BB on its
  -- own calendar and to the NGO admin. NEVER returned by the public
  -- availability endpoint — a note can name a person or a reason the BB would
  -- not publish to an organiser it has not met.
  note            TEXT,

  set_by_user_id  UUID NOT NULL REFERENCES platform_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  UNIQUE (blood_bank_id, capacity_date)
);

COMMENT ON TABLE bb_camp_capacity IS
  'How many camps one blood bank can staff on one date. max_camps=0 expresses '
  'a holiday — there is no separate blackout table. A date with NO row is '
  'unpublished, which never blocks a booking (see 316 header).';

COMMENT ON COLUMN bb_camp_capacity.note IS
  'Free text for the BB and the NGO admin. Deliberately excluded from the '
  'public GET /camps/bb-availability response.';

CREATE INDEX idx_bb_capacity_lookup
  ON bb_camp_capacity(blood_bank_id, capacity_date);

-- Both tables carry an audit trail: a BB that closed a day and reopened it, or
-- an NGO admin who bootstrapped capacity on a BB's behalf, must be
-- reconstructable. Same helper every feature table uses (099).
SELECT attach_audit_trigger('bb_camp_settings');
SELECT attach_audit_trigger('bb_camp_capacity');

-- ── RLS ────────────────────────────────────────────────────────────────────
-- blood_bank    read + write OWN rows only
-- ngo_admin     read + write any (bootstraps capacity for a BB that has not
--               published yet — on day one that is every BB, and the admin is
--               the bridge between organiser and blood bank)
-- coordinator   read all (district oversight; sees whether a day is bookable)
-- system        read all (the availability endpoint and the apply gate run
--               under elevated actor_role, per migration 240's precedent)
--
-- ⚠ Written for correctness, NOT relied upon. RLS is inert at runtime — the app
-- connects as a BYPASSRLS owner and app_user is NOLOGIN — so every handler
-- carries its own WHERE blood_bank_id = req.user.institutionId. That WHERE is
-- the security boundary. These policies are what makes the boundary hold if and
-- when the connection role is fixed.

ALTER TABLE bb_camp_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY bb_camp_settings_read ON bb_camp_settings FOR SELECT TO app_user
  USING (
    fn_is_admin()
    OR fn_actor_role() IN ('coordinator', 'system')
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

CREATE POLICY bb_camp_settings_insert ON bb_camp_settings FOR INSERT TO app_user
  WITH CHECK (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

CREATE POLICY bb_camp_settings_update ON bb_camp_settings FOR UPDATE TO app_user
  USING (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  )
  WITH CHECK (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

ALTER TABLE bb_camp_capacity ENABLE ROW LEVEL SECURITY;

CREATE POLICY bb_camp_capacity_read ON bb_camp_capacity FOR SELECT TO app_user
  USING (
    fn_is_admin()
    OR fn_actor_role() IN ('coordinator', 'system')
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

CREATE POLICY bb_camp_capacity_insert ON bb_camp_capacity FOR INSERT TO app_user
  WITH CHECK (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

CREATE POLICY bb_camp_capacity_update ON bb_camp_capacity FOR UPDATE TO app_user
  USING (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  )
  WITH CHECK (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

-- A BB may withdraw a published day (back to unpublished). Admin too.
CREATE POLICY bb_camp_capacity_delete ON bb_camp_capacity FOR DELETE TO app_user
  USING (
    fn_is_admin()
    OR (fn_actor_role() = 'blood_bank' AND blood_bank_id = fn_actor_institution_id())
  );

-- ROLLBACK
-- DROP TABLE bb_camp_capacity;
-- DROP TABLE bb_camp_settings;
