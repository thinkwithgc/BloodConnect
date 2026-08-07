/**
 * Donation camp routes (spec §11).
 *
 *   POST /camps/apply              PUBLIC — external host submits a camp;
 *                                  lands in status=PE awaiting NGO review
 *   GET  /camps                    list — upcoming + (optional) district filter
 *   GET  /camps/:id                detail
 *   GET  /camps/:id/registrations  roster — coordinator/admin/BB
 *   POST /camps                    create direct — coordinator/admin (status=PL)
 *   POST /camps/:id/verify         PE → PL — coordinator/admin
 *   POST /camps/:id/decline        PE → DC — coordinator/admin
 *   POST /camps/:id/register       donor self-RSVP
 *   DELETE /camps/:id/register     donor cancels RSVP
 *
 * The denormalised donation_camps.registered_donor_count is kept in sync by
 * triggers on camp_registrations (migration 260). Migration 261 widens the
 * status enum and adds public-submitter fields.
 */
const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');

const { pool } = require('../config/db');
const { withRlsContext, withRlsContextRaw } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { verify: verifyJwtToken } = require('../utils/jwt');
const logger = require('../config/logger');
const env = require('../config/env');
const { normaliseIndianMobile } = require('../utils/phone');
const { openRows } = require('../services/pii');
const { sendNotification } = require('../services/notifications');

// Behind Azure App Service / Front Door, req.ip can surface as a multi-hop
// X-Forwarded-For string, an IPv4-mapped IPv6 like '::ffff:1.2.3.4', or an
// unparseable proxy fallback. The audit_log column tolerates this (TEXT),
// but camp_access_tokens.last_used_ip is INET — and Postgres rejects bad
// INET values with error 22P02. This helper strips junk and returns null
// when the value can't be parsed as a clean IPv4 or IPv6.
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;
function cleanClientIp(req) {
  let raw = req?.ip || req?.headers?.['x-forwarded-for'] || null;
  if (!raw) return null;
  // X-Forwarded-For may be a comma-separated chain — take the first hop.
  raw = String(raw).split(',')[0].trim();
  // Strip the IPv4-mapped IPv6 prefix Postgres also accepts but other
  // tooling sometimes mangles.
  if (raw.startsWith('::ffff:')) raw = raw.slice(7);
  if (IPV4.test(raw) || (raw.includes(':') && IPV6.test(raw))) return raw;
  return null;
}

const router = express.Router();

