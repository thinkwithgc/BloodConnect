/**
 * Institution onboarding flow.
 *
 *   POST /onboarding/apply              — public; creates institution row(s) in PE.
 *                                          For kind='HO' + has_inhouse_blood_bank=true,
 *                                          also creates a child BB row linked via
 *                                          parent_institution_id.
 *   GET  /onboarding/applications       — ngo_admin; paginated queue (parents only —
 *                                          children reachable via detail view).
 *   GET  /onboarding/applications/:id   — ngo_admin; full detail incl. joined geo
 *                                          names and any child rows.
 *   POST /onboarding/verify/:id         — ngo_admin; PE → VE for parent AND any
 *                                          child rows in one shot.
 *   POST /onboarding/:id/mou-scan       — ngo_admin; raw upload of a scan of the
 *                                          signed paper MoU. Returns a storage key
 *                                          + sha256 for /activate. Optional.
 *   POST /onboarding/activate/:id       — ngo_admin; VE → AC. Records the offline
 *                                          paper MoU, flips parent + any children
 *                                          to AC, provisions the HO admin (+ BB
 *                                          admin for paired applications) and
 *                                          WhatsApps the HO setup link.
 *
 * MoU SIGNING IS OFFLINE ON PAPER. The Aadhaar-eSign round-trip that used to
 * gate activation (POST /generate-mou/:id → Leegality → POST /mou-signed
 * webhook) was removed: Leegality was never provisioned, so onboarding was
 * blocked end-to-end. The NGO admin now reviews the application, verifies
 * licences, collects a physically-signed MoU, and records it via /activate.
 *
 * services/esign and the LEEGALITY_* env block are left on disk but referenced
 * by nothing — see services/onboarding/activate.js, which takes a `signingMode`
 * so eSign can be re-enabled as an additional caller rather than a rewrite.
 */
const express = require('express');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContext, withRlsContextRaw } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { normaliseIndianMobile } = require('../utils/phone');
const storage = require('../services/storage');
const { sendNotification } = require('../services/notifications');
const { activateInstitution, sha256Hex } = require('../services/onboarding/activate');

const router = express.Router();

// ── Schema ──────────────────────────────────────────────────────────────────
// Conditional required-ness handled in `.superRefine` because Zod's static
// shape can't express "field X is required when field Y takes value Z". The
// backend layer is authoritative — the frontend mirrors this shape for a
// snappy UX but re-validation here is what actually matters.
const applySchema = z
  .object({
    kind: z.enum(['HO', 'BB']),
    shortname: z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/),
    legal_name: z.string().min(2),
    display_name: z.string().min(2),
    state_id: z.number().int().positive(),
    district_id: z.number().int().positive(),
    taluka_id: z.number().int().positive().optional(),
    village_id: z.number().int().positive().optional(),
    address_line: z.string().min(5),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    cdsco_licence_number: z.string().optional(),
    cdsco_licence_expires: z.string().optional(), // YYYY-MM-DD
    hospital_registration_no: z.string().optional(),
    primary_contact_name: z.string().min(2),
    primary_contact_designation: z.string().optional(),
    primary_contact_mobile: z.string(),
    primary_contact_email: z.string().email().optional(),
    has_inhouse_blood_bank: z.boolean().optional(),
    is_blood_bank_software_user: z.boolean().optional(),
    software_vendor: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // Standalone blood bank needs CDSCO fields directly.
    if (data.kind === 'BB') {
      if (!data.cdsco_licence_number) {
        ctx.addIssue({
          path: ['cdsco_licence_number'],
          code: z.ZodIssueCode.custom,
          message: 'cdsco_licence_required_for_blood_bank',
        });
      }
      if (!data.cdsco_licence_expires) {
        ctx.addIssue({
          path: ['cdsco_licence_expires'],
          code: z.ZodIssueCode.custom,
          message: 'cdsco_licence_expiry_required_for_blood_bank',
        });
      }
    }
    // Hospital with in-house BB: CDSCO fields land on the child row, but the
    // applicant still fills them here. Shortname must leave 9 chars of budget
    // for the `-bb_admin` suffix on the BB admin username (regex caps username
    // at 32 chars; 32 - 9 = 23).
    if (data.kind === 'HO' && data.has_inhouse_blood_bank === true) {
      if (!data.cdsco_licence_number) {
        ctx.addIssue({
          path: ['cdsco_licence_number'],
          code: z.ZodIssueCode.custom,
          message: 'cdsco_licence_required_for_inhouse_bb',
        });
      }
      if (!data.cdsco_licence_expires) {
        ctx.addIssue({
          path: ['cdsco_licence_expires'],
          code: z.ZodIssueCode.custom,
          message: 'cdsco_licence_expiry_required_for_inhouse_bb',
        });
      }
      if (data.shortname.length > 23) {
        ctx.addIssue({
          path: ['shortname'],
          code: z.ZodIssueCode.custom,
          message: 'shortname_max_23_for_inhouse_bb',
        });
      }
    }
  });

