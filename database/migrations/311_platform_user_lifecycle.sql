-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 311: institution staff-user lifecycle
--
-- Motivation:
-- `platform_users` has no way to retire an account and no way to say which of
-- an institution's several staff logins may provision the others. Both gaps
-- surfaced together: a hospital was activated, its admin never received the
-- setup link, and there was no roster to look at, nobody to re-issue from, and
-- no way to disable a stale login once one existed.
--
-- Deactivation is SOFT: the row is never deleted. A staff login is referenced
-- by donation_history, donor_screening.entered_by/verified_by, bag_events,
-- audit_log and a dozen other clinical FKs — deleting one would either cascade
-- into a clinical record or fail outright. Soft-deactivation is the only shape
-- that preserves the audit trail, which for a life-critical system is the whole
-- point of the column.
--
-- Nothing here is a patient-safety rule. This is authorization + account
-- lifecycle, so the CHECK constraints below encode only structural invariants
-- (a reason cannot exist without a deactivation; a non-institutional role
-- cannot be an institution admin).
--
-- Additive. Existing rows get deactivated_at = NULL (all live) and
-- is_institution_admin backfilled from the `_admin` username convention that
-- services/onboarding/activate.js mints.
--
-- ── Scoping note: institution-admin gating lives in APPLICATION code ────────
-- The route guard `requireInstitutionUserAdmin` (backend/src/routes/
-- institutions.js) is the binding gate on who may invite / deactivate / unlock
-- a peer. It is deliberately NOT expressed in RLS: a policy on platform_users
-- that asks "is the acting user an institution admin?" must SELECT
-- platform_users to answer, which recurses through the very policy being
-- evaluated. The established escape hatch is a SECURITY DEFINER helper
-- (fn_actor_leads_community, migration 300), and that complexity is not
-- justified for an authz rule — the codebase's own precedent for staff
-- provisioning is a route guard (see requireRole in middleware/auth.js).
--
-- What RLS DOES enforce below is the institution boundary: a hospital actor can
-- only ever see or touch rows belonging to its own institution_id. So the worst
-- an application bug can do is let a technician manage a colleague — never
-- reach into another hospital. That is the boundary worth putting in the
-- database; the admin/technician split within one institution is not.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Lifecycle columns ────────────────────────────────────────────────────
ALTER TABLE platform_users
  ADD COLUMN deactivated_at      TIMESTAMPTZ,
  ADD COLUMN deactivated_by      UUID REFERENCES platform_users(id),
  ADD COLUMN deactivation_reason TEXT;

COMMENT ON COLUMN platform_users.deactivated_at IS
  'Soft-deactivation timestamp. NULL = the account may sign in. Non-NULL is rejected by POST /auth/institutional/login with 403 account_deactivated. Rows are NEVER deleted — clinical tables (donation_history, donor_screening.entered_by/verified_by, bag_events) hold FKs to this id and the audit trail must stay resolvable.';
COMMENT ON COLUMN platform_users.deactivated_by IS
  'Who deactivated this account. NULL for a system-initiated deactivation.';

-- A reason or an actor with no deactivation is a half-written record. The
-- reverse (a deactivation with neither) is legitimate, and reactivation clears
-- all three together.
ALTER TABLE platform_users
  ADD CONSTRAINT deactivation_consistency CHECK (
    deactivated_at IS NOT NULL
    OR (deactivated_by IS NULL AND deactivation_reason IS NULL)
  );

-- ── 2. Institution-admin flag ───────────────────────────────────────────────
ALTER TABLE platform_users
  ADD COLUMN is_institution_admin BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN platform_users.is_institution_admin IS
  'TRUE = this staff login may invite, deactivate, unlock and re-issue setup links for other logins of the SAME institution. The only sub-role distinction inside an institution — role stays hospital/blood_bank for every user, so no clinical capability is gated on this flag (a technician records donations and TTI exactly as an admin does).';

-- Only institution-scoped roles can be an institution admin. ngo_admin /
-- super_admin already hold platform-wide authority via `role`; dho and
-- coordinator have no institution_id to be an admin OF.
ALTER TABLE platform_users
  ADD CONSTRAINT institution_admin_role_scope CHECK (
    is_institution_admin = FALSE OR role IN ('hospital','blood_bank')
  );

-- Backfill: the admin accounts provisioned at activation are exactly the ones
-- named `<shortname>_admin` (services/onboarding/activate.js). Any institution
-- whose only login predates this migration keeps its ability to self-manage.
UPDATE platform_users
   SET is_institution_admin = TRUE
 WHERE role IN ('hospital','blood_bank')
   AND username LIKE '%\_admin';

-- ── 3. Roster index ─────────────────────────────────────────────────────────
-- GET /institutions/:id/users and GET /admin/institution-users both filter on
-- institution_id restricted to the institutional roles.
CREATE INDEX idx_platform_users_institution_staff
  ON platform_users(institution_id)
  WHERE role IN ('hospital','blood_bank');

