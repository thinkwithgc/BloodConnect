/**
 * Institution management.
 *
 *   GET  /institutions               ngo_admin/super_admin → list
 *   GET  /institutions/:id           ngo_admin or self     → details
 *   GET  /institutions/:id/audit     ngo_admin or self     → this record's history
 *   PUT  /institutions/:id           ngo_admin             → update whitelist
 *   POST /institutions/:id/suspend   ngo_admin             → suspend    (reason)
 *   POST /institutions/:id/unsuspend ngo_admin             → un-suspend (reason)
 *   POST /institutions/:id/archive   super_admin           → archive    (reason)
 *   POST /institutions/:id/unarchive super_admin           → un-archive (reason)
 *
 *   Nothing here deletes. "Remove this hospital" is onboarding_status='AR' with a
 *   written reason, reversible by a super-admin; "remove this user" is
 *   deactivated_at with a written reason. audit_log, donation_history and
 *   donor_screening.verified_by all hold FKs into these rows, and an audit trail
 *   that cannot resolve who performed a screening is a worse outcome than a
 *   record nobody uses any more.
 *
 *   Staff-user management (one family, two callers — the NGO admin and the
 *   institution itself, which is why it lives here next to the existing
 *   `isAdmin || isSelf` guard rather than in a second router):
 *
 *   GET  /institutions/:id/users                        ngo_admin or self → roster
 *   POST /institutions/:id/users                        institution admin → invite
 *   POST /institutions/:id/users/:userId/reissue-setup  institution admin → new setup link
 *   POST /institutions/:id/users/:userId/deactivate     institution admin
 *   POST /institutions/:id/users/:userId/reactivate     institution admin
 *   POST /institutions/:id/users/:userId/unlock         institution admin
 *   POST /institutions/:id/users/:userId/admin-flag     institution admin
 *
 *   An institution admin's reach includes its in-house blood bank (the child row
 *   linked by parent_institution_id) but never the reverse — see
 *   resolveInstitutionAdmin.
 */
const express = require('express');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContext } = require('../middleware/rlsContext');
const { verifyJWT, requireRole, requireReason, validateReason } = require('../middleware/auth');
const { normaliseIndianMobile } = require('../utils/phone');
const { sendNotification } = require('../services/notifications');
const setupSvc = require('../services/users/setup');
const { ROSTER_COLUMNS, toRosterRow } = require('../services/users/directory');
// Credential fields land in audit_log's old_value / new_value because the audit
// trigger has no column blacklist. Shared with GET /admin/audit so there is one
// definition of what must never be rendered back.
const { redactAuditRow } = require('../utils/auditRedaction');

const router = express.Router();

// The list carries the two dates an administrator is scanning for — licence
// expiry and MoU expiry — plus the district name, so the Institutions tab can
// flag what is lapsing without one lookup per row. parent_institution_id lets a
// paired hospital + in-house blood bank read as one organisation rather than two
// unrelated rows.
router.get('/', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const status = req.query.status;
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT i.id, i.kind, i.shortname, i.legal_name, i.display_name,
                i.district_id, d.name AS district_name,
                i.onboarding_status, i.onboarded_at, i.is_active, i.suspended_at,
                -- Both are DATE. Handed over as text so a calendar date cannot be
                -- shifted a day by the driver's local-midnight Date or by the
                -- reader's timezone: a licence expiry is a legal fact, not an
                -- instant. Also the exact shape <input type="date"> wants back.
                to_char(i.cdsco_licence_expires, 'YYYY-MM-DD') AS cdsco_licence_expires,
                to_char(i.mou_expires_at, 'YYYY-MM-DD') AS mou_expires_at,
                i.has_inhouse_blood_bank, i.parent_institution_id
           FROM institutions i
      LEFT JOIN districts d ON d.id = i.district_id
          WHERE ($1::text IS NULL OR i.onboarding_status = $1)
          ORDER BY i.onboarded_at DESC NULLS LAST, i.onboarding_started_at DESC
          LIMIT 500`,
      [status || null],
    ),
  );
  res.json({ institutions: r.rows, count: r.rowCount });
});

router.get('/:id', verifyJWT, async (req, res) => {
  const isAdmin = ['ngo_admin', 'super_admin'].includes(req.user.role);
  const isSelf = req.user.institutionId === req.params.id;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'forbidden' });

  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT i.id, i.kind, i.shortname, i.legal_name, i.display_name,
              i.parent_institution_id,
              i.state_id, i.district_id, i.taluka_id, i.village_id,
              i.address_line, i.pincode, i.latitude, i.longitude,
              i.cdsco_licence_number, i.hospital_registration_no,
              -- DATE columns as text — see the list handler above.
              to_char(i.cdsco_licence_expires, 'YYYY-MM-DD') AS cdsco_licence_expires,
              to_char(i.mou_expires_at, 'YYYY-MM-DD') AS mou_expires_at,
              i.license_verified_at, i.primary_contact_name, i.primary_contact_designation,
              i.primary_contact_mobile, i.primary_contact_email,
              i.onboarding_status, i.onboarding_started_at, i.onboarded_at,
              i.suspended_at, i.suspension_reason,
              i.mou_signed_at, i.mou_signatory_name,
              i.has_inhouse_blood_bank, i.is_blood_bank_software_user, i.software_vendor,
              i.is_active, i.created_at, i.updated_at,
              -- Names alongside the FKs: an edit form that can only display
              -- "district 493" is not an edit form, and the geography picker has
              -- to pre-select what is already stored.
              st.name AS state_name, d.name AS district_name,
              tk.name AS taluka_name, v.name AS village_name
         FROM institutions i
    LEFT JOIN states    st ON st.id = i.state_id
    LEFT JOIN districts d  ON d.id  = i.district_id
    LEFT JOIN talukas   tk ON tk.id = i.taluka_id
    LEFT JOIN villages  v  ON v.id  = i.village_id
        WHERE i.id = $1`,
      [req.params.id],
    ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });

  const inst = r.rows[0];

  // The paired institution, reported in both directions. A hospital needs to know
  // its in-house blood bank exists so the detail page can offer that roster; a
  // blood bank needs to know it has a parent so the page can explain why its own
  // admin cannot edit the hospital.
  const fam = await withRlsContext(req, (c) =>
    c.query(
      `SELECT id, kind, shortname, display_name, onboarding_status, is_active,
              parent_institution_id
         FROM institutions
        WHERE parent_institution_id = $1
           OR ($2::uuid IS NOT NULL AND id = $2::uuid)`,
      [inst.id, inst.parent_institution_id || null],
    ),
  );

  res.json({
    ...inst,
    children: fam.rows.filter((x) => x.parent_institution_id === inst.id),
    parent: fam.rows.find((x) => x.id === inst.parent_institution_id) || null,
  });
});

