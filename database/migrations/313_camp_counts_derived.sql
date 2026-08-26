-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 313: camp roster counts derive from the roster
--
-- Motivation:
-- donation_camps carries three denormalised counts. Only ONE of them was ever
-- maintained. Migration 260 created trg_camp_reg_count_ins/_del, which
-- increment and decrement registered_donor_count; attended_donor_count has no
-- trigger anywhere in the schema and is written only by hand at
-- POST /camps/:id/complete. So every surface that reads the column shows 0
-- attended for camps with real attendance — the admin Camps tab, the community
-- detail page, the public camp landing page and the DHO camp band all read it.
-- The organizer dashboard looked right purely because it counts the roster live.
--
-- Two changes, one idea: make all three counts a projection of
-- camp_registrations rather than a parallel tally that drifts from it.
--
-- Recompute-from-source, not increment/decrement. An increment is only correct
-- if every write path fires exactly once, and this table has five of them
-- (donor RSVP, donor cancel, coordinator status change, magic-link desk status
-- change, and from migration 314 the donation trigger). A full recount for one
-- camp reads a few hundred rows on the covering index and cannot drift no
-- matter how many paths appear later. Correctness beats a saved row scan on a
-- table this size.
--
-- Definitions, and why each is what it is:
--   registered_donor_count = COUNT(*) WHERE status <> 'CN'
--       Preserves today's effective meaning. Cancel currently DELETEs the row,
--       so "a row exists" already meant "not cancelled"; once cancel becomes a
--       status change the filter keeps the number the same.
--   attended_donor_count   = COUNT(*) WHERE status = 'AT'
--       This is migration 260's own definition of AT — "Attended (donation
--       recorded)".
--   deferred_donor_count   = COUNT(*) WHERE status = 'DF'   (migration 312)
--
-- Turnout is attended + deferred. Absent is registered - attended - deferred.
-- Neither is stored: a derived number computed at read time cannot go stale.
--
-- SECURITY DEFINER on the recount helper. The old triggers were not, which
-- means the moment RLS stops being inert (the pool connects as a BYPASSRLS
-- owner today) a donor RSVP would fail: the trigger UPDATEs donation_camps and
-- the donor role has no UPDATE policy there. That latent breakage is not
-- introduced here, but it is cheap to close while these triggers are being
-- rewritten. search_path is pinned per the migration 300 precedent so the
-- definer's rights cannot be redirected at a shadowed table.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_camp_reg_count_ins ON camp_registrations;
DROP TRIGGER IF EXISTS trg_camp_reg_count_del ON camp_registrations;
DROP FUNCTION IF EXISTS fn_camp_reg_count_ins();
DROP FUNCTION IF EXISTS fn_camp_reg_count_del();

CREATE OR REPLACE FUNCTION fn_camp_recount(p_camp_id UUID)
  RETURNS VOID
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp AS $$
  UPDATE donation_camps c
     SET registered_donor_count = s.registered,
         attended_donor_count   = s.attended,
         deferred_donor_count   = s.deferred
    FROM (
      SELECT COUNT(*) FILTER (WHERE status <> 'CN')::INTEGER AS registered,
             COUNT(*) FILTER (WHERE status  = 'AT')::INTEGER AS attended,
             COUNT(*) FILTER (WHERE status  = 'DF')::INTEGER AS deferred
        FROM camp_registrations
       WHERE camp_id = p_camp_id
    ) s
   WHERE c.id = p_camp_id;
$$;

COMMENT ON FUNCTION fn_camp_recount(UUID) IS
  'Recomputes the three denormalised roster counts on donation_camps from '
  'camp_registrations. Idempotent — safe to call from any write path.';

CREATE OR REPLACE FUNCTION fn_camp_reg_counts() RETURNS TRIGGER
  LANGUAGE plpgsql AS $$
BEGIN
  -- DELETE and UPDATE both need the camp the row is leaving.
  IF TG_OP <> 'INSERT' THEN
    PERFORM fn_camp_recount(OLD.camp_id);
  END IF;
  -- INSERT needs the arriving camp; UPDATE only if the row actually moved
  -- camps (it never should, but a recount is cheaper than an audit).
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.camp_id IS DISTINCT FROM OLD.camp_id) THEN
    PERFORM fn_camp_recount(NEW.camp_id);
  END IF;
  RETURN NULL;  -- AFTER trigger; return value is ignored
END;
$$;

CREATE TRIGGER trg_camp_reg_counts
  AFTER INSERT OR DELETE OR UPDATE OF status, camp_id ON camp_registrations
  FOR EACH ROW EXECUTE FUNCTION fn_camp_reg_counts();

-- ── Backfill ────────────────────────────────────────────────────────────────
-- registered_donor_count and deferred_donor_count are overwritten outright:
-- the first was maintained by the old triggers and the second was born zero in
-- migration 312, so the derived value is authoritative for both.
--
-- attended_donor_count uses GREATEST(derived, existing). Camps run before this
-- migration have hand-entered attendance totals whose rosters were never
-- marked, and a straight overwrite would silently zero a real historical
-- number. This lives in the backfill ONLY — never in the trigger, where a
-- GREATEST would make attendance a ratchet that could not be corrected down.
UPDATE donation_camps c
   SET registered_donor_count = s.registered,
       attended_donor_count   = GREATEST(s.attended, c.attended_donor_count),
       deferred_donor_count   = s.deferred
  FROM (
    SELECT dc.id AS camp_id,
           COUNT(cr.id) FILTER (WHERE cr.status <> 'CN')::INTEGER AS registered,
           COUNT(cr.id) FILTER (WHERE cr.status  = 'AT')::INTEGER AS attended,
           COUNT(cr.id) FILTER (WHERE cr.status  = 'DF')::INTEGER AS deferred
      FROM donation_camps dc
      LEFT JOIN camp_registrations cr ON cr.camp_id = dc.id
     GROUP BY dc.id
  ) s
 WHERE c.id = s.camp_id;

-- ROLLBACK
-- DROP TRIGGER IF EXISTS trg_camp_reg_counts ON camp_registrations;
-- DROP FUNCTION IF EXISTS fn_camp_reg_counts();
-- DROP FUNCTION IF EXISTS fn_camp_recount(UUID);
-- CREATE OR REPLACE FUNCTION fn_camp_reg_count_ins() RETURNS TRIGGER LANGUAGE plpgsql AS $$
-- BEGIN
--   UPDATE donation_camps
--      SET registered_donor_count = registered_donor_count + 1
--    WHERE id = NEW.camp_id;
--   RETURN NEW;
-- END;
-- $$;
-- CREATE OR REPLACE FUNCTION fn_camp_reg_count_del() RETURNS TRIGGER LANGUAGE plpgsql AS $$
-- BEGIN
--   UPDATE donation_camps
--      SET registered_donor_count = GREATEST(0, registered_donor_count - 1)
--    WHERE id = OLD.camp_id;
--   RETURN OLD;
-- END;
-- $$;
-- CREATE TRIGGER trg_camp_reg_count_ins
--   AFTER INSERT ON camp_registrations FOR EACH ROW EXECUTE FUNCTION fn_camp_reg_count_ins();
-- CREATE TRIGGER trg_camp_reg_count_del
--   AFTER DELETE ON camp_registrations FOR EACH ROW EXECUTE FUNCTION fn_camp_reg_count_del();
