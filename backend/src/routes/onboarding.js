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
 *   POST /onboarding/generate-mou/:id   — ngo_admin; idempotent eSign request.
 *                                          Rejects if called on a child. Persists
 *                                          doc_id/url on institutions so refresh +
 *                                          re-click return the same URL.
 *   POST /onboarding/mou-signed         — eSign webhook; parent + any children → AC,
 *                                          provisions HO admin + optional BB admin,
 *                                          sends HO WhatsApp, stashes BB token on
 *                                          parent for the hospital dashboard.
 *
 * The webhook ALWAYS returns 200 — Leegality retries non-2XX responses, and we
 * surface errors via structured logs (event: 'esign_webhook_*') so App Insights
 * alerts can catch them instead of burning silent 401 retries.
 */
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContext, withRlsContextRaw } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { normaliseIndianMobile } = require('../utils/phone');
const eSign = require('../services/esign');
const storage = require('../services/storage');
const { sendNotification } = require('../services/notifications');
const setupSvc = require('../services/users/setup');

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

// ── POST /onboarding/generate-mou/:id (ngo_admin) ────────────────────────
// Idempotent. If the institution already has an in-flight eSign
// (`current_esign_doc_id` set + not-yet-expired), returns the persisted URL
// without hitting Leegality. This makes admin refresh-and-re-click safe.
//
// Only callable on a PARENT institution (top-level or standalone). Child
// BBs inherit their parent's MoU — signing on a child is rejected.
router.post(
  '/generate-mou/:id',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const inst = await pool.query(
      `SELECT i.id, i.kind, i.shortname, i.legal_name, i.display_name,
              i.address_line, i.pincode, i.latitude, i.longitude,
              i.cdsco_licence_number, i.cdsco_licence_expires,
              i.hospital_registration_no,
              i.primary_contact_name, i.primary_contact_designation,
              i.primary_contact_mobile, i.primary_contact_email,
              i.has_inhouse_blood_bank, i.is_blood_bank_software_user,
              i.software_vendor, i.onboarding_status,
              i.parent_institution_id,
              i.current_esign_doc_id, i.current_esign_url, i.current_esign_expires_at,
              s.name  AS state_name,
              d.name  AS district_name,
              t.name  AS taluka_name,
              v.name  AS village_name
         FROM institutions i
         LEFT JOIN states    s ON s.id = i.state_id
         LEFT JOIN districts d ON d.id = i.district_id
         LEFT JOIN talukas   t ON t.id = i.taluka_id
         LEFT JOIN villages  v ON v.id = i.village_id
        WHERE i.id = $1`,
      [req.params.id],
    );
    if (inst.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    const i = inst.rows[0];

    if (i.parent_institution_id !== null) {
      return res.status(409).json({ error: 'mou_signed_by_parent_only' });
    }
    if (!['VE', 'AC'].includes(i.onboarding_status)) {
      return res.status(409).json({ error: 'must_verify_license_first' });
    }

    // Idempotency: if we already sent an eSign request that hasn't expired,
    // return the same URL. This lets the admin refresh the page + re-click
    // Send-MoU without creating a second Leegality document.
    if (
      i.current_esign_doc_id &&
      i.current_esign_url &&
      i.current_esign_expires_at &&
      new Date(i.current_esign_expires_at) > new Date()
    ) {
      return res.json({
        institution_id: i.id,
        doc_id: i.current_esign_doc_id,
        sign_url: i.current_esign_url,
        expires_at: i.current_esign_expires_at,
        provider: eSign.providerName,
        cached: true,
      });
    }

    // Hydrate child BB (if any) for the MoU template — its CDSCO licence
    // details appear on the same signed document.
    const childR = await pool.query(
      `SELECT cdsco_licence_number, cdsco_licence_expires, shortname
         FROM institutions
        WHERE parent_institution_id = $1
          AND kind = 'BB'
        ORDER BY created_at ASC
        LIMIT 1`,
      [i.id],
    );
    const child = childR.rows[0] || null;

    // Next MoU version — surfaced so the PDF can render "MoU v3" etc.
    const versionR = await pool.query(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM mou_versions WHERE institution_id = $1`,
      [i.id],
    );
    const nextVersion = versionR.rows[0].next;

    const today = new Date().toISOString().slice(0, 10);
    const yearOut = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const templateData = {
      // Identity
      institution_legal_name: i.legal_name,
      institution_display_name: i.display_name,
      institution_type: i.kind === 'BB' ? 'Blood Bank' : 'Hospital',
      institution_shortname: i.shortname,

      // Address
      institution_address: i.address_line,
      state_name: i.state_name || '',
      district_name: i.district_name || '',
      taluka_name: i.taluka_name || '',
      village_name: i.village_name || '',
      pincode: i.pincode,
      latitude: i.latitude != null ? String(i.latitude) : '',
      longitude: i.longitude != null ? String(i.longitude) : '',

      // Licensing — parent + child bundled so paired MoUs render both licences.
      license_number: i.cdsco_licence_number || i.hospital_registration_no || '',
      cdsco_licence_number: i.cdsco_licence_number || (child?.cdsco_licence_number ?? ''),
      cdsco_licence_expires: (() => {
        const src = i.cdsco_licence_expires || child?.cdsco_licence_expires;
        return src ? new Date(src).toISOString().slice(0, 10) : '';
      })(),
      hospital_registration_no: i.hospital_registration_no || '',
      has_inhouse_blood_bank: i.has_inhouse_blood_bank ? 'Yes' : 'No',
      inhouse_bb_shortname: child?.shortname || '',

      // Contact + signatory
      primary_contact_name: i.primary_contact_name,
      primary_contact_designation: i.primary_contact_designation || '',
      primary_contact_mobile: i.primary_contact_mobile,
      primary_contact_email: i.primary_contact_email || '',
      signatory_name: i.primary_contact_name,
      signatory_designation: i.primary_contact_designation || 'Authorised Signatory',

      // Capability flags
      is_blood_bank_software_user: i.is_blood_bank_software_user ? 'Yes' : 'No',
      software_vendor: i.software_vendor || '',

      // Dates + version
      signing_date: today,
      effective_from: today,
      effective_until: yearOut,
      effective_until_date: yearOut,
      mou_version: String(nextVersion),
    };

    const eSignResult = await eSign.sendForSign({
      institutionId: i.id,
      signatoryMobile: i.primary_contact_mobile,
      signatoryName: i.primary_contact_name,
      templateData,
    });

    // Persist the doc so refresh + re-click return the same URL and no
    // second Leegality document is created.
    await withRlsContextRaw(
      { actor_role: 'onboarding', change_reason: 'esign send — persist doc' },
      async (c) =>
        c.query(
          `UPDATE institutions
              SET current_esign_doc_id     = $1,
                  current_esign_url        = $2,
                  current_esign_expires_at = $3,
                  current_esign_sent_at    = NOW()
            WHERE id = $4`,
          [eSignResult.docId, eSignResult.signUrl, eSignResult.expiresAt, i.id],
        ),
    );

    res.json({
      institution_id: i.id,
      doc_id: eSignResult.docId,
      sign_url: eSignResult.signUrl,
      expires_at: eSignResult.expiresAt,
      provider: eSign.providerName,
      cached: false,
    });
  },
);

// ── POST /onboarding/mou-signed (eSign webhook) ──────────────────────────
// Handles Leegality's Success + Error webhooks. Always returns 200 (with the
// outcome in the body) — a non-2XX would burn Leegality's fixed 3-retry
// budget without giving us diagnostic visibility. Errors are surfaced via
// structured logs (event: 'esign_webhook_*') so App Insights alerts fire.
//
// On Success/Signed: transaction flips parent + children to AC, provisions
// the HO admin user (WhatsApp sent), and — if a child BB exists — provisions
// the BB admin user too and stashes the plaintext setup token on the parent
// row so the HO admin's dashboard can surface it.
router.post('/mou-signed', async (req, res) => {
  let webhook;
  try {
    webhook = eSign.verifyWebhook(req.headers, req.body);
  } catch (err) {
    logger.error(
      {
        event: 'esign_webhook_hmac_mismatch',
        provider: eSign.providerName,
        error: err.message,
      },
      'eSign webhook verification failed — payload ignored',
    );
    return res.json({ status: 'ignored', reason: 'hmac_mismatch' });
  }

  if (webhook.webhookType === 'Error' || webhook.action !== 'Signed') {
    logger.warn(
      {
        event: 'esign_webhook_non_success',
        docId: webhook.docId,
        webhookType: webhook.webhookType,
        action: webhook.action,
        error: webhook.error,
      },
      'eSign webhook non-success — institution stays in VE state',
    );
    return res.json({ status: 'acknowledged', event: webhook.webhookType });
  }

  // Resolve institution_id: webhook.irn is our authoritative source (we set
  // it on sendForSign). Fallback to req.body.institution_id (legacy) or the
  // local outbox file (dev/smoke).
  let institutionId = webhook.irn || req.body.institution_id;
  if (!institutionId && webhook.docId) {
    try {
      const r = await pool.query(
        `SELECT id FROM institutions WHERE current_esign_doc_id = $1 LIMIT 1`,
        [webhook.docId],
      );
      if (r.rowCount > 0) institutionId = r.rows[0].id;
    } catch (err) {
      logger.error(
        { event: 'esign_webhook_lookup_error', err: err.message },
        'Failed to resolve institution from docId',
      );
    }
  }
  if (!institutionId) {
    try {
      const fs = require('fs');
      const path = require('path');
      const fp = path.resolve(env.local.outboxDir, 'esign', `${webhook.docId}.json`);
      if (fs.existsSync(fp)) {
        institutionId = JSON.parse(fs.readFileSync(fp, 'utf8')).institutionId;
      }
    } catch (err) {
      logger.error(
        { event: 'esign_webhook_outbox_lookup_error', err: err.message },
        'Failed to resolve institution from outbox file',
      );
    }
  }
  if (!institutionId) {
    logger.error(
      { event: 'esign_webhook_unresolved', docId: webhook.docId },
      'eSign webhook signed but no institution_id could be resolved',
    );
    return res.json({ status: 'ignored', reason: 'institution_unresolved' });
  }

  const inst = await pool.query(
    `SELECT id, shortname, display_name, primary_contact_name,
            primary_contact_mobile, kind, onboarding_status,
            parent_institution_id
       FROM institutions WHERE id = $1`,
    [institutionId],
  );
  if (inst.rowCount === 0) {
    logger.error(
      { event: 'esign_webhook_institution_not_found', institutionId, docId: webhook.docId },
      'eSign webhook resolved to a missing institution row',
    );
    return res.json({ status: 'ignored', reason: 'institution_not_found' });
  }
  const i = inst.rows[0];

  if (i.parent_institution_id !== null) {
    // MoU is signed by the parent HO; a child ID here means a stale/wrong
    // irn. Refuse rather than corrupt the parent's state.
    logger.error(
      { event: 'esign_webhook_child_institution', institutionId, docId: webhook.docId },
      'eSign webhook targeted a child institution — parent-only',
    );
    return res.json({ status: 'ignored', reason: 'child_institution' });
  }

  // Look up the child BB if this HO onboarded with an in-house BB.
  const childR = await pool.query(
    `SELECT id, shortname FROM institutions
      WHERE parent_institution_id = $1 AND kind = 'BB'
      ORDER BY created_at ASC LIMIT 1`,
    [institutionId],
  );
  const child = childR.rows[0] || null;

  // Compute next mou version for the parent (MoU is filed once per pair).
  const versionR = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM mou_versions WHERE institution_id = $1`,
    [institutionId],
  );
  const versionNumber = versionR.rows[0].next;

  // Placeholder PDF until PDF generation lands. See the historical comment
  // in prior versions of this route — non-blocking for AC transition.
  const placeholderKey = `mou/${i.shortname}/v${versionNumber}.pdf`;
  await storage.put(placeholderKey, Buffer.from('LOCAL_DEV_MOU_PLACEHOLDER'));
  const sha256 = crypto.createHash('sha256').update('LOCAL_DEV_MOU_PLACEHOLDER').digest('hex');

  // Both admin usernames derived from the parent shortname. Regex constraint
  // on platform_users.username (migration 268) is ^[a-z][a-z0-9_-]{2,31}$;
  // <short>-bb_admin adds 9 chars, applySchema caps parent shortname at 23
  // when has_inhouse_blood_bank=true so the child username always fits.
  const hoAdminUsername = `${i.shortname}_admin`;
  const bbAdminUsername = child ? `${child.shortname}_admin` : null;
  const hoRole = 'hospital';
  const bbRole = 'blood_bank';

  const placeholderHash = await setupSvc.unusablePasswordHash();

  const result = await withRlsContextRaw(
    { actor_role: 'onboarding', change_reason: 'eSign webhook → activate' },
    async (c) => {
      // 1. mou_versions — one row for the parent; the child inherits.
      await c.query(
        `INSERT INTO mou_versions (
            institution_id, version_number, effective_from, effective_until,
            leegally_doc_id, leegally_template_id,
            signed_at, signatory_name, signatory_aadhaar_last4,
            pdf_storage_key, pdf_sha256, template_snapshot)
         VALUES ($1,$2, CURRENT_DATE, (CURRENT_DATE + INTERVAL '1 year')::date,
            $3,$4, $5,$6,$7, $8,$9, $10::jsonb)`,
        [
          institutionId,
          versionNumber,
          webhook.docId,
          env.leegality.templateId || 'local-template',
          webhook.signedAt,
          webhook.signatoryName || 'Unknown',
          webhook.signatoryAadhaarLast4 || null,
          placeholderKey,
          sha256,
          JSON.stringify({ doc_id: webhook.docId, version: versionNumber }),
        ],
      );

      // 2. Flip parent + any children to AC in one UPDATE. Also clear the
      //    parent's in-flight eSign fields so a follow-up Send-MoU (renewal)
      //    starts fresh.
      await c.query(
        `UPDATE institutions
            SET onboarding_status = 'AC',
                current_esign_doc_id     = NULL,
                current_esign_url        = NULL,
                current_esign_expires_at = NULL
          WHERE id = $1 OR parent_institution_id = $1`,
        [institutionId],
      );
      await c.query(
        `UPDATE institutions
            SET mou_signed_at = $1, mou_leegally_doc_id = $2,
                mou_signatory_name = $3,
                mou_expires_at = (CURRENT_DATE + INTERVAL '1 year')::date
          WHERE id = $4`,
        [webhook.signedAt, webhook.docId, webhook.signatoryName || null, institutionId],
      );

      // 3. HO admin — idempotent on username (handover / MoU renewal case).
      const hoExisting = await c.query(`SELECT id FROM platform_users WHERE username = $1`, [
        hoAdminUsername,
      ]);
      let hoUserId;
      if (hoExisting.rowCount === 0) {
        const created = await c.query(
          `INSERT INTO platform_users
             (role, username, mobile, password_hash, password_set_at,
              force_password_change, institution_id)
           VALUES ($1, $2, $3, $4, NOW(), TRUE, $5)
           RETURNING id`,
          [hoRole, hoAdminUsername, i.primary_contact_mobile, placeholderHash, institutionId],
        );
        hoUserId = created.rows[0].id;
      } else {
        hoUserId = hoExisting.rows[0].id;
        await c.query(
          `UPDATE platform_users
              SET password_hash = $1, password_set_at = NOW(),
                  mobile = $2,
                  force_password_change = TRUE
            WHERE id = $3`,
          [placeholderHash, i.primary_contact_mobile, hoUserId],
        );
      }
      const { token: hoSetupToken, expiresAt: hoExpiresAt } = await setupSvc.generateSetupToken(
        c,
        hoUserId,
      );

      // 4. BB admin (only if a child BB exists).
      let bbSetupToken = null;
      let bbExpiresAt = null;
      let bbUserId = null;
      if (child) {
        const bbExisting = await c.query(`SELECT id FROM platform_users WHERE username = $1`, [
          bbAdminUsername,
        ]);
        if (bbExisting.rowCount === 0) {
          const bbPlaceholder = await setupSvc.unusablePasswordHash();
          const created = await c.query(
            `INSERT INTO platform_users
               (role, username, mobile, password_hash, password_set_at,
                force_password_change, institution_id)
             VALUES ($1, $2, $3, $4, NOW(), TRUE, $5)
             RETURNING id`,
            [bbRole, bbAdminUsername, i.primary_contact_mobile, bbPlaceholder, child.id],
          );
          bbUserId = created.rows[0].id;
        } else {
          bbUserId = bbExisting.rows[0].id;
          const bbPlaceholder = await setupSvc.unusablePasswordHash();
          await c.query(
            `UPDATE platform_users
                SET password_hash = $1, password_set_at = NOW(),
                    mobile = $2,
                    force_password_change = TRUE
              WHERE id = $3`,
            [bbPlaceholder, i.primary_contact_mobile, bbUserId],
          );
        }
        const bb = await setupSvc.generateSetupToken(c, bbUserId);
        bbSetupToken = bb.token;
        bbExpiresAt = bb.expiresAt;

        // Stash the plaintext token on the parent so the HO admin's
        // dashboard can surface it. Trigger fn_clear_bb_admin_pending_token
        // wipes this when the BB admin consumes the token.
        await c.query(
          `UPDATE institutions
              SET bb_admin_pending_setup_token = $1
            WHERE id = $2`,
          [bbSetupToken, institutionId],
        );
      }

      return {
        hoUserId,
        hoAdminUsername,
        hoSetupToken,
        hoExpiresAt,
        bbUserId,
        bbAdminUsername,
        bbSetupToken,
        bbExpiresAt,
      };
    },
  );

  // Send the HO admin's magic link via WhatsApp. BB admin's link stays on
  // the parent row for surfacing via the hospital dashboard — no auto-WA to
  // avoid a second Meta send (and to give the HO admin control over when
  // the BB team is onboarded).
  try {
    await sendNotification({
      recipientId: i.primary_contact_mobile,
      templateType: 'SETUP_LINK',
      variables: {
        signatory_name: webhook.signatoryName || i.primary_contact_name || 'Admin',
        institution_name: i.display_name || i.shortname,
        setup_token: result.hoSetupToken,
      },
      channel: 'WA',
      language: 'en',
    });
  } catch (err) {
    logger.error(
      {
        event: 'esign_webhook_ho_notify_failed',
        institutionId,
        err: err.message,
      },
      'HO admin activation WhatsApp send failed — row still activated, admin can resend',
    );
  }

  const devEcho =
    env.nodeEnv === 'development'
      ? {
          dev_ho_admin_username: result.hoAdminUsername,
          dev_ho_setup_url: `${env.frontendUrl}/setup/${result.hoSetupToken}`,
          dev_ho_setup_expires_at: result.hoExpiresAt,
          dev_bb_admin_username: result.bbAdminUsername,
          dev_bb_setup_url: result.bbSetupToken
            ? `${env.frontendUrl}/setup/${result.bbSetupToken}`
            : null,
          dev_bb_setup_expires_at: result.bbExpiresAt,
        }
      : {};
  res.json({
    status: 'activated',
    institution_id: institutionId,
    child_institution_id: child?.id || null,
    version: versionNumber,
    ...devEcho,
  });
});

module.exports = router;