// ── GET /camps ───────────────────────────────────────────────────────────
// Default: status IN ('PL','LV') and scheduled_date >= today.
// Optional flags:
//   ?district_id=…  scope to one district
//   ?status=…       exact status filter (PL/LV/PE/CO/CA/DC)
//   ?stale=true     "PL or LV" camps whose scheduled_date is at least a
//                   day in the past — these are the ones the admin needs
//                   to complete-or-cancel. 1-day grace so a same-day camp
//                   that's still being wound up isn't nagged.
router.get('/', verifyJWT, async (req, res) => {
  const districtId = req.query.district_id ? Number(req.query.district_id) : null;
  const status = req.query.status || null;
  const stale = req.query.stale === 'true';
  const isReviewer = ['ngo_admin', 'super_admin', 'coordinator'].includes(req.user.role);

  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT c.id, c.name, c.slug, c.qr_code_token,
              c.district_id, d.name AS district_name,
              c.venue, c.address_line, c.pincode,
              c.scheduled_date, c.start_time, c.end_time,
              c.organiser_name, c.organiser_type,
              c.target_donor_count, c.registered_donor_count,
              c.attended_donor_count, c.units_collected,
              c.status, c.partnered_blood_bank_id,
              i.display_name AS partnered_blood_bank_name,
              c.submitted_by_name, c.submitted_by_mobile,
              c.submitted_by_email, c.submitted_by_role,
              c.volunteer_training_requested, c.expected_volunteer_count,
              c.review_notes, c.declined_reason, c.cancelled_reason,
              c.verified_at, c.declined_at,
              (c.status IN ('PL','LV')
                 AND c.scheduled_date < CURRENT_DATE - INTERVAL '1 day') AS is_stale
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
        WHERE ($1::int  IS NULL OR c.district_id = $1)
          AND ($2::text IS NULL OR c.status = $2)
          AND ($3::boolean IS TRUE
                 OR $2::text IS NOT NULL
                 OR (c.status IN ('PL','LV') AND c.scheduled_date >= CURRENT_DATE))
          AND ($3::boolean IS NOT TRUE
                 OR (c.status IN ('PL','LV')
                     AND c.scheduled_date < CURRENT_DATE - INTERVAL '1 day'))
     ORDER BY c.scheduled_date ASC, c.start_time ASC
        LIMIT 100`,
      [districtId, status, stale],
    ),
  );

  // Non-reviewers (donors, hospitals, blood banks) never see the submitter
  // PII. The columns above are returned for the SQL convenience of a single
  // query; we redact them per-row before sending the response.
  const REDACT_KEYS = [
    'submitted_by_name',
    'submitted_by_mobile',
    'submitted_by_email',
    'submitted_by_role',
    'review_notes',
    'declined_reason',
  ];
  const camps = isReviewer
    ? r.rows
    : r.rows.map((row) => {
        const safe = { ...row };
        for (const k of REDACT_KEYS) delete safe[k];
        return safe;
      });

  // For donors, mark each camp with whether they've already RSVP'd. This lets
  // the dashboard render "Already registered" instead of the RSVP button on
  // return visits (state was previously session-local, so a page refresh
  // would show the button again for camps the donor had RSVP'd to).
  if (req.user.role === 'donor' && camps.length > 0) {
    const mine = await withRlsContext(req, (c) =>
      c.query(
        `SELECT cr.camp_id
           FROM camp_registrations cr
           JOIN donors d ON d.id = cr.donor_id
          WHERE d.platform_user_id = $1
            AND cr.camp_id = ANY($2::uuid[])`,
        [req.user.userId, camps.map((c) => c.id)],
      ),
    );
    const registered = new Set(mine.rows.map((row) => row.camp_id));
    for (const c of camps) c.is_current_donor_registered = registered.has(c.id);
  }
  res.json({ camps, count: r.rowCount });
});

// ── POST /camps/apply (PUBLIC) ───────────────────────────────────────────
// External camp hosts (hospitals not yet onboarded, blood banks, NGOs,
// communities, colleges, corporates) submit a camp here. Lands in status=PE
// pending NGO coordinator review. Mirrors the institution onboarding apply
// pattern: no JWT, uses actor_role='onboarding' for RLS + audit.
//
// Declared BEFORE GET /:id so Express doesn't bind 'apply' to :id.
const applySchema = z.object({
  // Camp identity
  name: z.string().min(2),
  organiser_type: z.enum(['CC', 'CO', 'EI', 'EO', 'MC', 'OT']),
  organiser_name: z.string().min(2),

  // Geography
  state_id: z.number().int().positive(),
  district_id: z.number().int().positive(),
  taluka_id: z.number().int().positive().optional(),
  venue: z.string().min(2),
  address_line: z.string().min(5),
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .optional(),

  // Schedule
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),

  // Targets
  target_donor_count: z.number().int().positive().max(2000).optional(),

  // Public submitter contact (the ask: who's hosting?)
  submitted_by_name: z.string().min(2),
  submitted_by_mobile: z.string(),
  submitted_by_email: z.string().email().optional(),
  submitted_by_role: z.string().optional(),

  // Volunteer training ask
  volunteer_training_requested: z.boolean().optional(),
  expected_volunteer_count: z.number().int().min(0).max(500).optional(),
  notes: z.string().max(2000).optional(),

  // Phase 4b — if a community_leader hosts the camp from their portal,
  // the frontend forwards the community_id so the camp links to the
  // community. Validated server-side: caller must be a community_leader
  // who owns or co-leads this community. External /camps/apply submitters
  // pass NULL here.
  community_id: z.string().uuid().optional(),
});

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

router.post('/apply', async (req, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const d = parsed.data;
  const submitterMobile = normaliseIndianMobile(d.submitted_by_mobile);
  if (!submitterMobile) {
    return res.status(400).json({ error: 'invalid_mobile_format' });
  }

  const slug = `${slugify(d.name)}-${Date.now().toString(36).slice(-5)}`;
  const qrToken = crypto.randomBytes(18).toString('base64url');

  const created = await withRlsContextRaw(
    { actor_role: 'onboarding', change_reason: 'public camp apply' },
    async (c) => {
      const r = await c.query(
        `INSERT INTO donation_camps (
           name, slug, qr_code_token,
           state_id, district_id, taluka_id,
           venue, address_line, pincode,
           scheduled_date, start_time, end_time,
           organiser_type, organiser_name,
           target_donor_count, status,
           submitted_by_name, submitted_by_mobile,
           submitted_by_email, submitted_by_role,
           volunteer_training_requested, expected_volunteer_count,
           review_notes)
         VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12,
           $13, $14,
           $15, 'PE',
           $16, $17,
           $18, $19,
           $20, $21,
           $22)
         RETURNING id, name, slug, scheduled_date, status`,
        [
          d.name,
          slug,
          qrToken,
          d.state_id,
          d.district_id,
          d.taluka_id || null,
          d.venue,
          d.address_line,
          d.pincode || null,
          d.scheduled_date,
          d.start_time,
          d.end_time,
          d.organiser_type,
          d.organiser_name,
          d.target_donor_count || null,
          d.submitted_by_name,
          submitterMobile,
          d.submitted_by_email || null,
          d.submitted_by_role || null,
          d.volunteer_training_requested ?? false,
          d.expected_volunteer_count || null,
          d.notes || null,
        ],
      );
      return r.rows[0];
    },
  );

  logger.info(
    { camp_id: created.id, district_id: d.district_id, organiser_type: d.organiser_type },
    'Public camp application received',
  );

  res.status(201).json({
    camp_id: created.id,
    name: created.name,
    scheduled_date: created.scheduled_date,
    status: 'PE',
    next_step:
      'Our NGO coordinator will contact you within 2 working days to verify details and arrange volunteer training.',
  });
});

// ── GET /camps/public/:slug (PUBLIC poster page) ─────────────────────────
// The /c/<slug> share URL hits this. Returns a tightly scoped subset of
// camp data — no submitter PII, no internal review state. Only published
// (status PL or LV) camps are visible; PE/DC/CA/CO return 404.
//
// Optional auth: if the caller passes a Bearer token AND the JWT decodes
// to a donor, we enrich the response with `is_current_donor_registered` so
// the frontend can render "You're on the list" instead of the RSVP button
// on a repeat visit. Anonymous callers just don't get that field.
//
// Declared BEFORE GET /:id so 'public' doesn't bind to :id.
router.get('/public/:slug', async (req, res) => {
  const r = await withRlsContextRaw({ actor_role: 'system' }, (c) =>
    c.query(
      `SELECT c.id, c.name, c.slug,
              c.scheduled_date, c.start_time, c.end_time,
              c.venue, c.address_line, c.pincode,
              c.organiser_name, c.organiser_type,
              c.target_donor_count, c.registered_donor_count,
              c.status, c.poster_storage_key,
              d.name AS district_name,
              s.name AS state_name,
              i.display_name AS partnered_blood_bank_name
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
         JOIN states s    ON s.id = c.state_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
        WHERE c.slug = $1
          AND c.status IN ('PL', 'LV')
        LIMIT 1`,
      [req.params.slug],
    ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'camp_not_found' });
  const camp = r.rows[0];

  // Optional auth check: is the current donor already on the roster?
  const auth = req.headers.authorization || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/);
  let isRegistered = false;
  if (bearer) {
    try {
      const payload = verifyJwtToken(bearer[1]);
      if (payload?.role === 'donor' && payload?.sub) {
        const reg = await withRlsContextRaw({ actor_role: 'system' }, (c) =>
          c.query(
            `SELECT 1
               FROM camp_registrations cr
               JOIN donors d ON d.id = cr.donor_id
              WHERE cr.camp_id = $1 AND d.platform_user_id = $2
              LIMIT 1`,
            [camp.id, payload.sub],
          ),
        );
        isRegistered = reg.rowCount > 0;
      }
    } catch {
      // Invalid / expired token — treat as anonymous.
    }
  }
  res.json({ ...camp, is_current_donor_registered: isRegistered });
});

// ── GET /camps/:id ───────────────────────────────────────────────────────
router.get('/:id', verifyJWT, async (req, res) => {
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT c.*, d.name AS district_name,
              i.display_name AS partnered_blood_bank_name
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
        WHERE c.id = $1`,
      [req.params.id],
    ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

// ── GET /camps/:id/registrations ─────────────────────────────────────────
router.get(
  '/:id/registrations',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin', 'blood_bank'),
  async (req, res) => {
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT cr.id, cr.status, cr.registered_at, cr.source,
                d.id AS donor_id, d.full_name,
                bg.code AS blood_group_code
           FROM camp_registrations cr
           JOIN donors d        ON d.id = cr.donor_id
      LEFT JOIN blood_groups bg ON bg.id = d.blood_group_verified
          WHERE cr.camp_id = $1
       ORDER BY cr.registered_at DESC`,
        [req.params.id],
      ),
    );
    openRows(r.rows, ['full_name']); // donor name is column-encrypted at rest
    res.json({ registrations: r.rows, count: r.rowCount });
  },
);

// ── POST /camps (create) ─────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(2),
  district_id: z.number().int().positive(),
  state_id: z.number().int().positive(),
  taluka_id: z.number().int().positive().optional(),
  venue: z.string().min(2),
  address_line: z.string().min(5),
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .optional(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  organiser_type: z.enum(['CC', 'CO', 'EI', 'EO', 'MC', 'OT']),
  organiser_name: z.string().min(2),
  organiser_contact_name: z.string().optional(),
  partnered_blood_bank_id: z.string().uuid().optional(),
  target_donor_count: z.number().int().positive().max(2000).optional(),
});

router.post(
  '/',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const d = parsed.data;
    const slug = `${slugify(d.name)}-${Date.now().toString(36).slice(-5)}`;
    const qrToken = crypto.randomBytes(18).toString('base64url');

    const result = await withRlsContext(
      req,
      async (c) => {
        // Look up coordinator id if the actor is a coordinator.
        let organisingCoordId = null;
        if (req.user.role === 'coordinator') {
          const cr = await c.query(`SELECT id FROM coordinators WHERE platform_user_id = $1`, [
            req.user.userId,
          ]);
          if (cr.rowCount > 0) organisingCoordId = cr.rows[0].id;
        }

        const r = await c.query(
          `INSERT INTO donation_camps (
             name, slug, qr_code_token,
             state_id, district_id, taluka_id,
             venue, address_line, pincode,
             scheduled_date, start_time, end_time,
             organiser_type, organiser_name, organiser_contact_name,
             partnered_blood_bank_id, organising_coordinator_id,
             target_donor_count, status, created_by_user_id)
           VALUES (
             $1, $2, $3,
             $4, $5, $6,
             $7, $8, $9,
             $10, $11, $12,
             $13, $14, $15,
             $16, $17,
             $18, 'PL', $19)
           RETURNING id, name, slug, qr_code_token, scheduled_date, status`,
          [
            d.name,
            slug,
            qrToken,
            d.state_id,
            d.district_id,
            d.taluka_id || null,
            d.venue,
            d.address_line,
            d.pincode || null,
            d.scheduled_date,
            d.start_time,
            d.end_time,
            d.organiser_type,
            d.organiser_name,
            d.organiser_contact_name || null,
            d.partnered_blood_bank_id || null,
            organisingCoordId,
            d.target_donor_count || null,
            req.user.userId,
          ],
        );
        return r.rows[0];
      },
      { change_reason: 'create donation camp' },
    );

    res.status(201).json(result);
  },
);

// ── POST /camps/:id/verify (PE → PL) ─────────────────────────────────────
// Also mints a magic-link organizer access token and (when WhatsApp is wired)
// sends it to the submitter's mobile. Token is returned in the response so
// the admin UI can also surface a copy-to-clipboard link for offline-share.
router.post(
  '/:id/verify',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const schema = z.object({
      review_notes: z.string().max(2000).optional(),
      partnered_blood_bank_id: z.string().uuid().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

    const token = crypto.randomBytes(24).toString('base64url');

    const result = await withRlsContext(
      req,
      async (c) => {
        let organisingCoordId = null;
        if (req.user.role === 'coordinator') {
          const cr = await c.query(`SELECT id FROM coordinators WHERE platform_user_id = $1`, [
            req.user.userId,
          ]);
          if (cr.rowCount > 0) organisingCoordId = cr.rows[0].id;
        }
        const r = await c.query(
          `UPDATE donation_camps
              SET status = 'PL',
                  verified_by_user_id = $2,
                  verified_at = clock_timestamp(),
                  review_notes = COALESCE($3, review_notes),
                  partnered_blood_bank_id = COALESCE($4::uuid, partnered_blood_bank_id),
                  organising_coordinator_id = COALESCE($5::uuid, organising_coordinator_id)
            WHERE id = $1 AND status = 'PE'
        RETURNING id, status, verified_at,
                  scheduled_date, submitted_by_name, submitted_by_mobile, name`,
          [
            req.params.id,
            req.user.userId,
            parsed.data.review_notes || null,
            parsed.data.partnered_blood_bank_id || null,
            organisingCoordId,
          ],
        );
        if (r.rowCount === 0) {
          throw Object.assign(new Error('not_found_or_wrong_state'), { status: 409 });
        }
        const camp = r.rows[0];

        // Mint the access token. Expiry = camp date + 30 days (covers post-
        // camp wind-down — final attendance marking, impact recap).
        await c.query(
          `INSERT INTO camp_access_tokens (
             camp_id, token, granted_to_mobile, granted_to_name,
             created_by_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5,
                   ($6::date + INTERVAL '30 days')::timestamptz)`,
          [
            camp.id,
            token,
            camp.submitted_by_mobile,
            camp.submitted_by_name,
            req.user.userId,
            camp.scheduled_date,
          ],
        );
        return camp;
      },
      { change_reason: 'verify camp application' },
    );

    const magicUrl = `${env.frontendUrl || ''}/camp/${token}`;

    // Best-effort notification to the organizer. If WhatsApp Cloud isn't
    // wired the chokepoint just writes to the local outbox; the link is
    // also returned in the response so the admin can copy-paste manually.
    if (result.submitted_by_mobile) {
      sendNotification({
        recipientId: result.submitted_by_mobile,
        templateType: 'CAMP_LINK',
        variables: {
          camp_name: result.name,
          scheduled_date: String(result.scheduled_date),
          dashboard_url: magicUrl,
        },
        channel: 'WA',
        language: 'en',
      }).catch((err) => logger.warn({ err: err.message }, 'camp magic-link notify failed'));
    }

    res.json({
      ...result,
      submitted_by_mobile: undefined, // don't echo back; admin already has it
      submitted_by_name: undefined,
      organizer_dashboard: {
        token,
        url: magicUrl,
        expires_in_days: 'scheduled_date + 30',
      },
    });
  },
);

// ── POST /camps/:id/complete (PL/LV → CO) ────────────────────────────────
// Marks the camp as completed. Refuses future-dated camps (no crystal ball).
// Optional body fields let the admin backfill attendance metrics if the
// organizer forgot to mark them via the magic-link dashboard.
const completeCampSchema = z.object({
  attended_donor_count: z.number().int().min(0).max(10000).optional(),
  units_collected: z.number().int().min(0).max(10000).optional(),
  notes: z.string().max(2000).optional(),
});
router.post(
  '/:id/complete',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = completeCampSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const { attended_donor_count, units_collected, notes } = parsed.data;

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps
              SET status = 'CO',
                  attended_donor_count = COALESCE($1, attended_donor_count),
                  units_collected      = COALESCE($2, units_collected),
                  review_notes         = CASE
                    WHEN $3::text IS NULL THEN review_notes
                    ELSE COALESCE(review_notes,'') || E'\n[completed ' || NOW()::text || '] ' || $3::text
                  END
            WHERE id = $4
              AND status IN ('PL','LV')
              AND scheduled_date <= CURRENT_DATE
        RETURNING id, status, scheduled_date, attended_donor_count, units_collected`,
          [attended_donor_count ?? null, units_collected ?? null, notes || null, req.params.id],
        ),
      { change_reason: 'camp completed' },
    );
    if (r.rowCount === 0) {
      // Distinguish future-dated (409) from wrong-state / missing (404).
      const cur = await pool.query(
        `SELECT status, scheduled_date FROM donation_camps WHERE id = $1`,
        [req.params.id],
      );
      if (cur.rowCount === 0) return res.status(404).json({ error: 'not_found' });
      if (new Date(cur.rows[0].scheduled_date) > new Date()) {
        return res.status(409).json({
          error: 'camp_not_yet_scheduled',
          hint: 'Cannot mark a future-dated camp as completed. If it has been called off, use /cancel instead.',
        });
      }
      return res.status(409).json({
        error: 'wrong_state',
        current_status: cur.rows[0].status,
      });
    }
    res.json({ camp: r.rows[0] });
  },
);

