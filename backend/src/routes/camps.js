/**
 * Donation camp routes (spec §11).
 *
 *   POST /camps/apply              PUBLIC — external host submits a camp;
 *                                  lands in status=PE awaiting NGO review
 *   GET  /camps                    list — upcoming + (optional) district filter
 *   GET  /camps/mine               every camp I host, keyed on my mobile
 *   GET  /camps/collectable        camps a blood bank may record donations against
 *   GET  /camps/blood-bank-options PUBLIC — blood banks in a district, for the
 *                                  hosting form's "who will collect?" picker
 *   GET  /camps/:id                detail
 *   GET  /camps/:id/registrations  roster — coordinator/admin/BB
 *   POST /camps                    create direct — coordinator/admin (status=PL)
 *   PATCH /camps/:id               edit details - owner (PE/PL) or coordinator/admin
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
const { DATE_TOLERANCE_DAYS } = require('../services/donations/camp');

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
              c.attended_donor_count, c.deferred_donor_count, c.units_collected,
              c.status, c.partnered_blood_bank_id,
              i.display_name AS partnered_blood_bank_name,
              c.requested_blood_bank_id,
              rb.display_name AS requested_blood_bank_name,
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
    LEFT JOIN institutions rb ON rb.id = c.requested_blood_bank_id
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

  // Which blood bank the organiser would like to collect. A REQUEST, not an
  // assignment - see migration 315. Optional on purpose: the organiser this
  // field exists for is usually the one who has no idea, and "I don't know,
  // please arrange one" must never block a camp application.
  requested_blood_bank_id: z.string().uuid().optional(),

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

  // The picker is public, so the requested blood bank is validated here rather
  // than trusted: it must be an ACTIVE blood bank in the camp's OWN district.
  // A stale district selection would otherwise file a cross-district request
  // the admin then has to untangle, and the whole point of this field is to
  // save the admin work, not create it.
  let requestedBbName = null;
  if (d.requested_blood_bank_id) {
    const bb = await withRlsContextRaw({ actor_role: 'onboarding' }, (c) =>
      c.query(
        `SELECT display_name FROM institutions
          WHERE id = $1 AND kind = 'BB' AND onboarding_status = 'AC'
            AND is_active = TRUE AND district_id = $2`,
        [d.requested_blood_bank_id, d.district_id],
      ),
    );
    if (bb.rowCount === 0) {
      return res.status(400).json({ error: 'blood_bank_not_in_district' });
    }
    requestedBbName = bb.rows[0].display_name;
  }

  const slug = `${slugify(d.name)}-${Date.now().toString(36).slice(-5)}`;
  const qrToken = crypto.randomBytes(18).toString('base64url');

  // Optional auth. Camp hosting stays PUBLIC - a sarpanch or a principal must
  // never be pushed through a sign-in wall, let alone a clinical donor record,
  // to offer their hall. But when the applicant is already signed in we stamp
  // created_by_user_id, and that is the whole difference between a camp they
  // can open from their own profile and a camp that exists only as a magic link
  // buried in a WhatsApp thread.
  //
  // An anonymous application is not lost either: submitted_by_mobile is written
  // in both cases and GET /camps/mine keys on mobile as well, so the first time
  // that number signs in the camp is inherited with no admin action.
  //
  // Same shape as GET /camps/public/:slug - any token failure is simply
  // anonymous. An expired session must never turn a camp application into a 401.
  let ownerUserId = null;
  const applyBearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/);
  if (applyBearer) {
    try {
      ownerUserId = verifyJwtToken(applyBearer[1])?.sub || null;
    } catch {
      // Invalid / expired token - treat as an anonymous application.
    }
  }

  const created = await withRlsContextRaw(
    {
      actor_role: 'onboarding',
      actor_user_id: ownerUserId,
      change_reason: 'public camp apply',
    },
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
           review_notes, created_by_user_id,
           requested_blood_bank_id)
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
           $22, $23,
           $24)
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
          ownerUserId,
          d.requested_blood_bank_id || null,
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
    // slug so the success screen can link straight at the camp instead of
    // printing a UUID the host can do nothing with.
    slug: created.slug,
    scheduled_date: created.scheduled_date,
    status: 'PE',
    // Tells the success screen which sentence to show: "this camp is now in
    // your profile" vs "sign in with this number to track it".
    tracked_in_profile: Boolean(ownerUserId),
    // Echoed so the success screen can answer the organiser's real question —
    // who is coming to collect — instead of leaving them to wonder. null means
    // they answered "I don't know", and the NGO arranges it.
    requested_blood_bank_name: requestedBbName,
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

// ── GET /camps/mine ──────────────────────────────────────────────────────
// Every camp this person hosts, in one place, whatever created it.
//
// THE PREDICATE IS THE POINT. A person is not a session here. The same human is
// a donor row and, if they coordinate, a separate coordinator row - migrations
// 274/282 keep the OTP and staff auth clusters apart on purpose, and mobile is
// deliberately shared across them. So a camp created from the coordinator
// portal carries that person's COORDINATOR user id in created_by_user_id and
// would be invisible to their donor session if we matched on req.user.userId
// alone. Matching on every platform_users row that shares my mobile unifies the
// list without bridging the clusters, and the submitted_by_mobile arm picks up
// applications made before they had an account at all.
//
// Counts are computed live from camp_registrations rather than read from
// donation_camps' denormalised columns. Migration 313 keeps those in step now,
// but a host looking at their own camp is exactly who notices a stale number
// first, and this is a page-size query.
//
// Read-only by design: verify / decline / complete / cancel stay in the
// coordinator and admin portals, which sit behind a password + TOTP login. This
// endpoint hands back a manage_url for the magic-link organiser dashboard and
// a can_edit flag for PATCH, and nothing else.
//
// It returns every field PATCH /camps/:id accepts EXCEPT
// organiser_contact_mobile: the edit form offers that one as a blank
// "leave empty to keep the current number" box, so a stored contact number is
// never shipped out to a browser merely to be posted back unchanged.
//
// Declared BEFORE GET /:id so Express doesn't bind 'mine' to :id.
router.get('/mine', verifyJWT, async (req, res) => {
  const rows = await withRlsContextRaw(
    { actor_role: 'system', actor_user_id: req.user.userId },
    async (c) => {
      const meR = await c.query(`SELECT mobile FROM platform_users WHERE id = $1`, [
        req.user.userId,
      ]);
      // CHAR(13) holds exactly '+91##########', so there is nothing to trim -
      // but a staff row can legitimately have NULL mobile (the paired in-house
      // BB admin, see migration 269/282), and a NULL must not become a wildcard.
      const mobile = meR.rows[0]?.mobile || null;

      let userIds = [req.user.userId];
      if (mobile) {
        const sib = await c.query(`SELECT id FROM platform_users WHERE mobile = $1`, [mobile]);
        userIds = [...new Set([req.user.userId, ...sib.rows.map((r) => r.id)])];
      }

      const r = await c.query(
        `SELECT c.id, c.slug, c.name, c.status,
                to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                c.start_time, c.end_time,
                c.venue, c.address_line, c.pincode,
                c.organiser_name, c.organiser_type, c.organiser_contact_name,
                c.expected_volunteer_count, c.volunteer_training_requested,
                c.target_donor_count, c.units_collected,
                c.declined_reason, c.review_notes,
                c.community_id,
                d.name AS district_name,
                s.name AS state_name,
                i.display_name AS partnered_blood_bank_name,
                rb.display_name AS requested_blood_bank_name,
                c.scheduled_date >= CURRENT_DATE AS is_upcoming,
                reg.registered, reg.donated, reg.deferred, reg.no_show, reg.cancelled,
                don.recorded AS donations_recorded,
                tok.token AS manage_token
           FROM donation_camps c
           JOIN districts d ON d.id = c.district_id
           JOIN states s    ON s.id = c.state_id
      LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
      LEFT JOIN institutions rb ON rb.id = c.requested_blood_bank_id
      LEFT JOIN LATERAL (
             SELECT COUNT(*) FILTER (WHERE r.status <> 'CN')::int AS registered,
                    COUNT(*) FILTER (WHERE r.status = 'AT')::int  AS donated,
                    COUNT(*) FILTER (WHERE r.status = 'DF')::int  AS deferred,
                    COUNT(*) FILTER (WHERE r.status = 'NS')::int  AS no_show,
                    COUNT(*) FILTER (WHERE r.status = 'CN')::int  AS cancelled
               FROM camp_registrations r
              WHERE r.camp_id = c.id
           ) reg ON TRUE
      LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS recorded
               FROM donation_history dh
              WHERE dh.donation_camp_id = c.id
                AND dh.is_invalidated = FALSE
           ) don ON TRUE
      LEFT JOIN LATERAL (
             SELECT t.token
               FROM camp_access_tokens t
              WHERE t.camp_id = c.id
                AND t.revoked_at IS NULL
                AND t.expires_at > NOW()
              ORDER BY t.created_at DESC
              LIMIT 1
           ) tok ON TRUE
          WHERE c.created_by_user_id = ANY($1::uuid[])
             OR ($2::text IS NOT NULL AND c.submitted_by_mobile = $2)
       -- Upcoming first, soonest at the top; then the past, most recent first.
       ORDER BY (c.scheduled_date >= CURRENT_DATE) DESC,
                CASE WHEN c.scheduled_date >= CURRENT_DATE THEN c.scheduled_date END ASC,
                c.scheduled_date DESC
          LIMIT 100`,
        [userIds, mobile],
      );
      return r.rows;
    },
  );

  const base = env.frontendUrl || '';
  res.json({
    camps: rows.map(({ manage_token, ...camp }) => ({
      ...camp,
      // Editable while the camp is still an application or still ahead of the
      // NGO's verdict-and-run. A completed, cancelled or declined camp is a
      // record of what happened.
      can_edit: ['PE', 'PL'].includes(camp.status),
      // The magic link the organiser was WhatsApp'd. Surfacing it to the owner's
      // own authenticated session is the same disclosure, minus the archaeology
      // of finding the message. Null when the camp was never verified (no token
      // is minted before PE -> PL) or the token has been revoked or expired.
      manage_url: manage_token ? `${base}/camp/${manage_token}` : null,
    })),
    count: rows.length,
  });
});

// ── GET /camps/collectable ─────────────────────────────────
// Camps this blood bank may record donations against, for the date it is
// recording. This is the read side of services/donations/camp.js: same status
// set, same date tolerance, same ownership rule, so the picker never offers a
// camp the POST would reject with 409 camp_not_collectable.
//
// Declared BEFORE GET /:id so Express doesn't bind 'collectable' to :id.
//
// donations_recorded is the live COUNT over donation_history, not
// donation_camps.units_collected — the BB needs to see the batch it is part-way
// through entering, and units_collected is a hand-typed closing figure.
router.get(
  '/collectable',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
      ? req.query.date
      : new Date().toISOString().slice(0, 10);
    const bbId = req.user.institutionId || null;

    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT c.id, c.name, c.slug, c.status, c.venue,
                to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                d.name AS district_name,
                c.registered_donor_count, c.attended_donor_count,
                c.deferred_donor_count, c.units_collected,
                (SELECT COUNT(*)::int FROM donation_history dh
                  WHERE dh.donation_camp_id = c.id
                    AND dh.is_invalidated = FALSE) AS donations_recorded
           FROM donation_camps c
           JOIN districts d ON d.id = c.district_id
          WHERE c.status IN ('PL', 'LV', 'CO')
            AND ABS(c.scheduled_date - $1::date) <= $2
            AND ($3::uuid IS NULL
                 OR c.partnered_blood_bank_id = $3::uuid
                 OR c.district_id = (SELECT district_id FROM institutions WHERE id = $3::uuid))
       ORDER BY ABS(c.scheduled_date - $1::date) ASC, c.scheduled_date DESC
          LIMIT 20`,
        [date, DATE_TOLERANCE_DAYS, bbId],
      ),
    );
    res.json({ camps: r.rows, count: r.rowCount, for_date: date });
  },
);

// ── GET /camps/blood-bank-options (PUBLIC) ───────────────────────────────
// Feeds the "which blood bank should collect?" picker on the public hosting
// form, and the same picker on the admin's verify panel.
//
// Same shape as GET /requests/hospital-options (routes/requests.js) with one
// deliberate divergence: NO verifyJWT. POST /camps/apply is public by design —
// a sarpanch offering their hall is never pushed through a sign-in wall — so
// its picker cannot require a token either.
//
// What that exposes is the NAME and DISTRICT of licensed blood banks that have
// completed onboarding: public-record facts about establishments, already shown
// on the public camp page. Explicitly NOT selected: primary_contact_mobile,
// primary_contact_email, address_line (all column-encrypted PII) or
// cdsco_licence_number. No inventory, no counts, no staff. RLS is inert at
// runtime, so the WHERE clause below IS the boundary — keep it literal.
//
// Declared BEFORE GET /:id so Express doesn't bind 'blood-bank-options' to :id.
router.get('/blood-bank-options', async (req, res) => {
  const districtId = req.query.district_id ? Number(req.query.district_id) : null;
  if (req.query.district_id && !Number.isInteger(districtId)) {
    return res.status(400).json({ error: 'invalid_district_id' });
  }
  const q = String(req.query.q || '').trim();

  const r = await withRlsContextRaw({ actor_role: 'onboarding' }, (c) =>
    c.query(
      `SELECT i.id, i.display_name, i.district_id, d.name AS district_name
         FROM institutions i
    LEFT JOIN districts d ON d.id = i.district_id
        WHERE i.kind = 'BB'
          AND i.onboarding_status = 'AC'
          AND i.is_active = TRUE
          AND ($1::int IS NULL OR i.district_id = $1)
          AND ($2 = '' OR i.display_name ILIKE '%' || $2 || '%')
     ORDER BY i.display_name
        LIMIT 25`,
      [districtId, q],
    ),
  );

  // An empty list is a legitimate answer — most districts have no onboarded
  // blood bank yet — and the UI must say so rather than render a dead select.
  res.json({ blood_banks: r.rows, count: r.rowCount });
});

// ── GET /camps/:id ───────────────────────────────────────────────────────
router.get('/:id', verifyJWT, async (req, res) => {
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT c.*, d.name AS district_name,
              i.display_name AS partnered_blood_bank_name,
              rb.display_name AS requested_blood_bank_name
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
    LEFT JOIN institutions rb ON rb.id = c.requested_blood_bank_id
        WHERE c.id = $1`,
      [req.params.id],
    ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

// ── GET /camps/:id/registrations ─────────────────────────────────────────
// Roster for the admin/coord/BB panel. Returns per-donor row + a summary
// block with counts by status so the UI can render a reconciliation strip
// without re-computing client-side. Mobile is plaintext CHAR(13) —
// admin/coord/BB roles are trusted to see it (the same roles already have
// access to donor mobile via /donors/lookup). Frontend masks for display.
router.get(
  '/:id/registrations',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin', 'blood_bank'),
  async (req, res) => {
    const [regs, summary] = await Promise.all([
      withRlsContext(req, (c) =>
        c.query(
          `SELECT cr.id, cr.status, cr.registered_at, cr.status_changed_at, cr.source,
                  d.id AS donor_id, d.full_name, d.mobile, d.gender, d.date_of_birth,
                  d.blood_group_verified,
                  bg.code AS blood_group_code
             FROM camp_registrations cr
             JOIN donors d        ON d.id = cr.donor_id
        LEFT JOIN blood_groups bg ON bg.id = d.blood_group_verified
            WHERE cr.camp_id = $1
         ORDER BY cr.registered_at DESC`,
          [req.params.id],
        ),
      ),
      withRlsContext(req, (c) =>
        c.query(
          `SELECT
              COUNT(*) FILTER (WHERE status = 'RG')::int AS registered,
              COUNT(*) FILTER (WHERE status = 'AT')::int AS attended,
              COUNT(*) FILTER (WHERE status = 'NS')::int AS no_show,
              COUNT(*) FILTER (WHERE status = 'DF')::int AS deferred,
              COUNT(*) FILTER (WHERE status = 'CN')::int AS cancelled,
              COUNT(*)::int                              AS total
             FROM camp_registrations
            WHERE camp_id = $1`,
          [req.params.id],
        ),
      ),
    ]);
    openRows(regs.rows, ['full_name']); // donor name is column-encrypted at rest
    res.json({
      registrations: regs.rows,
      count: regs.rowCount,
      summary: summary.rows[0],
    });
  },
);

// ── POST /camps/:id/registrations/:regId/status (admin/coord mark) ──────
// Coord/admin/BB sets a registration to deferred / cancelled, or reverts it to
// registered. Mirrors the organizer-magic-link path
// (POST /camps/access/:token/registrations/:regId/status) but scoped to
// a JWT'd admin session — no camp_access_token required.
//
// 'AT' AND 'NS' ARE NO LONGER SETTABLE HERE. Attendance is derived: 'AT' comes
// from a donation recorded against the camp (migration 314) and 'NS' from the
// camp-close-roster job after the 48h entry grace. Both are rejected with an
// explicit 409 rather than quietly dropped from the enum — an old client, a
// bookmarked call or a test then gets told why instead of a shapeless 400.
//
// 'RG' stays settable, and is the one manual correction path there is: a
// donation attributed to the wrong camp leaves a false 'AT' behind, and
// migration 314 has no reverse trigger. Reverting to 'RG' clears it and sticks —
// the derivation only re-fires if the donation's own donation_camp_id is
// re-written, which is the other half of that correction.
const DERIVED_REG_STATUSES = {
  AT: 'a donation recorded against this camp (POST /donations with donation_camp_id)',
  NS: 'the camp-close-roster job, 48h after the camp date',
};
const markRegStatusSchema = z.object({
  status: z.enum(['RG', 'AT', 'NS', 'CN', 'DF']),
});
router.post(
  '/:id/registrations/:regId/status',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin', 'blood_bank'),
  async (req, res) => {
    const parsed = markRegStatusSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    if (DERIVED_REG_STATUSES[parsed.data.status]) {
      return res.status(409).json({
        error: 'attendance_is_derived',
        status: parsed.data.status,
        derived_from: DERIVED_REG_STATUSES[parsed.data.status],
        hint: 'Settable statuses are RG (revert), DF (came, could not donate) and CN (cancelled).',
      });
    }
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE camp_registrations
              SET status = $1,
                  status_changed_at = NOW()
            WHERE id = $2 AND camp_id = $3
        RETURNING id, status, status_changed_at`,
          [parsed.data.status, req.params.regId, req.params.id],
        ),
      { change_reason: `camp registration status → ${parsed.data.status}` },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json({ registration: r.rows[0] });
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

// ── PATCH /camps/:id (edit the details; the status is untouched) ─────────
// The camp a host applied for is the camp they will run - except halls move,
// dates slip and a contact number changes hands. Until now the only remedy was
// cancel-and-reapply, which threw the roster away with it. The organiser
// broadcast box has always suggested "Venue updated to Hall 2" as example copy:
// the platform expected venues to move and had nowhere to record it.
//
// WHO. The owner - any platform_users row on their mobile, or the mobile an
// anonymous application was made from - while the camp is still PE or PL; and
// coordinator / ngo_admin / super_admin while it is not terminal. Ownership is
// resolved exactly the way GET /camps/mine resolves it, which is what makes a
// coordinator's camp editable from their donor session and an inherited
// anonymous application editable at all.
//
// WHAT IS NOT EDITABLE. status, community_id, partnered_blood_bank_id, every
// count column and every review/verify column: those are the NGO's verdict on
// the camp, not the host's description of it. Geography FKs stay out too - a
// district change moves the camp out of its coordinator's and the DHO's scope
// and belongs in the admin surface.
//
// AND THE STATUS IS DELIBERATELY LEFT ALONE. A verified camp stays PL through a
// same-week venue correction. Sending it back to PE would un-publish a camp
// whose link donors have already been given.
const patchCampSchema = z
  .object({
    name: z.string().min(3).max(200),
    venue: z.string().min(3).max(300),
    address_line: z.string().min(5).max(500),
    pincode: z.string().regex(/^[1-9]\d{5}$/),
    scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    organiser_name: z.string().min(2).max(200),
    organiser_contact_name: z.string().min(2).max(200),
    organiser_contact_mobile: z.string().min(10).max(16),
    target_donor_count: z.number().int().min(1).max(2000),
    expected_volunteer_count: z.number().int().min(0).max(500),
    volunteer_training_requested: z.boolean(),
  })
  .partial()
  .strict();

// Changes every already-registered donor has to be told about. Somebody who
// blocked out Saturday morning and memorised a hall name must not discover the
// move at the gate. end_time is in the list as well as start_time: a window
// that closes two hours early strands the person who planned to come at noon.
const CAMP_NOTIFY_FIELDS = ['scheduled_date', 'start_time', 'end_time', 'venue', 'address_line'];

const CAMP_TERMINAL_STATUSES = ['CO', 'CA', 'DC'];

router.patch('/:id', verifyJWT, async (req, res) => {
  const parsed = patchCampSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const fields = { ...parsed.data };
  if (fields.organiser_contact_mobile !== undefined) {
    const m = normaliseIndianMobile(fields.organiser_contact_mobile);
    if (!m) return res.status(400).json({ error: 'invalid_mobile_format' });
    fields.organiser_contact_mobile = m;
  }
  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'no_fields_to_update' });
  }

  const isStaff = ['coordinator', 'ngo_admin', 'super_admin'].includes(req.user.role);

  // Settle authority before touching anything. Read under 'system' because a
  // donor-session owner has no policy of their own on donation_camps - and RLS
  // is inert at runtime regardless, so the ownership test below IS the
  // enforcement, not a convenience on top of one.
  const found = await withRlsContextRaw(
    { actor_role: 'system', actor_user_id: req.user.userId },
    async (c) => {
      const campR = await c.query(
        `SELECT c.id, c.status, c.created_by_user_id, c.submitted_by_mobile,
                c.name, c.venue, c.address_line, c.pincode,
                to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                c.start_time::text AS start_time, c.end_time::text AS end_time,
                c.organiser_name, c.organiser_contact_name,
                c.target_donor_count, c.expected_volunteer_count,
                c.volunteer_training_requested,
                to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today
           FROM donation_camps c
          WHERE c.id = $1`,
        [req.params.id],
      );
      if (campR.rowCount === 0) return null;
      const camp = campR.rows[0];
      if (isStaff) return { camp, owner: true };

      const meR = await c.query(`SELECT mobile FROM platform_users WHERE id = $1`, [
        req.user.userId,
      ]);
      // A NULL staff mobile (the paired in-house BB admin, migrations 269/282)
      // must never become a wildcard that matches every anonymous application.
      const mobile = meR.rows[0]?.mobile || null;
      let userIds = [req.user.userId];
      if (mobile) {
        const sib = await c.query(`SELECT id FROM platform_users WHERE mobile = $1`, [mobile]);
        userIds = [...new Set([req.user.userId, ...sib.rows.map((r) => r.id)])];
      }
      const owner =
        Boolean(camp.created_by_user_id && userIds.includes(camp.created_by_user_id)) ||
        Boolean(mobile && camp.submitted_by_mobile === mobile);
      return { camp, owner };
    },
  );

  if (!found) return res.status(404).json({ error: 'not_found' });
  const { camp, owner } = found;
  if (!owner) return res.status(403).json({ error: 'not_camp_owner' });

  if (CAMP_TERMINAL_STATUSES.includes(camp.status)) {
    return res.status(409).json({
      error: 'camp_not_editable',
      current_status: camp.status,
      hint: 'A completed, cancelled or declined camp is a record of what happened.',
    });
  }
  // A camp in progress is the coordinator's to correct rather than the host's:
  // donors are at the venue right now, and a mid-camp edit nobody is watching
  // the queue for does more harm than the stale field it fixes.
  if (camp.status === 'LV' && !isStaff) {
    return res.status(409).json({
      error: 'camp_not_editable',
      current_status: camp.status,
      hint: 'This camp is running. Ask your NGO coordinator to make the change.',
    });
  }
  if (fields.scheduled_date && fields.scheduled_date < camp.today) {
    return res.status(400).json({ error: 'scheduled_date_in_past', today: camp.today });
  }

  // What actually changed, so the audit reason, the review_notes line and the
  // donor message all describe the same edit. Times are compared at HH:MM: the
  // column reads back as 'HH:MM:SS' and the form sends 'HH:MM'.
  const norm = (k, v) => {
    if (v == null) return null;
    return k === 'start_time' || k === 'end_time' ? String(v).slice(0, 5) : String(v);
  };
  const changed = Object.keys(fields).filter((k) => norm(k, fields[k]) !== norm(k, camp[k]));
  if (changed.length === 0) {
    // Re-submitting an unchanged form should not append a review_notes line or
    // wake up a hundred donors.
    return res.json({
      camp: { id: camp.id, status: camp.status },
      changed_fields: [],
      notified: 0,
      unchanged: true,
    });
  }

  const diffText = changed
    .map((k) =>
      // Never write a mobile number into review_notes: it is plain TEXT that
      // every admin on the camp reads, and the number already lives in its own
      // column. Record that it changed, not what it changed to.
      k === 'organiser_contact_mobile'
        ? 'organiser_contact_mobile: updated'
        : `${k}: ${norm(k, camp[k]) ?? '(blank)'} -> ${norm(k, fields[k])}`,
    )
    .join('; ');

  // One fixed statement with COALESCE per column rather than a SET clause built
  // from the request: omitted means unchanged, no field can be cleared to NULL
  // (nothing in the UI offers that), and no user-derived text goes anywhere near
  // the SQL string - which is also what the no-restricted-syntax lint rule is
  // there to guarantee. review_notes is appended to using the same pattern as
  // POST /:id/complete.
  let updated;
  try {
    updated = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps c
              SET name = COALESCE($2::text, c.name),
                  venue = COALESCE($3::text, c.venue),
                  address_line = COALESCE($4::text, c.address_line),
                  pincode = COALESCE($5::char(6), c.pincode),
                  scheduled_date = COALESCE($6::date, c.scheduled_date),
                  start_time = COALESCE($7::time, c.start_time),
                  end_time = COALESCE($8::time, c.end_time),
                  organiser_name = COALESCE($9::text, c.organiser_name),
                  organiser_contact_name = COALESCE($10::text, c.organiser_contact_name),
                  organiser_contact_mobile =
                    COALESCE($11::char(13), c.organiser_contact_mobile),
                  target_donor_count = COALESCE($12::smallint, c.target_donor_count),
                  expected_volunteer_count =
                    COALESCE($13::smallint, c.expected_volunteer_count),
                  volunteer_training_requested =
                    COALESCE($14::boolean, c.volunteer_training_requested),
                  review_notes = COALESCE(c.review_notes, '')
                    || E'\n[edited ' || NOW()::text || ' by ' || $15::text || '] ' || $16::text
            WHERE c.id = $1
              AND c.status NOT IN ('CO', 'CA', 'DC')
        RETURNING c.id, c.slug, c.name, c.status,
                  to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                  c.start_time, c.end_time, c.venue, c.address_line, c.pincode,
                  c.organiser_name, c.organiser_contact_name,
                  c.target_donor_count, c.expected_volunteer_count,
                  c.volunteer_training_requested`,
          [
            camp.id,
            fields.name ?? null,
            fields.venue ?? null,
            fields.address_line ?? null,
            fields.pincode ?? null,
            fields.scheduled_date ?? null,
            fields.start_time ?? null,
            fields.end_time ?? null,
            fields.organiser_name ?? null,
            fields.organiser_contact_name ?? null,
            fields.organiser_contact_mobile ?? null,
            fields.target_donor_count ?? null,
            fields.expected_volunteer_count ?? null,
            fields.volunteer_training_requested ?? null,
            req.user.role,
            diffText,
          ],
        ),
      { change_reason: `camp edit: ${changed.join(', ')}` },
    );
  } catch (err) {
    // camp_time_window is the only CHECK an edit can reach. Say what to fix
    // without handing back the constraint name.
    if (err.code === '23514') {
      return res.status(409).json({
        error: 'camp_update_rejected',
        hint: 'End time must be later than start time.',
      });
    }
    throw err;
  }
  if (updated.rowCount === 0) {
    // The status moved between the read and the write.
    return res.status(409).json({ error: 'camp_not_editable', current_status: camp.status });
  }

  // Tell the donors who already said yes. Reuses CAMP_ANNC - the template the
  // organiser broadcast box already sends - so nothing stands between a moved
  // venue and the people walking to the old one except the send itself. A new
  // Meta template would have meant a 1-3 day approval wait.
  const notifyWorthy = changed.filter((k) => CAMP_NOTIFY_FIELDS.includes(k));
  let notified = 0;
  if (notifyWorthy.length > 0) {
    const c2 = updated.rows[0];
    const message = (
      `Update for the blood donation camp "${c2.name}": ` +
      `${c2.scheduled_date}, ${String(c2.start_time).slice(0, 5)}-` +
      `${String(c2.end_time).slice(0, 5)}, at ${c2.venue}. ` +
      `Please note this change.`
    ).slice(0, 480);

    const audience = await withRlsContextRaw(
      { actor_role: 'system', change_reason: 'camp edit notification prep' },
      (c) =>
        c.query(
          // 'AT'/'DF' are included for the same reason the organiser broadcast
          // includes them: on the rare edit after a camp day, the people who
          // turned up are exactly who is owed the correction.
          `SELECT donor_id FROM camp_registrations
            WHERE camp_id = $1 AND status IN ('RG', 'AT', 'DF')`,
          [camp.id],
        ),
    );

    for (const row of audience.rows) {
      try {
        await sendNotification({
          recipientId: row.donor_id,
          templateType: 'CAMP_ANNC',
          variables: { camp_id: camp.id, message },
          channel: 'WA',
          language: 'mr',
        });
        notified += 1;
      } catch (err) {
        // The edit is already committed; one unreachable number must not undo
        // it or turn a 200 into a 500.
        logger.warn({ err: err.message, donor_id: row.donor_id }, 'camp edit notify failed');
      }
    }
  }

  logger.info(
    { camp_id: camp.id, actor_user_id: req.user.userId, changed_fields: changed, notified },
    'Camp details edited',
  );

  res.json({
    camp: updated.rows[0],
    changed_fields: changed,
    notified,
    notified_for: notifyWorthy,
  });
});

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
                  -- The admin's explicit choice wins; failing that the
                  -- organiser's request is promoted rather than dropped, so
                  -- approving from an older client (or any path that omits the
                  -- field) still honours what was asked for. requested_ is left
                  -- untouched either way — it stays the record of the ask.
                  partnered_blood_bank_id = COALESCE(
                    $4::uuid, requested_blood_bank_id, partnered_blood_bank_id),
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
//
// The two metric fields are no longer plain backfills:
//
//   attended_donor_count is DERIVED (migrations 313 + 314) from donations
//   recorded against this camp, so a value written here would be overwritten by
//   the next roster event anyway. A supplied figure is therefore NOT stored - it
//   is appended to review_notes as the organiser's own headcount, because the
//   gap between "people the organiser counted" and "donations the blood bank
//   recorded" is exactly the reconciliation an admin wants to see. The request
//   still succeeds: failing a completion over a metric field would strand the
//   camp in PL.
//
//   units_collected takes GREATEST(supplied, derived). The derived count is
//   floor truth - those bags exist in blood_inventory - and a larger hand-typed
//   figure is the admin saying donations were collected that have not been
//   entered yet. Same reasoning as migration 313's backfill.
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

    const noteParts = [];
    if (notes) noteParts.push(notes);
    if (attended_donor_count != null) {
      noteParts.push(
        `organiser-reported attendance headcount: ${attended_donor_count} ` +
          `(attended_donor_count itself is derived from donations recorded against this camp)`,
      );
    }
    const noteText = noteParts.length > 0 ? noteParts.join(' · ') : null;

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps c
              SET status = 'CO',
                  units_collected = GREATEST(
                    COALESCE($1, c.units_collected, 0),
                    (SELECT COUNT(*)::int FROM donation_history dh
                      WHERE dh.donation_camp_id = c.id
                        AND dh.is_invalidated = FALSE)
                  ),
                  review_notes = CASE
                    WHEN $2::text IS NULL THEN c.review_notes
                    ELSE COALESCE(c.review_notes,'') || E'\n[completed ' || NOW()::text || '] ' || $2::text
                  END
            WHERE c.id = $3
              AND c.status IN ('PL','LV')
              AND c.scheduled_date <= CURRENT_DATE
        RETURNING c.id, c.status, c.scheduled_date, c.attended_donor_count,
                  c.deferred_donor_count, c.units_collected`,
          [units_collected ?? null, noteText, req.params.id],
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
    res.json({
      camp: r.rows[0],
      // Told plainly rather than leaving the admin to wonder why the attendance
      // number they typed is not the number that came back.
      attendance_is_derived: true,
      attended_headcount_recorded_in_notes: attended_donor_count != null,
    });
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
                  c.attended_donor_count, c.deferred_donor_count, c.units_collected,
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
// The desk, on camp day, from a no-login magic-link session. Two things it can
// say about a donor in front of it, and neither is attendance:
//
//   DF  came and could not donate (turned away at screening). Routinely 10-15%
//       of a roster, and the single most useful number an organiser gets — it
//       separates "my mobilisation failed" from "my pre-screening messaging
//       did". NO REASON IS ACCEPTED: why someone was deferred is clinical PII
//       and belongs to the blood bank's donor_screening record, not to a
//       free-text field reachable from a URL in a WhatsApp message.
//   CN  cancelled — they told the organiser they are not coming.
//   RG  undo either of the above.
//
// AT and NS are derived and rejected with 409 attendance_is_derived, same as the
// JWT'd path. The desk no longer ticks attendance at all: the blood bank
// recording the donation is what fills the roster, and that is a fact rather
// than whoever was holding the tablet at the busiest moment of the day.
router.post('/access/:token/registrations/:regId/status', async (req, res) => {
  const schema = z.object({ status: z.enum(['AT', 'NS', 'RG', 'DF', 'CN']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  if (DERIVED_REG_STATUSES[parsed.data.status]) {
    return res.status(409).json({
      error: 'attendance_is_derived',
      status: parsed.data.status,
      derived_from: DERIVED_REG_STATUSES[parsed.data.status],
      hint: 'The desk records DF (came, could not donate), CN (cancelled) or RG (undo).',
    });
  }

  const v = await loadToken(req.params.token);
  if (!v.ok) return res.status(403).json({ error: v.reason });

  const r = await withRlsContextRaw(
    {
      actor_role: 'camp_organizer',
      actor_system_process: `camp:${v.token.token.slice(0, 12)}`,
      camp_token: v.token.token,
      actor_ip_address: cleanClientIp(req),
      change_reason: `organizer sets registration → ${parsed.data.status}`,
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
        // 'DF' included: someone turned away at screening still came, and a
        // post-camp broadcast ("thank you", "next camp is on the 14th") is
        // exactly the message they should get. Only 'CN' and 'NS' are excluded.
        `SELECT donor_id FROM camp_registrations
          WHERE camp_id = $1 AND status IN ('RG', 'AT', 'DF')`,
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

      // A camp has to actually be open before anyone can RSVP to it. Without
      // this the endpoint accepted registrations for completed, cancelled and
      // declined camps and for camps whose date had passed - inflating a closed
      // camp's roster and enrolling a donor in something that will never happen.
      // 'PE' is excluded on purpose: an unreviewed public application is not a
      // published camp.
      const campR = await c.query(
        `SELECT status, to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                scheduled_date < CURRENT_DATE AS date_passed
           FROM donation_camps WHERE id = $1`,
        [req.params.id],
      );
      if (campR.rowCount === 0) {
        throw Object.assign(new Error('camp_not_found'), { status: 404 });
      }
      const camp = campR.rows[0];
      if (!['PL', 'LV'].includes(camp.status) || camp.date_passed) {
        throw Object.assign(new Error('camp_not_open_for_registration'), {
          status: 409,
          detail: {
            status: camp.status,
            scheduled_date: camp.scheduled_date,
            reason: camp.date_passed ? 'camp_date_passed' : 'camp_status',
          },
        });
      }

      // The conflict clause used to reset ANY existing row to 'RG'. Now that
      // attendance derives from the donation record (migration 314), a donor
      // tapping Register again after donating would have erased it - so only a
      // cancellation can be revived here. An existing 'RG' falls through to the
      // idempotent read below; 'AT'/'DF'/'NS' are reported back rather than
      // silently rewritten.
      const r = await c.query(
        `INSERT INTO camp_registrations (camp_id, donor_id, source, referral_channel)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (camp_id, donor_id) DO UPDATE
            SET status = 'RG',
                status_changed_at = clock_timestamp(),
                referral_channel = COALESCE(camp_registrations.referral_channel, EXCLUDED.referral_channel)
          WHERE camp_registrations.status = 'CN'
         RETURNING id, status, registered_at`,
        [req.params.id, donorId, source, channel],
      );
      if (r.rowCount > 0) return r.rows[0];

      // Nothing inserted and nothing updated means a row exists that the WHERE
      // refused to touch.
      const existing = await c.query(
        `SELECT id, status, registered_at FROM camp_registrations
          WHERE camp_id = $1 AND donor_id = $2`,
        [req.params.id, donorId],
      );
      if (existing.rowCount === 0) {
        throw Object.assign(new Error('registration_failed'), { status: 409 });
      }
      if (existing.rows[0].status !== 'RG') {
        throw Object.assign(new Error('already_recorded'), {
          status: 409,
          detail: { status: existing.rows[0].status },
        });
      }
      return existing.rows[0]; // already registered - idempotent
    },
    { change_reason: 'donor RSVP to camp' },
  );
  res.status(201).json(result);
});

// ── DELETE /camps/:id/register (donor cancels) ───────────────────────────
router.delete('/:id/register', verifyJWT, requireRole('donor'), async (req, res) => {
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

      // Was a hard DELETE, which made migration 260's 'CN' dead code, lost the
      // fact that the donor had ever signed up (so the referral attribution and
      // the organiser's "12 cancelled" signal vanished with it), and - now that
      // attendance derives from the donation record - let a donor erase their
      // own 'AT'.
      const r = await c.query(
        `UPDATE camp_registrations
            SET status = 'CN', status_changed_at = clock_timestamp()
          WHERE camp_id = $1 AND donor_id = $2 AND status = 'RG'
        RETURNING id`,
        [req.params.id, donorId],
      );
      if (r.rowCount > 0) return { cancelled: true };

      const existing = await c.query(
        `SELECT status FROM camp_registrations WHERE camp_id = $1 AND donor_id = $2`,
        [req.params.id, donorId],
      );
      if (existing.rowCount === 0) return { cancelled: false, reason: 'not_registered' };
      const st = existing.rows[0].status;
      // Attendance is a record of what happened, not a preference. A donor who
      // donated, or came and was turned away, cannot withdraw it - and doing so
      // would take the camp's derived counts down with it.
      if (st === 'AT' || st === 'DF') {
        throw Object.assign(new Error('cannot_cancel_after_attendance'), {
          status: 409,
          detail: { status: st },
        });
      }
      if (st === 'CN') return { cancelled: true }; // already cancelled - idempotent
      return { cancelled: false, reason: 'not_cancellable', status: st }; // 'NS'
    },
    { change_reason: 'donor cancels camp RSVP' },
  );
  res.json(result);
});

module.exports = router;