const updateSchema = z
  .object({
    legal_name: z.string().min(2).optional(),
    display_name: z.string().min(2).optional(),
    state_id: z.number().int().positive().optional(),
    district_id: z.number().int().positive().optional(),
    taluka_id: z.number().int().positive().nullable().optional(),
    village_id: z.number().int().positive().nullable().optional(),
    address_line: z.string().min(5).optional(),
    pincode: z
      .string()
      .regex(/^[1-9]\d{5}$/)
      .optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    cdsco_licence_number: z.string().min(3).nullable().optional(),
    // DATE column, so a plain calendar date rather than a timestamp — a browser
    // timezone must never be able to shift a licence expiry by a day.
    cdsco_licence_expires: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    hospital_registration_no: z.string().min(2).nullable().optional(),
    primary_contact_name: z.string().min(2).optional(),
    primary_contact_designation: z.string().optional(),
    primary_contact_mobile: z.string().optional(),
    primary_contact_email: z.string().email().optional(),
    has_inhouse_blood_bank: z.boolean().optional(),
    is_blood_bank_software_user: z.boolean().optional(),
    software_vendor: z.string().optional(),
    // Not a column. Consumed by the critical-field gate below and stripped
    // before the SET list is built.
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * Fields whose change has consequences beyond this one record, and which
 * therefore may not be edited without a written justification.
 *
 * Both licence fields, because a licence number and its expiry are the legal
 * basis on which a blood bank operates — "who changed this, when, and on whose
 * word" is the first question an inspection asks. legal_name and
 * hospital_registration_no because they are the identity on the MoU and under
 * the Clinical Establishments Act. The geography FKs because district_id is what
 * places an institution inside a coordinator's queue and a DHO's dashboard, so
 * changing it silently re-routes live requests. has_inhouse_blood_bank because
 * it decides whether this hospital's admin governs a second institution's
 * logins.
 *
 * Everything else — display name, address, phone, contact person, lat/lng — is a
 * correction. Demanding an essay for a corrected phone number would only teach
 * operators to type "update" into the box, which is worse than not asking.
 */
const CRITICAL_FIELDS = new Set([
  'legal_name',
  'cdsco_licence_number',
  'cdsco_licence_expires',
  'hospital_registration_no',
  'state_id',
  'district_id',
  'taluka_id',
  'village_id',
  'has_inhouse_blood_bank',
]);

const GEOGRAPHY_FIELDS = ['state_id', 'district_id', 'taluka_id', 'village_id'];

/**
 * Verify that a state -> district -> taluka -> village chain actually nests.
 *
 * The FKs guarantee each id exists but not that they belong together, so a
 * district from one state paired with a taluka from another would be accepted by
 * the database and would then place the institution somewhere that does not
 * exist. The check runs over the MERGED row (patch over current), because an
 * edit that changes only district_id still has to nest inside the state already
 * stored.
 *
 * @returns {Promise<string|null>} an error code, or null when the chain nests.
 */
async function geographyProblem(client, merged) {
  const { state_id: st, district_id: di, taluka_id: ta, village_id: vi } = merged;
  const r = await client.query(
    `SELECT (SELECT 1           FROM states    WHERE id = $1::int) AS state_exists,
            (SELECT state_id    FROM districts WHERE id = $2::int) AS district_state,
            (SELECT district_id FROM talukas   WHERE id = $3::int) AS taluka_district,
            (SELECT taluka_id   FROM villages  WHERE id = $4::int) AS village_taluka`,
    [st, di, ta ?? null, vi ?? null],
  );
  const g = r.rows[0];
  if (!g.state_exists) return 'unknown_state';
  if (g.district_state === null) return 'unknown_district';
  if (g.district_state !== st) return 'district_not_in_state';
  if (ta != null) {
    if (g.taluka_district === null) return 'unknown_taluka';
    if (g.taluka_district !== di) return 'taluka_not_in_district';
  }
  if (vi != null) {
    if (g.village_taluka === null) return 'unknown_village';
    if (ta != null && g.village_taluka !== ta) return 'village_not_in_taluka';
  }
  return null;
}

router.put('/:id', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const { reason: rawReason, ...patch } = parsed.data;
  const fields = Object.entries(patch);
  if (fields.length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  // Read the current row first: it supplies the 404, the `kind` needed for the
  // blood-bank licence invariant, the geography to merge the patch onto, and the
  // created_at that makes a licence-expiry rejection actionable.
  const current = await pool.query(
    `SELECT id, kind, created_at, onboarding_status,
            state_id, district_id, taluka_id, village_id,
            cdsco_licence_number, cdsco_licence_expires
       FROM institutions WHERE id = $1`,
    [req.params.id],
  );
  if (current.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  const row = current.rows[0];

  // This gate cannot be a middleware: whether a reason is required depends on
  // which fields this particular body touches, which is only known after parsing.
  const critical = fields.map(([k]) => k).filter((k) => CRITICAL_FIELDS.has(k));
  let changeReason = null;
  if (critical.length > 0) {
    const v = validateReason(rawReason, { min: 10 });
    if (!v.ok) {
      const { ok, reason, ...body } = v; // eslint-disable-line no-unused-vars
      return res.status(400).json({ ...body, critical_fields: critical });
    }
    changeReason = v.reason;
  }

  if (fields.some(([k]) => GEOGRAPHY_FIELDS.includes(k))) {
    const problem = await geographyProblem(pool, { ...row, ...patch });
    if (problem) return res.status(400).json({ error: problem });
  }

  // Refuse to strip a blood bank's licence here rather than surfacing the
  // bb_requires_cdsco CHECK as a raw 23514 — a caller cannot act on a
  // constraint name.
  if (row.kind === 'BB') {
    const merged = { ...row, ...patch };
    if (!merged.cdsco_licence_number || !merged.cdsco_licence_expires) {
      return res.status(409).json({ error: 'blood_bank_requires_licence' });
    }
  }

  const setSql = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = [req.params.id, ...fields.map(([, v]) => v)];

  let r;
  try {
    r = await withRlsContext(
      req,
      // setSql is built from the Zod-validated `patch` object — every `<col>`
      // is one of the schema's whitelisted keys. All values are parameterised.
      // eslint-disable-next-line no-restricted-syntax
      (c) => c.query(`UPDATE institutions SET ${setSql} WHERE id = $1 RETURNING id`, values),
      {
        // fn_audit_generic writes one audit row per changed field and stamps
        // every one with this text, so the operator's words land against each
        // field they actually changed. A routine edit records the field list
        // instead, which keeps the row attributable without pretending someone
        // wrote a justification.
        change_reason: changeReason
          ? `update institution: ${changeReason}`
          : `update institution (routine): ${fields.map(([k]) => k).join(', ')}`,
      },
    );
  } catch (err) {
    if (err.code === '23514') {
      const c = err.constraint || err.message || '';
      if (/licence_not_expired/.test(c)) {
        // CHECK (cdsco_licence_expires IS NULL OR cdsco_licence_expires >
        // created_at::date). Recording a renewal is fine; back-dating an expiry
        // to before the record itself existed is what this catches.
        return res.status(409).json({
          error: 'licence_expiry_before_institution_created',
          institution_created_at: row.created_at,
        });
      }
      if (/bb_requires_cdsco/.test(c)) {
        return res.status(409).json({ error: 'blood_bank_requires_licence' });
      }
      return res
        .status(400)
        .json({ error: 'check_violation', constraint: err.constraint || 'unknown' });
    }
    throw err;
  }
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({
    status: 'updated',
    institution_id: r.rows[0].id,
    fields_updated: fields.map(([k]) => k),
    reason_recorded: Boolean(changeReason),
  });
});

// ── Lifecycle ─────────────────────────────────────────────────
//
// SU (suspended) and AR (archived) both stop sign-in — fn_institutions_touch()
// mirrors either onto is_active = FALSE — and both are reversible. The
// difference is intent: SU is "stop, we are dealing with something"; AR is "this
// is not a participating institution any more". Neither deletes anything.
//
// No archived_at / archived_by columns: audit_log already records the actor, the
// timestamp and the reason field-by-field for institutions, so a second copy
// would only be a second thing to keep true.

/**
 * An institution together with any child it governs (its in-house blood bank).
 *
 * Lifecycle changes act on the family, not the row: a hospital cannot be
 * archived while the blood bank inside it stays open for business.
 */
async function institutionFamily(client, id) {
  const r = await client.query(
    `SELECT id, kind, shortname, onboarding_status, parent_institution_id
       FROM institutions
      WHERE id = $1 OR parent_institution_id = $1
      ORDER BY (parent_institution_id IS NOT NULL), kind`,
    [id],
  );
  const self = r.rows.find((x) => x.id === id) || null;
  return { self, children: r.rows.filter((x) => x.id !== id), ids: r.rows.map((x) => x.id) };
}

router.post(
  '/:id/suspend',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  requireReason({ min: 10 }),
  async (req, res) => {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE institutions
              SET onboarding_status = 'SU',
                  suspended_at = clock_timestamp(),
                  suspension_reason = $2
            WHERE id = $1 AND onboarding_status NOT IN ('SU','AR')
        RETURNING id`,
          [req.params.id, req.changeReason],
        ),
      { change_reason: `suspend institution: ${req.changeReason}` },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_already_suspended' });
    res.json({ status: 'suspended', institution_id: r.rows[0].id });
  },
);

// Suspension deliberately does NOT cascade to a child blood bank, and neither
// does lifting it. A hospital and the blood bank inside it hold separate
// licences and can be stopped for separate reasons; blanket-reactivating a BB
// that was suspended for a lapsed CDSCO licence because the hospital's unrelated
// problem was resolved is exactly the mistake this asymmetry prevents. Archive
// is the one action that moves the whole family, because "no longer a
// participating institution" cannot be true of a hospital and false of the blood
// bank inside it.
router.post(
  '/:id/unsuspend',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  requireReason({ min: 10 }),
  async (req, res) => {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE institutions
              SET onboarding_status = 'AC',
                  suspended_at = NULL,
                  suspension_reason = NULL
            WHERE id = $1 AND onboarding_status = 'SU'
        RETURNING id, shortname`,
          [req.params.id],
        ),
      // fn_institutions_touch() mirrors AC back onto is_active = TRUE, so there
      // is no manual flag write here.
      { change_reason: `un-suspend institution: ${req.changeReason}` },
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'not_found_or_not_suspended' });
    res.json({ status: 'active', institution_id: r.rows[0].id });
  },
);

