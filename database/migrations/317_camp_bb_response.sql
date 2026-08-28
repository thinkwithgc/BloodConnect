-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 317: the partnered blood bank answers — accept, or decline with a
--                reason
--
-- Migration 316 lets a BB publish capacity in advance, which answers most of
-- the question before it is asked. This is the exception path: capacity says
-- "we can staff 6 camps on the 14th", it does not say "yes to THIS camp, at a
-- school 80 km away, with a hall that has no power". The BB still gets to
-- answer, and when it says no it says why, once, in a field — instead of on a
-- phone call the platform never sees.
--
--   ⚠ THIS IS AN ORTHOGONAL AXIS. donation_camps.status GAINS NO VALUE.
--   status is a CHECK-constrained enum ('PE','PL','LV','CO','CA','DC') read by
--   frontend/src/lib/campStatus.js, the admin CampsTab, MyCampsSection,
--   PublicCampPage, GET /camps/collectable and the camp_close_roster job, plus
--   a long tail of IN ('PL','LV') predicates. A new status value would make
--   every one of those palettes and predicates quietly wrong. bb_response sits
--   BESIDE status exactly as blood_requests.crossmatch_confirmed sits beside
--   blood_requests.status.
--
--   ⚠ bb_response NEVER CHANGES status, AND NEVER CHANGES WHAT
--     GET /camps/collectable RETURNS.
--   A decline does not cancel the camp — the event is still happening, 200
--   donors may already have RSVP'd, and it is the NGO admin's job to find
--   another blood bank. And a BB that declined on Monday but has a van free on
--   Saturday must still be able to walk in and collect: collectable's district
--   fallback is deliberately untouched. Narrowing it to accepted-only would
--   hide camps from the blood banks most likely to save them.
--
-- A decline also does NOT clear partnered_blood_bank_id. Clearing it would
-- erase the record of who declined and silently return the camp to "nobody
-- asked yet", which is the state the admin most needs to distinguish from
-- "asked, and turned down". The admin re-partners explicitly, and that reset
-- puts bb_response back to 'PE' for the new BB.
--
-- Nullable with NO default, deliberately. A camp with no blood bank at all must
-- stay legal and stay 'PL': several Amravati talukas have no onboarded BB, the
-- camp still runs, and a district BB collects under the collectable fallback.
-- 'PE' is written at the moment a partner is — not before.
--
-- Decline reasons EXTEND migration 287's vocabulary rather than inventing a
-- second one. 287 (open_request_bb_declines) uses NS / NC / ND for the
-- request-side decline; NC and ND mean the same things here.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE donation_camps
  ADD COLUMN bb_response       CHAR(2) CHECK (bb_response IN ('PE','AC','DC')),
  ADD COLUMN bb_response_at    TIMESTAMPTZ,
  ADD COLUMN bb_response_by    UUID REFERENCES platform_users(id),
  ADD COLUMN bb_decline_reason CHAR(2)
                               CHECK (bb_decline_reason IN ('NC','ND','DT','VE','OT')),
  ADD COLUMN bb_decline_note   TEXT;

-- A response with nobody to have made it is meaningless. This is the one
-- invariant worth constraining: the response belongs to the partnered BB, so it
-- cannot exist before a partner does.
ALTER TABLE donation_camps
  ADD CONSTRAINT bb_response_needs_partner
    CHECK (bb_response IS NULL OR partnered_blood_bank_id IS NOT NULL);

-- A decline reason without a decline is a leftover from a re-partner that
-- forgot to clear it, which would render as a red flag on an accepted camp.
ALTER TABLE donation_camps
  ADD CONSTRAINT bb_decline_reason_needs_decline
    CHECK (bb_decline_reason IS NULL OR bb_response = 'DC');

COMMENT ON COLUMN donation_camps.bb_response IS
  'The partnered blood bank''s answer: PE awaiting, AC accepted, DC declined. '
  'Orthogonal to status — it never changes status, and never changes what '
  'GET /camps/collectable returns. NULL means no partner has been asked yet.';

COMMENT ON COLUMN donation_camps.bb_decline_reason IS
  'NC no capacity that day · ND staff not on duty · DT date clash · '
  'VE venue/logistics not workable · OT other (see bb_decline_note). '
  'Shown to the NGO admin, NEVER to the organiser — they see only that a '
  'different blood bank is being arranged.';

CREATE INDEX idx_camps_bb_response
  ON donation_camps(partnered_blood_bank_id, bb_response)
  WHERE bb_response IS NOT NULL;

-- ROLLBACK
-- DROP INDEX idx_camps_bb_response;
-- ALTER TABLE donation_camps DROP CONSTRAINT bb_decline_reason_needs_decline;
-- ALTER TABLE donation_camps DROP CONSTRAINT bb_response_needs_partner;
-- ALTER TABLE donation_camps
--   DROP COLUMN bb_decline_note,
--   DROP COLUMN bb_decline_reason,
--   DROP COLUMN bb_response_by,
--   DROP COLUMN bb_response_at,
--   DROP COLUMN bb_response;
