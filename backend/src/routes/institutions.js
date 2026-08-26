/**
 * Institution management.
 *
 *   GET  /institutions             ngo_admin/super_admin → list
 *   GET  /institutions/:id         ngo_admin or self     → details
 *   PUT  /institutions/:id         ngo_admin             → update whitelist
 *   POST /institutions/:id/suspend ngo_admin             → suspend
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
 */
const express = require('express');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContext } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { normaliseIndianMobile } = require('../utils/phone');
const { sendNotification } = require('../services/notifications');
const setupSvc = require('../services/users/setup');
const { ROSTER_COLUMNS, toRosterRow } = require('../services/users/directory');

const router = express.Router();

router.get('/', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const status = req.query.status;
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT id, kind, shortname, legal_name, district_id, onboarding_status,
                onboarded_at, mou_expires_at, is_active
           FROM institutions
          WHERE ($1::text IS NULL OR onboarding_status = $1)
          ORDER BY onboarded_at DESC NULLS LAST, onboarding_started_at DESC
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
      `SELECT id, kind, shortname, legal_name, display_name,
              state_id, district_id, taluka_id, village_id,
              address_line, pincode, latitude, longitude,
              cdsco_licence_number, cdsco_licence_expires, hospital_registration_no,
              license_verified_at, primary_contact_name, primary_contact_designation,
              primary_contact_mobile, primary_contact_email,
              onboarding_status, onboarding_started_at, onboarded_at,
              suspended_at, suspension_reason,
              mou_signed_at, mou_expires_at, mou_signatory_name,
              has_inhouse_blood_bank, is_blood_bank_software_user, software_vendor,
              is_active, created_at, updated_at
         FROM institutions WHERE id = $1`,
      [req.params.id],
    ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

const updateSchema = z
  .object({
    display_name: z.string().min(2).optional(),
    address_line: z.string().min(5).optional(),
    pincode: z
      .string()
      .regex(/^[1-9]\d{5}$/)
      .optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    primary_contact_name: z.string().min(2).optional(),
    primary_contact_designation: z.string().optional(),
    primary_contact_mobile: z.string().optional(),
    primary_contact_email: z.string().email().optional(),
    has_inhouse_blood_bank: z.boolean().optional(),
    is_blood_bank_software_user: z.boolean().optional(),
    software_vendor: z.string().optional(),
  })
  .strict();

router.put('/:id', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const fields = Object.entries(parsed.data);
  if (fields.length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  const setSql = fields.map(([k], i) => `${k} = $${i + 2}`).join(', ');
  const values = [req.params.id, ...fields.map(([, v]) => v)];

  const r = await withRlsContext(
    req,
    // setSql is built from the Zod-validated `fields` object — every `<col>`
    // is one of the schema's whitelisted keys. All values are parameterised.
    // eslint-disable-next-line no-restricted-syntax
    (c) => c.query(`UPDATE institutions SET ${setSql} WHERE id = $1 RETURNING id`, values),
    { change_reason: 'admin update institution' },
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ status: 'updated', institution_id: r.rows[0].id });
});

router.post(
  '/:id/suspend',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const schema = z.object({ reason: z.string().min(5) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

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
          [req.params.id, parsed.data.reason],
        ),
      { change_reason: `admin suspend: ${parsed.data.reason}` },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_already_suspended' });
    res.json({ status: 'suspended', institution_id: r.rows[0].id });
  },
);

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
 * @returns {Promise<{ok: true, institution: object}|{ok: false, status: number, error: string}>}
 */
async function resolveInstitutionAdmin(req) {
  const instR = await pool.query(
    `SELECT id, kind, shortname, display_name, legal_name,
            primary_contact_name, onboarding_status
       FROM institutions WHERE id = $1`,
    [req.params.id],
  );
  if (instR.rowCount === 0) return { ok: false, status: 404, error: 'institution_not_found' };
  const institution = instR.rows[0];

  if (['ngo_admin', 'super_admin'].includes(req.user.role)) return { ok: true, institution };

  if (req.user.institutionId !== req.params.id) {
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
  return { ok: true, institution };
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
async function rosterHandler(req, res, institutionId) {
  const isAdmin = ['ngo_admin', 'super_admin'].includes(req.user.role);
  const isSelf = req.user.institutionId === institutionId;
  if (!isAdmin && !isSelf) return res.status(403).json({ error: 'forbidden' });

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
  const users = r.rows.map((row) => toRosterRow(row, now));
  return res.json({
    institution_id: institutionId,
    users,
    count: users.length,
    // Lets the Team panel render read-only for a technician without a second
    // round-trip, and without the client inferring authority from its own JWT.
    can_manage:
      isAdmin || Boolean(users.find((u) => u.id === req.user.userId)?.is_institution_admin),
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
  async (req, res) => {
    const schema = z.object({ reason: z.string().min(3).max(500).optional() }).strict();
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

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
          [req.user.userId, parsed.data.reason || null, target.id, inst.id],
        ),
      { change_reason: `deactivate staff user: ${parsed.data.reason || 'no reason given'}` },
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

module.exports = router;