/**
 * Work that would be orphaned by archiving this family.
 *
 * Archiving a hospital mid-transfusion must not be possible, so the check is on
 * live obligations rather than on history: requests that have not reached a
 * terminal status (CL / CA / EX), and bags this blood bank has committed to
 * someone — RE reserved, IS issued, RV received. Bags still AV are stock, not an
 * obligation, and are allowed to expire in place.
 */
async function archiveBlockers(client, ids) {
  const r = await client.query(
    `SELECT (SELECT COUNT(*)::int
               FROM blood_requests
              WHERE (requesting_institution_id = ANY($1::uuid[])
                     OR matched_blood_bank_id = ANY($1::uuid[]))
                AND status NOT IN ('CL','CA','EX'))            AS open_requests,
            (SELECT COUNT(*)::int
               FROM blood_inventory
              WHERE blood_bank_id = ANY($1::uuid[])
                AND status IN ('RE','IS','RV'))                AS committed_bags`,
    [ids],
  );
  return r.rows[0];
}

// Archive is super_admin only. Suspension is an operational call an NGO admin
// makes; taking an institution off the platform is not.
router.post(
  '/:id/archive',
  verifyJWT,
  requireRole('super_admin'),
  requireReason({ min: 20 }),
  async (req, res) => {
    const fam = await institutionFamily(pool, req.params.id);
    if (!fam.self) return res.status(404).json({ error: 'not_found' });
    if (fam.self.onboarding_status === 'AR') {
      return res.status(409).json({ error: 'already_archived' });
    }

    const blockers = await archiveBlockers(pool, fam.ids);
    if (blockers.open_requests > 0 || blockers.committed_bags > 0) {
      return res.status(409).json({
        error: 'institution_has_live_work',
        open_requests: blockers.open_requests,
        committed_bags: blockers.committed_bags,
        next_step:
          'Close, cancel or re-route the open requests and return or write off the committed bags first. Suspend the institution meanwhile if it must stop taking new work.',
      });
    }

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE institutions
              SET onboarding_status = 'AR',
                  suspended_at = COALESCE(suspended_at, clock_timestamp()),
                  suspension_reason = $2
            WHERE id = ANY($1::uuid[]) AND onboarding_status <> 'AR'
        RETURNING id, kind, shortname`,
          [fam.ids, req.changeReason],
        ),
      { change_reason: `archive institution: ${req.changeReason}` },
    );

    res.json({
      status: 'archived',
      institution_id: fam.self.id,
      archived: r.rows,
      cascaded_to_children: r.rows.filter((x) => x.id !== fam.self.id).map((x) => x.shortname),
      note: 'Nothing was deleted. Staff logins are refused at sign-in while the institution is not active; un-archive restores it to suspended.',
    });
  },
);

// AR -> SU rather than straight to AC: coming back requires a deliberate
// un-suspend, which is where licence validity gets looked at again. Restoring an
// institution to "active" in one click would skip that.
router.post(
  '/:id/unarchive',
  verifyJWT,
  requireRole('super_admin'),
  requireReason({ min: 10 }),
  async (req, res) => {
    const fam = await institutionFamily(pool, req.params.id);
    if (!fam.self) return res.status(404).json({ error: 'not_found' });
    if (fam.self.onboarding_status !== 'AR') {
      return res.status(409).json({ error: 'not_archived' });
    }

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE institutions
              SET onboarding_status = 'SU',
                  suspended_at = clock_timestamp(),
                  suspension_reason = $2
            WHERE id = ANY($1::uuid[]) AND onboarding_status = 'AR'
        RETURNING id, kind, shortname`,
          [fam.ids, `un-archived, pending re-activation: ${req.changeReason}`],
        ),
      { change_reason: `un-archive institution: ${req.changeReason}` },
    );

    res.json({
      status: 'suspended',
      institution_id: fam.self.id,
      restored: r.rows,
      next_step:
        'Re-check the licence and MoU validity, then POST /institutions/:id/unsuspend to make it active again.',
    });
  },
);