function childShortname(parentShortname) {
  return `${parentShortname}-bb`;
}

// ── POST /onboarding/apply (public) ──────────────────────────────────────
router.post('/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const data = parsed.data;
  const mobile = normaliseIndianMobile(data.primary_contact_mobile);
  if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

  const createInHouseBB = data.kind === 'HO' && data.has_inhouse_blood_bank === true;

  try {
    const result = await withRlsContextRaw(
      { actor_role: 'onboarding', change_reason: 'public onboarding apply' },
      async (c) => {
        // Parent institution. For a paired HO+BB apply, CDSCO fields land on
        // the child row only — the parent HO uses hospital_registration_no
        // (or nothing if the applicant didn't supply one).
        const parentCdscoNumber = data.kind === 'BB' ? data.cdsco_licence_number : null;
        const parentCdscoExpires = data.kind === 'BB' ? data.cdsco_licence_expires : null;

        const parentR = await c.query(
          `INSERT INTO institutions (
             kind, shortname, legal_name, display_name,
             state_id, district_id, taluka_id, village_id,
             address_line, pincode, latitude, longitude,
             cdsco_licence_number, cdsco_licence_expires, hospital_registration_no,
             primary_contact_name, primary_contact_designation,
             primary_contact_mobile, primary_contact_email,
             has_inhouse_blood_bank, is_blood_bank_software_user, software_vendor,
             onboarding_status)
           VALUES (
             $1,$2,$3,$4, $5,$6,$7,$8, $9,$10,$11,$12,
             $13,$14,$15, $16,$17, $18,$19, $20,$21,$22, 'PE')
           RETURNING id, shortname`,
          [
            data.kind,
            data.shortname,
            data.legal_name,
            data.display_name,
            data.state_id,
            data.district_id,
            data.taluka_id || null,
            data.village_id || null,
            data.address_line,
            data.pincode,
            data.latitude || null,
            data.longitude || null,
            parentCdscoNumber,
            parentCdscoExpires,
            data.hospital_registration_no || null,
            data.primary_contact_name,
            data.primary_contact_designation || null,
            mobile,
            data.primary_contact_email || null,
            data.has_inhouse_blood_bank ?? false,
            data.is_blood_bank_software_user ?? false,
            data.software_vendor || null,
          ],
        );
        const parent = parentR.rows[0];

        let child = null;
        if (createInHouseBB) {
          const childR = await c.query(
            `INSERT INTO institutions (
               kind, parent_institution_id, shortname, legal_name, display_name,
               state_id, district_id, taluka_id, village_id,
               address_line, pincode, latitude, longitude,
               cdsco_licence_number, cdsco_licence_expires,
               primary_contact_name, primary_contact_designation,
               primary_contact_mobile, primary_contact_email,
               has_inhouse_blood_bank, is_blood_bank_software_user, software_vendor,
               onboarding_status)
             VALUES (
               'BB', $1, $2, $3, $4,
               $5,$6,$7,$8, $9,$10,$11,$12,
               $13,$14, $15,$16, $17,$18, FALSE, $19, $20, 'PE')
             RETURNING id, shortname`,
            [
              parent.id,
              childShortname(data.shortname),
              `${data.legal_name} (Blood Bank)`,
              `${data.display_name} Blood Bank`,
              data.state_id,
              data.district_id,
              data.taluka_id || null,
              data.village_id || null,
              data.address_line,
              data.pincode,
              data.latitude || null,
              data.longitude || null,
              data.cdsco_licence_number,
              data.cdsco_licence_expires,
              data.primary_contact_name,
              data.primary_contact_designation || null,
              mobile,
              data.primary_contact_email || null,
              data.is_blood_bank_software_user ?? false,
              data.software_vendor || null,
            ],
          );
          child = childR.rows[0];
        }
        return { parent, child };
      },
    );

    logger.info(
      {
        institution_id: result.parent.id,
        shortname: result.parent.shortname,
        child_institution_id: result.child?.id,
        child_shortname: result.child?.shortname,
      },
      'Onboarding application received',
    );

    res.status(201).json({
      institution_id: result.parent.id,
      shortname: result.parent.shortname,
      child_institution_id: result.child?.id || null,
      child_shortname: result.child?.shortname || null,
      onboarding_status: 'PE',
      next_step: createInHouseBB
        ? 'License verification (hospital + blood bank) by NGO admin.'
        : 'License verification by NGO admin.',
    });
  } catch (err) {
    if (/unique constraint/i.test(err.message) && /shortname/i.test(err.message)) {
      return res.status(409).json({ error: 'shortname_taken' });
    }
    throw err;
  }
});