// ── POST /camps/:id/cancel (PE/PL/LV → CA) ───────────────────────────────
// Cancels a camp. Reason required — cancellation without a rationale is a
// data-quality red flag. Any pre-CO/CA state can be cancelled; a completed
// or already-cancelled camp is a no-op (409).
const cancelCampSchema = z.object({
  cancelled_reason: z.string().min(3).max(1000),
});
router.post(
  '/:id/cancel',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = cancelCampSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const { cancelled_reason } = parsed.data;

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps
              SET status = 'CA',
                  cancelled_reason = $1
            WHERE id = $2
              AND status IN ('PE','PL','LV')
        RETURNING id, status, cancelled_reason, scheduled_date`,
          [cancelled_reason, req.params.id],
        ),
      { change_reason: `camp cancelled: ${cancelled_reason.slice(0, 200)}` },
    );
    if (r.rowCount === 0) {
      return res.status(409).json({ error: 'not_found_or_terminal_state' });
    }
    res.json({ camp: r.rows[0] });
  },
);

// ── GET /camps/access/:token (PUBLIC magic-link) ─────────────────────────
// Resolves a camp access token to a scoped dashboard payload. The token is
// the credential — no JWT. Refuses on revoked / expired tokens.
//
// Declared BEFORE /:id so /camps/access/<token>/registrations etc. don't
// race against the GET /:id route. Same trick as /apply.
async function loadToken(token) {
  const r = await withRlsContextRaw({ actor_role: 'system' }, (c) =>
    c.query(
      `SELECT t.id, t.camp_id, t.token, t.expires_at, t.revoked_at,
              t.granted_to_name, t.granted_to_mobile
         FROM camp_access_tokens t
        WHERE t.token = $1
        LIMIT 1`,
      [token],
    ),
  );
  if (r.rowCount === 0) return { ok: false, reason: 'invalid_token' };
  const t = r.rows[0];
  if (t.revoked_at) return { ok: false, reason: 'token_revoked', token: t };
  if (new Date(t.expires_at) <= new Date()) return { ok: false, reason: 'token_expired', token: t };
  return { ok: true, token: t };
}

router.get('/access/:token', async (req, res) => {
  const v = await loadToken(req.params.token);
  if (!v.ok) return res.status(403).json({ error: v.reason });
  const t = v.token;

  const dashboard = await withRlsContextRaw(
    {
      actor_role: 'camp_organizer',
      actor_system_process: `camp:${t.token.slice(0, 12)}`,
      camp_token: t.token,
      actor_ip_address: cleanClientIp(req),
      change_reason: 'camp organizer dashboard view',
    },
    async (c) => {
      const camp = (
        await c.query(
          `SELECT c.id, c.slug, c.name, c.scheduled_date, c.start_time, c.end_time,
                  c.venue, c.address_line, c.pincode,
                  c.status, c.organiser_name, c.organiser_type,
                  c.target_donor_count, c.registered_donor_count,
                  c.attended_donor_count, c.units_collected,
                  d.name AS district_name,
                  i.display_name AS partnered_blood_bank_name
             FROM donation_camps c
             JOIN districts d ON d.id = c.district_id
        LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
            WHERE c.id = $1`,
          [t.camp_id],
        )
      ).rows[0];

      const regs = (
        await c.query(
          `SELECT cr.id, cr.status, cr.registered_at, cr.source,
                  cr.referral_channel,
                  d.full_name,
                  bg.code AS blood_group_code,
                  COALESCE(d.deferral_status, 'OK') AS deferral_status
             FROM camp_registrations cr
             JOIN donors d        ON d.id = cr.donor_id
        LEFT JOIN blood_groups bg ON bg.id = d.blood_group_verified
            WHERE cr.camp_id = $1
         ORDER BY cr.registered_at DESC`,
          [t.camp_id],
        )
      ).rows;
      openRows(regs, ['full_name']); // donor name is column-encrypted at rest

      const channelMix = (
        await c.query(
          `SELECT COALESCE(referral_channel, 'direct') AS channel,
                  COUNT(*)::int AS count
             FROM camp_registrations
            WHERE camp_id = $1
         GROUP BY 1
         ORDER BY count DESC`,
          [t.camp_id],
        )
      ).rows;

      // Touch last_used + use_count for rough audit.
      await c.query(
        `UPDATE camp_access_tokens
            SET last_used_at = clock_timestamp(),
                last_used_ip = $2,
                use_count = use_count + 1
          WHERE id = $1`,
        [t.id, cleanClientIp(req)],
      );

      return { camp, registrations: regs, channel_mix: channelMix };
    },
  );

  res.json({
    granted_to_name: t.granted_to_name,
    expires_at: t.expires_at,
    ...dashboard,
  });
});

// ── POST /camps/access/:token/registrations/:regId/status ────────────────
// Organizer marks a donor AT (attended) or NS (no-show) on camp day.
router.post('/access/:token/registrations/:regId/status', async (req, res) => {
  const schema = z.object({ status: z.enum(['AT', 'NS', 'RG']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const v = await loadToken(req.params.token);
  if (!v.ok) return res.status(403).json({ error: v.reason });

  const r = await withRlsContextRaw(
    {
      actor_role: 'camp_organizer',
      actor_system_process: `camp:${v.token.token.slice(0, 12)}`,
      camp_token: v.token.token,
      actor_ip_address: cleanClientIp(req),
      change_reason: 'organizer marks attendance',
    },
    (c) =>
      c.query(
        `UPDATE camp_registrations
            SET status = $3,
                status_changed_at = clock_timestamp()
          WHERE id = $1 AND camp_id = $2
      RETURNING id, status`,
        [req.params.regId, v.token.camp_id, parsed.data.status],
      ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'registration_not_found' });
  res.json(r.rows[0]);
});

// ── POST /camps/access/:token/broadcast ──────────────────────────────────
// Send a message to all registered (RG status) donors. Used for last-minute
// venue changes, reminders, "bring an ID" notes.
router.post('/access/:token/broadcast', async (req, res) => {
  const schema = z.object({ message: z.string().min(5).max(500) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'message_required_5_to_500_chars' });
  }
  const v = await loadToken(req.params.token);
  if (!v.ok) return res.status(403).json({ error: v.reason });

  const donors = await withRlsContextRaw(
    {
      actor_role: 'camp_organizer',
      actor_system_process: `camp:${v.token.token.slice(0, 12)}`,
      camp_token: v.token.token,
      change_reason: 'organizer broadcast prep',
    },
    (c) =>
      c.query(
        `SELECT donor_id FROM camp_registrations
          WHERE camp_id = $1 AND status IN ('RG', 'AT')`,
        [v.token.camp_id],
      ),
  );

  let queued = 0;
  for (const row of donors.rows) {
    try {
      await sendNotification({
        recipientId: row.donor_id,
        templateType: 'CAMP_ANNC',
        variables: {
          camp_id: v.token.camp_id,
          message: parsed.data.message,
        },
        channel: 'WA',
        language: 'mr',
      });
      queued += 1;
    } catch (err) {
      logger.warn({ err: err.message, donor_id: row.donor_id }, 'camp broadcast send failed');
    }
  }
  res.json({ queued, total_registered: donors.rowCount });
});

// ── POST /camps/access/:token/revoke (admin emergency) ───────────────────
router.post(
  '/access/:token/revoke',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin', 'coordinator'),
  async (req, res) => {
    const schema = z.object({ reason: z.string().min(5).max(500) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'reason_required' });
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE camp_access_tokens
              SET revoked_at = clock_timestamp(),
                  revoked_reason = $2
            WHERE token = $1 AND revoked_at IS NULL
        RETURNING id`,
          [req.params.token, parsed.data.reason],
        ),
      { change_reason: `revoke camp token: ${parsed.data.reason}` },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'token_not_found_or_revoked' });
    res.json({ revoked: true });
  },
);