// ── GET /institutions/:id/audit ────────────────────────────────
router.get('/:id/audit', verifyJWT, async (req, res) => {
  const isAdmin = ['ngo_admin', 'super_admin'].includes(req.user.role);
  const isSelf = req.user.institutionId === req.params.id;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'forbidden' });

  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);

  // record_id is TEXT, not UUID (025_audit_log.sql) because the log spans tables
  // with different key types — hence the ::text casts rather than a UUID compare.
  //
  // updated_at is excluded. fn_audit_generic() writes one row per changed field,
  // and every UPDATE changes updated_at, so it duplicates event_time on every
  // single event — on dev it is already the most common field_name in the table.
  // Left in, it would consume the row limit and push the changes an operator is
  // actually looking for off the end of the page, which is the opposite of what a
  // history view is for. Nothing is hidden: the timestamp it carries is the
  // event_time of the row it accompanies.
  const r = await pool.query(
    `WITH fam AS (
        SELECT id FROM institutions WHERE id = $1 OR parent_institution_id = $1
      )
      SELECT a.id, a.event_time, a.event_type, a.table_name, a.record_id,
             a.field_name, a.old_value, a.new_value,
             a.actor_user_id, a.actor_role, a.change_reason,
             au.username AS actor_username,
             CASE a.table_name
               WHEN 'platform_users'
                 THEN (SELECT username  FROM platform_users WHERE id::text = a.record_id)
               WHEN 'institutions'
                 THEN (SELECT shortname FROM institutions   WHERE id::text = a.record_id)
               ELSE NULL
             END AS subject_label
        FROM audit_log_safe a
   LEFT JOIN platform_users au ON au.id = a.actor_user_id
       WHERE a.field_name IS DISTINCT FROM 'updated_at'
         AND ((a.table_name = 'institutions'
              AND a.record_id IN (SELECT id::text FROM fam))
          OR (a.table_name = 'platform_users'
              AND a.record_id IN (SELECT pu.id::text FROM platform_users pu
                                   WHERE pu.institution_id IN (SELECT id FROM fam)))
          OR (a.table_name = 'mou_versions'
              AND a.record_id IN (SELECT mv.id::text FROM mou_versions mv
                                   WHERE mv.institution_id IN (SELECT id FROM fam))))
    ORDER BY a.event_time DESC, a.id DESC
       LIMIT $2`,
    [req.params.id, limit],
  );

  const events = r.rows.map(redactAuditRow);

  res.json({
    institution_id: req.params.id,
    events,
    count: events.length,
    limit,
    // So the UI can say "showing the most recent 200" rather than implying this
    // is the whole history.
    truncated: events.length === limit,
  });
});