// ── GET /onboarding/applications (ngo_admin) ─────────────────────────────
// Returns TOP-LEVEL rows only (parent_institution_id IS NULL). Child BB rows
// are always reached via GET /applications/:id on the parent — surfacing them
// in the list would double-count paired applications.
router.get(
  '/applications',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const status = req.query.status || 'PE';
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT id, kind, shortname, legal_name, district_id,
                primary_contact_name, primary_contact_mobile,
                onboarding_status, onboarding_started_at, license_verified_at,
                has_inhouse_blood_bank
           FROM institutions
          WHERE onboarding_status = $1
            AND parent_institution_id IS NULL
          ORDER BY onboarding_started_at DESC
          LIMIT 200`,
        [status],
      ),
    );
    res.json({ applications: r.rows, count: r.rowCount });
  },
);

// ── GET /onboarding/applications/:id (ngo_admin) ─────────────────────────
// Full submission detail — every column plus joined geography labels. Also
// hydrates any child rows (in-house BB) so the admin sees the pair on one
// screen and can verify both licences in one action.
router.get(
  '/applications/:id',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parentR = await withRlsContext(req, (c) =>
      c.query(
        `SELECT i.*,
                s.name AS state_name,
                d.name AS district_name,
                t.name AS taluka_name,
                v.name AS village_name
           FROM institutions i
           LEFT JOIN states    s ON s.id = i.state_id
           LEFT JOIN districts d ON d.id = i.district_id
           LEFT JOIN talukas   t ON t.id = i.taluka_id
           LEFT JOIN villages  v ON v.id = i.village_id
          WHERE i.id = $1`,
        [req.params.id],
      ),
    );
    if (parentR.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const parent = parentR.rows[0];

    // Never expose the plaintext BB admin setup token via this admin
    // endpoint — it's routed through the hospital dashboard for their own
    // consumption, and leaking it here would let ngo_admin impersonate a
    // BB admin user.
    delete parent.bb_admin_pending_setup_token;

    const childrenR = await withRlsContext(req, (c) =>
      c.query(
        `SELECT i.*,
                s.name AS state_name,
                d.name AS district_name,
                t.name AS taluka_name,
                v.name AS village_name
           FROM institutions i
           LEFT JOIN states    s ON s.id = i.state_id
           LEFT JOIN districts d ON d.id = i.district_id
           LEFT JOIN talukas   t ON t.id = i.taluka_id
           LEFT JOIN villages  v ON v.id = i.village_id
          WHERE i.parent_institution_id = $1
          ORDER BY i.created_at ASC`,
        [req.params.id],
      ),
    );
    const children = childrenR.rows.map((row) => {
      const copy = { ...row };
      delete copy.bb_admin_pending_setup_token;
      return copy;
    });

    res.json({ institution: parent, children });
  },
);

// ── POST /onboarding/verify/:id (ngo_admin) ──────────────────────────────
// One click verifies parent + any children. Only rows currently in PE are
// touched — re-verifying a mixed batch (e.g. child already VE) is a no-op
// for the already-verified row, not an error.
router.post('/verify/:id', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const r = await withRlsContext(
    req,
    (c) =>
      c.query(
        `UPDATE institutions
              SET license_verified_at = clock_timestamp(),
                  license_verified_by = $1,
                  onboarding_status = 'VE'
            WHERE (id = $2 OR parent_institution_id = $2)
              AND onboarding_status = 'PE'
        RETURNING id, kind, onboarding_status, parent_institution_id`,
        [req.user.userId, req.params.id],
      ),
    { change_reason: 'admin license verify' },
  );
  if (r.rowCount === 0) {
    return res.status(404).json({ error: 'not_found_or_wrong_state' });
  }
  const verified = r.rows;
  const parent = verified.find((row) => row.id === req.params.id) || verified[0];
  res.json({
    institution_id: parent.id,
    onboarding_status: parent.onboarding_status,
    verified_ids: verified.map((row) => row.id),
    child_verified_count: verified.filter((row) => row.parent_institution_id !== null).length,
  });
});

// ── POST /onboarding/:id/mou-scan (ngo_admin) ────────────────────────────
// Optional companion to /activate: uploads a scan or photo of the SIGNED PAPER
// MoU and returns its storage key + hash so /activate can record the reference.
// Stateless — touches no DB row, so a failed activation leaves no dangling
// pointer (at worst an orphaned blob).
//
// Deliberately a RAW body rather than base64-in-JSON, because two global
// middlewares would silently corrupt the latter:
//   · express.json() is capped at 1mb (app.js) — a phone photo of a signed MoU
//     routinely exceeds that once base64 inflates it ~33%;
//   · sanitizeInput TRUNCATES any string at 8000 chars without erroring
//     (middleware/sanitize.js), so a large base64 field would arrive quietly
//     mangled. A Buffer body passes through sanitizeValue untouched.
// The global json/urlencoded parsers skip these content types entirely.
const SCAN_TYPES = {
  'application/pdf': { ext: 'pdf', magic: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': {
    ext: 'jpg',
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/png': {
    ext: 'png',
    magic: (b) =>
      b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
};

router.post(
  '/:id/mou-scan',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  express.raw({ type: Object.keys(SCAN_TYPES), limit: '10mb' }),
  async (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const spec = SCAN_TYPES[contentType];
    if (!spec) {
      return res
        .status(415)
        .json({ error: 'unsupported_media_type', accepted: Object.keys(SCAN_TYPES) });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'empty_body' });
    }
    // Content-Type is caller-supplied; verify the bytes actually match so a
    // mislabelled (or hostile) upload can't be filed as the legal original.
    if (!spec.magic(req.body)) {
      return res.status(400).json({ error: 'content_type_mismatch', declared: contentType });
    }

    const inst = await pool.query(
      `SELECT shortname, parent_institution_id FROM institutions WHERE id = $1`,
      [req.params.id],
    );
    if (inst.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    if (inst.rows[0].parent_institution_id !== null) {
      return res.status(409).json({ error: 'mou_signed_by_parent_only' });
    }

    const versionR = await pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM mou_versions WHERE institution_id = $1`,
      [req.params.id],
    );
    const nextVersion = versionR.rows[0].next;

    const key = `mou/${inst.rows[0].shortname}/v${nextVersion}-scan.${spec.ext}`;
    await storage.put(key, req.body, { contentType });
    const sha256 = sha256Hex(req.body);

    logger.info(
      {
        event: 'onboarding_mou_scan_stored',
        institutionId: req.params.id,
        version: nextVersion,
        bytes: req.body.length,
      },
      'Paper MoU scan stored',
    );

    res.json({ storage_key: key, sha256, bytes: req.body.length, content_type: contentType });
  },
);