-- ── 4. RLS: institution boundary + fix the 'onboarding' actor ───────────────
-- Two changes, both replacing whole policy bodies (Postgres has no
-- ALTER POLICY ... ADD). Current bodies: pu_self_select from migration 240,
-- pu_self_update + pu_admin_insert from migration 100 (never revised since).
--
-- (a) 'onboarding' is added to the write policies. This is a LATENT BUG FIX:
--     services/onboarding/activate.js runs its whole transaction under
--     actor_role='onboarding' and both INSERTs and UPDATEs platform_users, as
--     does POST /auth/institutional/reset-password. Neither pu_admin_insert nor
--     pu_self_update lists that role, so both paths work today only because RLS
--     is inert at runtime (the app connects as an owner role with BYPASSRLS;
--     app_user is NOLOGIN). They would fail closed the moment the app is
--     repointed at app_user — institution activation would break as a
--     *consequence* of a security fix. Fixed here while it is cheap.
--
-- (b) hospital/blood_bank actors may read and update rows of their OWN
--     institution, so the staff roster and its actions survive RLS becoming
--     real. INSERT is constrained harder than UPDATE: an institution may only
--     create a row inside its own institution_id and only with its own role, so
--     an invite can never mint an ngo_admin or a login for another hospital.

DROP POLICY IF EXISTS pu_self_select ON platform_users;
CREATE POLICY pu_self_select ON platform_users FOR SELECT TO app_user
  USING (
    id::text = current_setting('raktify.actor_user_id', TRUE)
    OR current_setting('raktify.actor_role', TRUE) IN ('ngo_admin','super_admin','system')
    OR (
      current_setting('raktify.actor_role', TRUE) IN ('hospital','blood_bank')
      AND institution_id IS NOT NULL
      AND institution_id::text = current_setting('raktify.actor_institution_id', TRUE)
    )
  );

DROP POLICY IF EXISTS pu_self_update ON platform_users;
CREATE POLICY pu_self_update ON platform_users FOR UPDATE TO app_user
  USING (
    id::text = current_setting('raktify.actor_user_id', TRUE)
    OR current_setting('raktify.actor_role', TRUE)
         IN ('ngo_admin','super_admin','onboarding')
    OR (
      current_setting('raktify.actor_role', TRUE) IN ('hospital','blood_bank')
      AND institution_id IS NOT NULL
      AND institution_id::text = current_setting('raktify.actor_institution_id', TRUE)
    )
  )
  WITH CHECK (
    id::text = current_setting('raktify.actor_user_id', TRUE)
    OR current_setting('raktify.actor_role', TRUE)
         IN ('ngo_admin','super_admin','onboarding')
    OR (
      current_setting('raktify.actor_role', TRUE) IN ('hospital','blood_bank')
      AND institution_id IS NOT NULL
      AND institution_id::text = current_setting('raktify.actor_institution_id', TRUE)
    )
  );

DROP POLICY IF EXISTS pu_admin_insert ON platform_users;
CREATE POLICY pu_admin_insert ON platform_users FOR INSERT TO app_user
  WITH CHECK (
    current_setting('raktify.actor_role', TRUE)
      IN ('ngo_admin','super_admin','registration','onboarding')
    OR (
      current_setting('raktify.actor_role', TRUE) IN ('hospital','blood_bank')
      AND role = current_setting('raktify.actor_role', TRUE)
      AND institution_id IS NOT NULL
      AND institution_id::text = current_setting('raktify.actor_institution_id', TRUE)
    )
  );

-- ROLLBACK
-- DROP POLICY IF EXISTS pu_admin_insert ON platform_users;
-- CREATE POLICY pu_admin_insert ON platform_users FOR INSERT TO app_user
--   WITH CHECK (
--     current_setting('raktify.actor_role', TRUE) IN ('ngo_admin','super_admin','registration')
--   );
-- DROP POLICY IF EXISTS pu_self_update ON platform_users;
-- CREATE POLICY pu_self_update ON platform_users FOR UPDATE TO app_user
--   USING (
--     id::text = current_setting('raktify.actor_user_id', TRUE)
--     OR current_setting('raktify.actor_role', TRUE) IN ('ngo_admin','super_admin')
--   )
--   WITH CHECK (
--     id::text = current_setting('raktify.actor_user_id', TRUE)
--     OR current_setting('raktify.actor_role', TRUE) IN ('ngo_admin','super_admin')
--   );
-- DROP POLICY IF EXISTS pu_self_select ON platform_users;
-- CREATE POLICY pu_self_select ON platform_users FOR SELECT TO app_user
--   USING (
--     id::text = current_setting('raktify.actor_user_id', TRUE)
--     OR current_setting('raktify.actor_role', TRUE) IN ('ngo_admin','super_admin','system')
--   );
-- DROP INDEX IF EXISTS idx_platform_users_institution_staff;
-- ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS institution_admin_role_scope;
-- ALTER TABLE platform_users DROP COLUMN IF EXISTS is_institution_admin;
-- ALTER TABLE platform_users DROP CONSTRAINT IF EXISTS deactivation_consistency;
-- ALTER TABLE platform_users
--   DROP COLUMN IF EXISTS deactivation_reason,
--   DROP COLUMN IF EXISTS deactivated_by,
--   DROP COLUMN IF EXISTS deactivated_at;