// ── Staff-user management ─────────────────────────────────────────────────
//
// Authorization note. `requireInstitutionUserAdmin` is the BINDING gate on who
// may provision or retire a colleague's login — not RLS. Migration 311 explains
// why: a policy that asks "is the acting user an institution admin?" must SELECT
// platform_users to answer, which recurses through the policy being evaluated.
// RLS enforces the coarser and more valuable invariant (an institution actor can
// only ever touch rows of its own institution_id); the admin/technician split
// within one institution is enforced here.
//
// Because RLS is inert at runtime today (the app connects as an owner role with
// BYPASSRLS — see the memory note), every handler below ALSO re-checks
// institution_id inside its own SQL. The path parameter is never trusted on its
// own, so a wrong :id cannot reach another hospital's rows even with RLS off.

// Which platform_users.role an institution's staff hold, from its kind. Staff
// role is per-institution, never per-person: a technician and an admin are both
// `hospital`, and the only distinction between them is is_institution_admin.
const ROLE_FOR_KIND = { HO: 'hospital', BB: 'blood_bank' };

/**
 * Resolve the acting user's authority over :id.
 *
 * Authority reaches DOWN one level and never up. A hospital with an in-house
 * blood bank is two institution rows joined by institutions.parent_institution_id
 * but one organisation with one management, so its admin governs the blood
 * bank's logins too — otherwise the pair can only be administered by asking the
 * NGO, which is not what "in-house" means. The blood bank's own admin, by
 * contrast, gets no reach into the hospital: a BB admin is frequently a
 * technician-in-charge rather than the hospital's management, and inheriting
 * upward would hand them the hospital's request-raising staff.
 *
 * @returns {Promise<{ok: true, institution: object, viaParent?: boolean}|{ok: false, status: number, error: string}>}
 */
async function resolveInstitutionAdmin(req) {
  const instR = await pool.query(
    `SELECT id, kind, shortname, display_name, legal_name,
            primary_contact_name, onboarding_status, parent_institution_id
       FROM institutions WHERE id = $1`,
    [req.params.id],
  );
  if (instR.rowCount === 0) return { ok: false, status: 404, error: 'institution_not_found' };
  const institution = instR.rows[0];

  if (['ngo_admin', 'super_admin'].includes(req.user.role)) return { ok: true, institution };

  const isSelf = req.user.institutionId === req.params.id;
  // The ONLY widening: the caller's institution is this row's parent. Compared
  // against the stored parent_institution_id, never against anything the caller
  // sent, so an unrelated institution cannot claim a parent relationship.
  const isParent =
    Boolean(institution.parent_institution_id) &&
    institution.parent_institution_id === req.user.institutionId;

  if (!isSelf && !isParent) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  // Read the flag from the row, not the JWT: a demotion must take effect on the
  // next request, not whenever the token happens to expire.
  const meR = await pool.query(`SELECT is_institution_admin FROM platform_users WHERE id = $1`, [
    req.user.userId,
  ]);
  if (meR.rowCount === 0 || !meR.rows[0].is_institution_admin) {
    return { ok: false, status: 403, error: 'not_institution_admin' };
  }
  return { ok: true, institution, viaParent: isParent };
}

function requireInstitutionUserAdmin(req, res, next) {
  resolveInstitutionAdmin(req)
    .then((r) => {
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      req.institution = r.institution;
      return next();
    })
    .catch(next);
}

/**
 * Load one staff row, scoped to the institution in the path.
 *
 * The `institution_id = $2` predicate is what makes a wrong/guessed :userId
 * harmless — it can only ever resolve inside the institution the caller was
 * already authorised for.
 */
async function loadStaffUser(client, userId, institutionId) {
  const r = await client.query(
    `SELECT id, role, username, mobile, institution_id, is_institution_admin,
            is_locked, deactivated_at
       FROM platform_users
      WHERE id = $1 AND institution_id = $2 AND role IN ('hospital','blood_bank')`,
    [userId, institutionId],
  );
  return r.rows[0] || null;
}

// ── GET /institutions/:id/users ──────────────────────────────────────────
// The roster. Same `isAdmin || isSelf` shape as GET /:id above — every member of
// an institution may see who their colleagues are and whether an account is
// stuck; only an institution admin may act on it.
async function loadRoster(req, institutionId) {
  const r = await withRlsContext(req, (c) =>
    c.query(
      // ROSTER_COLUMNS is a module constant (services/users/directory.js), not
      // request input. Both values are parameterised.
      // eslint-disable-next-line no-restricted-syntax
      `SELECT ${ROSTER_COLUMNS},
              db.username AS deactivated_by_username
         FROM platform_users pu
    LEFT JOIN platform_users db ON db.id = pu.deactivated_by
        WHERE pu.institution_id = $1
          AND pu.role IN ('hospital','blood_bank')
        ORDER BY pu.is_institution_admin DESC, pu.username ASC`,
      [institutionId],
    ),
  );
  const now = new Date();
  return r.rows.map((row) => toRosterRow(row, now));
}