// ── POST /onboarding/activate/:id (ngo_admin) ────────────────────────────
// VE → AC. Records the OFFLINE PAPER MoU the admin is holding, then activates
// the institution and provisions admin logins. This replaced the Leegality
// eSign round-trip (generate-mou + the mou-signed webhook); the activation
// transaction itself moved verbatim into services/onboarding/activate.js, so
// re-enabling eSign later is a new caller, not a rewrite.
//
// Parent-only: a child in-house BB inherits its parent's MoU and is flipped to
// AC by the same transaction.
// India-only platform, so "today" means today in IST — not UTC. Without this an
// admin recording a MoU after midnight IST would have their own current date
// rejected as being in the future. IST has no DST, so the fixed offset is exact.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

const activateSchema = z
  .object({
    // The date written on the signed paper — may predate today, since the
    // admin records it after the document reaches them.
    mou_signed_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'invalid_date' })
      .refine((v) => v <= istToday(), { message: 'signed_date_in_future' }),
    signatory_name: z.string().min(2).max(120),
    signatory_designation: z.string().min(2).max(120).optional(),
    // Both from a prior /mou-scan response, or neither. The DB enforces the
    // pairing too (constraint scan_key_and_hash_together, migration 310).
    mou_scan_key: z.string().min(3).max(300).optional(),
    mou_scan_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (Boolean(v.mou_scan_key) !== Boolean(v.mou_scan_sha256)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mou_scan_sha256'],
        message: 'scan_key_and_hash_must_be_provided_together',
      });
    }
  });