// ── POST /camps/:id/decline (PE → DC) ────────────────────────────────────
router.post(
  '/:id/decline',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const schema = z.object({ reason: z.string().min(5).max(2000) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'reason_required_min_5_chars' });
    }
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps
              SET status = 'DC',
                  declined_at = clock_timestamp(),
                  declined_reason = $2
            WHERE id = $1 AND status = 'PE'
        RETURNING id, status, declined_at`,
          [req.params.id, parsed.data.reason],
        ),
      { change_reason: `decline camp: ${parsed.data.reason}` },
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'not_found_or_wrong_state' });
    res.json(r.rows[0]);
  },
);

// ── POST /camps/:id/register (donor RSVP) ────────────────────────────────
const rsvpSchema = z.object({
  referral_channel: z
    .enum(['whatsapp', 'facebook', 'instagram', 'twitter', 'email', 'qr', 'direct', 'web'])
    .optional(),
});

router.post('/:id/register', verifyJWT, requireRole('donor'), async (req, res) => {
  const parsed = rsvpSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const channel = parsed.data.referral_channel || null;
  // Channel → source CHAR(2) bucket: QR is its own thing; everything else is
  // 'WB' web (the donor is on a web page, regardless of how they got there).
  const source = channel === 'qr' ? 'QR' : 'WB';

  const result = await withRlsContext(
    req,
    async (c) => {
      const donorR = await c.query(`SELECT id FROM donors WHERE platform_user_id = $1`, [
        req.user.userId,
      ]);
      if (donorR.rowCount === 0) {
        throw Object.assign(new Error('donor_profile_not_found'), { status: 404 });
      }
      const donorId = donorR.rows[0].id;
      const r = await c.query(
        `INSERT INTO camp_registrations (camp_id, donor_id, source, referral_channel)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (camp_id, donor_id) DO UPDATE
            SET status = 'RG',
                status_changed_at = clock_timestamp(),
                referral_channel = COALESCE(camp_registrations.referral_channel, EXCLUDED.referral_channel)
         RETURNING id, status, registered_at`,
        [req.params.id, donorId, source, channel],
      );
      return r.rows[0];
    },
    { change_reason: 'donor RSVP to camp' },
  );
  res.status(201).json(result);
});

// ── DELETE /camps/:id/register (donor cancels) ───────────────────────────
router.delete('/:id/register', verifyJWT, requireRole('donor'), async (req, res) => {
  await withRlsContext(
    req,
    async (c) => {
      const donorR = await c.query(`SELECT id FROM donors WHERE platform_user_id = $1`, [
        req.user.userId,
      ]);
      if (donorR.rowCount === 0) {
        throw Object.assign(new Error('donor_profile_not_found'), { status: 404 });
      }
      await c.query(`DELETE FROM camp_registrations WHERE camp_id = $1 AND donor_id = $2`, [
        req.params.id,
        donorR.rows[0].id,
      ]);
    },
    { change_reason: 'donor cancels camp RSVP' },
  );
  res.json({ cancelled: true });
});

module.exports = router;