async function rosterHandler(req, res, institutionId) {
  const isAdmin = ['ngo_admin', 'super_admin'].includes(req.user.role);
  const isSelf = req.user.institutionId === institutionId;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'forbidden' });

  const users = await loadRoster(req, institutionId);
  const canManage =
    isAdmin || Boolean(users.find((u) => u.id === req.user.userId)?.is_institution_admin);

  // A hospital with an in-house blood bank is one organisation, so its Team tab
  // shows both rosters rather than making its admin hunt for a second portal it
  // has no URL for. Authority flows down only: each child carries the PARENT's
  // can_manage, and resolveInstitutionAdmin enforces the same direction on every
  // write. A blood bank asking for its own roster gets no children — it has none.
  const childR = await pool.query(
    `SELECT id, kind, shortname, display_name, onboarding_status
       FROM institutions
      WHERE parent_institution_id = $1
      ORDER BY kind, shortname`,
    [institutionId],
  );
  const children = [];
  for (const child of childR.rows) {
    const childUsers = await loadRoster(req, child.id);
    children.push({
      institution_id: child.id,
      kind: child.kind,
      shortname: child.shortname,
      display_name: child.display_name,
      onboarding_status: child.onboarding_status,
      users: childUsers,
      count: childUsers.length,
      can_manage: canManage,
    });
  }

  return res.json({
    institution_id: institutionId,
    users,
    count: users.length,
    // Lets the Team panel render read-only for a technician without a second
    // round-trip, and without the client inferring authority from its own JWT.
    can_manage: canManage,
    children,
  });
}

// Addressed by session rather than by id. A staff portal never learns its own
// institution UUID — the JWT carries it but the client only persists token,
// role and user_id — so without this the Team panel would need a lookup round
// trip purely to build the URL. Declared before '/:id/users' so 'me' is never
// parsed as a UUID.
router.get('/me/users', verifyJWT, async (req, res) => {
  if (!req.user.institutionId) {
    return res.status(400).json({ error: 'session_has_no_institution' });
  }
  return rosterHandler(req, res, req.user.institutionId);
});

router.get('/:id/users', verifyJWT, async (req, res) => rosterHandler(req, res, req.params.id));

// ── POST /institutions/:id/users ─────────────────────────────────────────
// Invite a colleague. Creates the login and issues a magic-link setup token —
// no password is ever chosen by the inviter or transits the wire, matching the
// activation path (services/onboarding/activate.js).
const inviteSchema = z
  .object({
    // Full username, when the institution wants to name it themselves.
    username: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{2,31}$/)
      .optional(),
    // Or just the person/desk part — `<shortname>_<suffix>` is derived.
    username_suffix: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,19}$/)
      .optional(),
    mobile: z.string(),
    is_institution_admin: z.boolean().optional(),
  })
  .strict();

/**
 * Pick a free username.
 *
 * The CHECK is `^[a-z][a-z0-9_-]{2,31}$`, so the shortname half is trimmed to
 * whatever room the suffix leaves rather than producing a name the constraint
 * would reject. Collisions get a numeric tail; after 50 tries we give up rather
 * than loop, which in practice means the caller should pass an explicit
 * `username`.
 */
async function deriveUsername(client, shortname, suffix) {
  const tail = suffix || 'user';
  const room = Math.max(2, 31 - tail.length - 1 - 2); // -1 for '_', -2 for a tail number
  const stem = `${String(shortname).slice(0, room)}_${tail}`;
  for (let n = 0; n < 50; n += 1) {
    const candidate = n === 0 ? stem : `${stem}${n + 1}`;
    if (!/^[a-z][a-z0-9_-]{2,31}$/.test(candidate)) continue;
    const taken = await client.query(`SELECT 1 FROM platform_users WHERE username = $1`, [
      candidate,
    ]);
    if (taken.rowCount === 0) return candidate;
  }
  return null;
}

router.post('/:id/users', verifyJWT, requireInstitutionUserAdmin, async (req, res) => {
  const parsed = inviteSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const inst = req.institution;
  const role = ROLE_FOR_KIND[inst.kind];
  if (!role) return res.status(400).json({ error: 'institution_kind_has_no_staff_role' });
  if (inst.onboarding_status !== 'AC') {
    // A login for a non-active institution is refused at sign-in anyway
    // (403 institution_not_active) — better to say so now than mint a dead one.
    return res.status(409).json({ error: 'institution_not_active' });
  }

  // A mobile is mandatory: it is the SETUP_LINK delivery target, and an invite
  // with nowhere to send the link is the exact failure this whole change exists
  // to fix. (The BB admin minted at activation is the one deliberate exception —
  // its link is surfaced on the hospital dashboard instead.)
  const mobile = normaliseIndianMobile(parsed.data.mobile);
  if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

  try {
    const created = await withRlsContext(
      req,
      async (c) => {
        const username =
          parsed.data.username ||
          (await deriveUsername(c, inst.shortname, parsed.data.username_suffix));
        if (!username) {
          const e = new Error('username_unavailable');
          e.httpStatus = 409;
          throw e;
        }

        const placeholderHash = await setupSvc.unusablePasswordHash();
        const r = await c.query(
          `INSERT INTO platform_users
             (role, username, mobile, password_hash, password_set_at,
              force_password_change, institution_id, is_institution_admin)
           VALUES ($1, $2, $3, $4, NOW(), TRUE, $5, $6)
           RETURNING id`,
          [
            role,
            username,
            mobile,
            placeholderHash,
            inst.id,
            parsed.data.is_institution_admin ?? false,
          ],
        );
        const userId = r.rows[0].id;
        const { token, expiresAt } = await setupSvc.generateSetupToken(c, userId);
        return { userId, username, token, expiresAt };
      },
      { change_reason: 'invite institution staff user' },
    );

    const wa = await trySendSetupLink({
      mobile,
      recipientName: created.username,
      institutionName: inst.display_name || inst.shortname,
      token: created.token,
      event: 'institution_staff_invite',
      ref: created.username,
    });

    return res.status(201).json({
      status: 'invited',
      user_id: created.userId,
      username: created.username,
      role,
      institution_id: inst.id,
      is_institution_admin: parsed.data.is_institution_admin ?? false,
      setup_url: `${env.frontendUrl}/setup/${created.token}`,
      setup_expires_at: created.expiresAt,
      whatsapp_sent: wa,
      next_step: wa
        ? `Setup link sent to ${mobile}. They set a password, then sign in at /staff/login as "${created.username}".`
        : `Account created but the WhatsApp did NOT send — share the setup link out-of-band. It is shown once; re-issue from the roster if it is lost.`,
    });
  } catch (err) {
    if (err.httpStatus === 409) return res.status(409).json({ error: err.message });
    if (/idx_platform_users_username/.test(err.message)) {
      return res.status(409).json({ error: 'username_taken' });
    }
    if (/idx_platform_users_mobile_staff_cluster/.test(err.message)) {
      // Migration 269: one mobile, one staff account — otherwise a SETUP_LINK
      // template would point at an ambiguous inbox.
      return res.status(409).json({ error: 'mobile_already_in_staff_cluster' });
    }
    if (err.code === '23514') {
      return res
        .status(400)
        .json({ error: 'check_violation', constraint: err.constraint || 'unknown' });
    }
    logger.error(
      { event: 'institution_staff_invite_failed', err: err.message, code: err.code },
      'institution staff invite failed',
    );
    return res.status(500).json({ error: 'invite_failed' });
  }
});