router.post(
  '/activate/:id',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = activateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
    }
    const body = parsed.data;

    const inst = await pool.query(
      `SELECT id, onboarding_status, parent_institution_id FROM institutions WHERE id = $1`,
      [req.params.id],
    );
    if (inst.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const i = inst.rows[0];

    if (i.parent_institution_id !== null) {
      return res.status(409).json({ error: 'mou_signed_by_parent_only' });
    }
    // 'AC' is called out separately from the generic state error: a double
    // click would otherwise file a second mou_versions row and re-issue a
    // second pair of setup tokens, invalidating the links already sent.
    // (Annual MoU RENEWAL is a separate flow, not this endpoint.)
    if (i.onboarding_status === 'AC') {
      return res.status(409).json({ error: 'already_active' });
    }
    if (i.onboarding_status !== 'VE') {
      return res.status(409).json({ error: 'must_verify_license_first' });
    }

    const result = await activateInstitution({
      institutionId: i.id,
      recordedByUserId: req.user.userId,
      mou: {
        signingMode: 'PA',
        signedOn: body.mou_signed_on,
        signatoryName: body.signatory_name,
        signatoryDesignation: body.signatory_designation || null,
        scanKey: body.mou_scan_key || null,
        scanSha256: body.mou_scan_sha256 || null,
      },
    });

    logger.info(
      {
        event: 'onboarding_activated',
        institutionId: i.id,
        childInstitutionId: result.childId,
        version: result.versionNumber,
        signingMode: 'PA',
        scanOnFile: Boolean(body.mou_scan_key),
        activatedBy: req.user.userId,
      },
      'Institution activated against a paper MoU',
    );

    // Send the HO admin's magic link via WhatsApp. The BB admin's link stays
    // on the parent row for surfacing via the hospital dashboard — no auto-WA,
    // so the HO admin controls when the BB team is onboarded.
    //
    // A send failure must NOT roll activation back: the institution is
    // legitimately active, and the admin can resend. Log loudly instead.
    //
    // The send's OUTCOME is captured, not just its exceptions. The chokepoint
    // returns `success:false` without throwing when a WHATSAPP_TEMPLATE_* env
    // var is unset — so a swallowed catch reports a successful activation while
    // the hospital receives nothing. That is exactly how an institution ends up
    // live with an admin who cannot sign in.
    let waSent = false;
    try {
      const r = await sendNotification({
        recipientId: result.institution.primary_contact_mobile,
        templateType: 'SETUP_LINK',
        variables: {
          signatory_name: body.signatory_name || result.institution.primary_contact_name || 'Admin',
          institution_name: result.institution.display_name || result.institution.shortname,
          setup_token: result.hoSetupToken,
        },
        channel: 'WA',
        language: 'en',
      });
      if (r?.success) {
        waSent = true;
      } else {
        logger.warn(
          { event: 'onboarding_activate_ho_notify_unsent', institutionId: i.id, result: r },
          'HO admin activation WhatsApp did not send — setup URL returned to admin instead',
        );
      }
    } catch (err) {
      logger.error(
        {
          event: 'onboarding_activate_ho_notify_failed',
          institutionId: i.id,
          err: err.message,
        },
        'HO admin activation WhatsApp send failed — row still activated, admin can resend',
      );
    }

    // The setup URLs are returned UNCONDITIONALLY, not dev-gated.
    //
    // Only SHA-256(token) is stored (services/users/setup.js), so the plaintext
    // exists nowhere once this response is written. Withholding it in production
    // meant a failed WhatsApp send left the link unrecoverable and the
    // institution permanently locked out of its own account.
    //
    // This grants ngo_admin no new privilege: that role can already mint a fresh
    // link for any staff account via POST /auth/institutional/reset-password.
    // It only makes the capability usable when WhatsApp is the broken link.
    const hoSetupUrl = `${env.frontendUrl}/setup/${result.hoSetupToken}`;
    const bbSetupUrl = result.bbSetupToken
      ? `${env.frontendUrl}/setup/${result.bbSetupToken}`
      : null;

    res.json({
      status: 'activated',
      institution_id: i.id,
      child_institution_id: result.childId,
      onboarding_status: 'AC',
      mou_signing_mode: 'PA',
      version: result.versionNumber,
      ho_admin_username: result.hoAdminUsername,
      ho_admin_setup_url: hoSetupUrl,
      ho_setup_expires_at: result.hoExpiresAt,
      bb_admin_username: result.bbAdminUsername,
      bb_admin_setup_url: bbSetupUrl,
      bb_setup_expires_at: result.bbExpiresAt,
      whatsapp_sent: waSent,
      next_step: waSent
        ? `Password-setup link sent to ${result.institution.primary_contact_mobile}. They set a password, then sign in at /staff/login as "${result.hoAdminUsername}".` +
          (bbSetupUrl
            ? ' The blood-bank admin link is not WhatsApp’d — it surfaces on the hospital dashboard.'
            : '')
        : `Institution is ACTIVE but the WhatsApp did NOT send. Share the hospital setup link below out-of-band so "${result.hoAdminUsername}" can set a password. The link is shown once — re-issue it from the Institution users tab if it is lost.`,
    });
  },
);

module.exports = router;