/**
 * Best-effort SETUP_LINK send that reports its OUTCOME.
 *
 * The notification chokepoint returns `success:false` WITHOUT throwing when a
 * WHATSAPP_TEMPLATE_* env var is unset, so a bare try/catch would report a
 * delivered link that never left the building. Callers use the returned boolean
 * to decide what to tell the operator.
 */
async function trySendSetupLink({ mobile, recipientName, institutionName, token, event, ref }) {
  try {
    const r = await sendNotification({
      recipientId: mobile,
      templateType: 'SETUP_LINK',
      variables: {
        signatory_name: recipientName,
        institution_name: institutionName,
        setup_token: token,
      },
      channel: 'WA',
      language: 'en',
    });
    if (r?.success) return true;
    logger.warn({ event: `${event}_unsent`, ref, result: r }, 'SETUP_LINK did not send');
    return false;
  } catch (err) {
    logger.error({ event: `${event}_failed`, ref, err: err.message }, 'SETUP_LINK threw');
    return false;
  }
}

// ── POST /institutions/:id/users/:userId/reissue-setup ───────────────────
// The recovery action. Wipes the password back to an unusable placeholder and
// mints a fresh single-use link — the same primitives as activation, so there is
// no second way for a staff password to be set.
//
// Re-issuing INVALIDATES any outstanding link (generateSetupToken overwrites the
// stored hash), which is what makes this safe to click when nobody is sure where
// the previous one went.
router.post(
  '/:id/users/:userId/reissue-setup',
  verifyJWT,
  requireInstitutionUserAdmin,
  async (req, res) => {
    const inst = req.institution;
    const target = await loadStaffUser(pool, req.params.userId, inst.id);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (target.deactivated_at) return res.status(409).json({ error: 'user_deactivated' });

    // Optional: point the link at a new number in the same call, for the
    // officer-turnover case where the account outlives the person.
    const schema = z.object({ mobile: z.string().optional() }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

    let mobile = target.mobile;
    if (parsed.data.mobile) {
      mobile = normaliseIndianMobile(parsed.data.mobile);
      if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });
    }
    if (!mobile) return res.status(400).json({ error: 'no_mobile_on_file' });

    let issued;
    try {
      issued = await withRlsContext(
        req,
        async (c) => {
          await c.query(
            `UPDATE platform_users
                SET password_hash = $1, password_set_at = NOW(),
                    force_password_change = TRUE,
                    is_locked = FALSE, locked_until = NULL, failed_login_attempts = 0,
                    mobile = $2
              WHERE id = $3 AND institution_id = $4`,
            [await setupSvc.unusablePasswordHash(), mobile, target.id, inst.id],
          );
          return setupSvc.generateSetupToken(c, target.id);
        },
        { change_reason: 'reissue staff setup link' },
      );
    } catch (err) {
      if (/idx_platform_users_mobile_staff_cluster/.test(err.message)) {
        return res.status(409).json({ error: 'mobile_already_in_staff_cluster' });
      }
      throw err;
    }

    const wa = await trySendSetupLink({
      mobile,
      recipientName: target.username,
      institutionName: inst.display_name || inst.shortname,
      token: issued.token,
      event: 'institution_staff_reissue',
      ref: target.username,
    });

    res.json({
      status: wa ? 'setup_link_sent' : 'setup_link_issued_not_sent',
      user_id: target.id,
      username: target.username,
      setup_url: `${env.frontendUrl}/setup/${issued.token}`,
      setup_expires_at: issued.expiresAt,
      whatsapp_sent: wa,
      next_step: wa
        ? `Setup link sent to ${mobile}. Any previous link no longer works.`
        : `Link issued but the WhatsApp did NOT send — the previous password and any previous link no longer work, so share this URL out-of-band.`,
    });
  },
);

// ── POST /institutions/:id/users/:userId/deactivate ──────────────────────
// Soft only. The row stays — donation_history, donor_screening.entered_by /
// verified_by, bag_events and audit_log all hold FKs to it, and a life-critical
// audit trail that cannot resolve who performed a screening is worse than a
// stale login. POST /auth/institutional/login refuses `deactivated_at IS NOT
// NULL` with 403 account_deactivated.
router.post(
  '/:id/users/:userId/deactivate',
  verifyJWT,
  requireInstitutionUserAdmin,
  // Retiring a colleague's login is the staff-side equivalent of archiving an
  // institution, and the reason is the only record of why the person lost
  // access. It used to be optional, which meant it was usually absent.
  requireReason({ min: 10 }),
  async (req, res) => {
    const inst = req.institution;
    const target = await loadStaffUser(pool, req.params.userId, inst.id);
    if (!target) return res.status(404).json({ error: 'user_not_found' });
    if (target.deactivated_at) return res.status(409).json({ error: 'already_deactivated' });

    // Locking yourself out mid-shift is never the intent, and it would leave the
    // institution needing an NGO admin to undo it.
    if (target.id === req.user.userId) {
      return res.status(409).json({ error: 'cannot_deactivate_self' });
    }

    // An institution with no admin left cannot invite, unlock or re-issue for
    // itself — it becomes an NGO support ticket. Refuse rather than create one.
    if (target.is_institution_admin) {
      const others = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM platform_users
          WHERE institution_id = $1
            AND is_institution_admin = TRUE
            AND deactivated_at IS NULL
            AND id <> $2`,
        [inst.id, target.id],
      );
      if (others.rows[0].n === 0) {
        return res.status(409).json({ error: 'cannot_deactivate_last_institution_admin' });
      }
    }

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE platform_users
              SET deactivated_at = clock_timestamp(),
                  deactivated_by = $1,
                  deactivation_reason = $2
            WHERE id = $3 AND institution_id = $4 AND deactivated_at IS NULL
        RETURNING id, username, deactivated_at`,
          [req.user.userId, req.changeReason, target.id, inst.id],
        ),
      { change_reason: `deactivate staff user: ${req.changeReason}` },
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'already_deactivated' });
    res.json({ status: 'deactivated', ...r.rows[0] });
  },
);

// ── POST /institutions/:id/users/:userId/reactivate ──────────────────────
// Clears all three deactivation columns together — the
// `deactivation_consistency` CHECK (migration 311) rejects a partial clear, and
// leaving a stale reason on a live account would misreport it in the roster.
//
// Reactivation deliberately does NOT restore a password: the account has been
// dormant, so the operator re-issues a setup link afterwards. The roster shows
// the resulting state (setup_pending / setup_expired) so the second step is
// visible rather than assumed.
router.post(
  '/:id/users/:userId/reactivate',
  verifyJWT,
  requireInstitutionUserAdmin,
  async (req, res) => {
    const inst = req.institution;
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE platform_users
              SET deactivated_at = NULL,
                  deactivated_by = NULL,
                  deactivation_reason = NULL
            WHERE id = $1 AND institution_id = $2
              AND role IN ('hospital','blood_bank')
              AND deactivated_at IS NOT NULL
        RETURNING id, username`,
          [req.params.userId, inst.id],
        ),
      { change_reason: 'reactivate staff user' },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_not_deactivated' });
    res.json({ status: 'reactivated', ...r.rows[0] });
  },
);

// ── POST /institutions/:id/users/:userId/unlock ──────────────────────────
// Clears the 5-failed-attempt lockout (migration 296) without touching the
// password — for the ordinary case of a colleague who mistyped, where waiting
// out locked_until is the only alternative.
router.post(
  '/:id/users/:userId/unlock',
  verifyJWT,
  requireInstitutionUserAdmin,
  async (req, res) => {
    const inst = req.institution;
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE platform_users
              SET is_locked = FALSE, locked_until = NULL, failed_login_attempts = 0
            WHERE id = $1 AND institution_id = $2
              AND role IN ('hospital','blood_bank')
        RETURNING id, username`,
          [req.params.userId, inst.id],
        ),
      { change_reason: 'unlock staff user' },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    res.json({ status: 'unlocked', ...r.rows[0] });
  },
);

// ── POST /institutions/:id/users/:userId/admin-flag ─────────────
// Promote or demote an institution admin. Until now the flag could only be set
// at invite time, so the only way to hand over administration was to invite a
// second account and retire the first — which is how institutions end up with
// orphaned logins nobody can explain.
//
// is_institution_admin is what requireInstitutionUserAdmin gates on, and (for a
// hospital with an in-house blood bank) it decides authority over a second
// institution's logins, so a written reason is required in both directions.
router.post(
  '/:id/users/:userId/admin-flag',
  verifyJWT,
  requireInstitutionUserAdmin,
  requireReason({ min: 10 }),
  async (req, res) => {
    const schema = z.object({ is_institution_admin: z.boolean() }).strip();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const grant = parsed.data.is_institution_admin;

    const inst = req.institution;
    const target = await loadStaffUser(pool, req.params.userId, inst.id);
    if (!target) return res.status(404).json({ error: 'user_not_found' });

    // Promoting a retired login would create an admin who cannot sign in, and
    // demoting one changes nothing anybody can observe.
    if (target.deactivated_at) return res.status(409).json({ error: 'user_deactivated' });
    if (target.is_institution_admin === grant) {
      return res.status(409).json({ error: grant ? 'already_admin' : 'already_not_admin' });
    }

    // Same reasoning as deactivate: an institution with no admin left cannot
    // invite, unlock or re-issue for itself and becomes an NGO support ticket.
    if (!grant) {
      const others = await pool.query(
        `SELECT COUNT(*)::int AS n
           FROM platform_users
          WHERE institution_id = $1
            AND is_institution_admin = TRUE
            AND deactivated_at IS NULL
            AND id <> $2`,
        [inst.id, target.id],
      );
      if (others.rows[0].n === 0) {
        return res.status(409).json({ error: 'cannot_demote_last_institution_admin' });
      }
    }

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE platform_users
              SET is_institution_admin = $1
            WHERE id = $2 AND institution_id = $3
              AND role IN ('hospital','blood_bank')
              AND deactivated_at IS NULL
        RETURNING id, username, is_institution_admin`,
          [grant, target.id, inst.id],
        ),
      {
        change_reason: `${grant ? 'promote to' : 'demote from'} institution admin: ${
          req.changeReason
        }`,
      },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    res.json({ status: grant ? 'promoted' : 'demoted', ...r.rows[0] });
  },
);

module.exports = router;
