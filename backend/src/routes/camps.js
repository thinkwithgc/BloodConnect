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
 *   GET  /camps/bb-availability    PUBLIC — one blood bank's published camp
 *                                  capacity, per day (counts only)
 *   GET/PUT /camps/bb/settings     blood bank's standing camp posture
 *   GET/PUT /camps/bb/capacity     per-day capacity + live occupancy
 *   POST /camps/bb/capacity/publish-month
 *                                  generate a month from the settings template
 *   GET  /camps/bb/camps           this blood bank's camps, any status
 *   POST /camps/:id/bb-response    the partnered BB accepts or declines
 *   GET  /camps/:id/donations      post-camp results worklist (masked mobile)
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
const { normaliseIndianMobile, maskMobile } = require('../utils/phone');
const { openRows } = require('../services/pii');
const { sendNotification } = require('../services/notifications');
const { DATE_TOLERANCE_DAYS } = require('../services/donations/camp');
const capacity = require('../services/camps/capacity');

// Who may see a camp's submitter PII and the NGO's internal review text.
// Shared by GET /camps and GET /camps/:id so the two can never disagree about
// what a donor or a blood bank is allowed to read.
const CAMP_REVIEWER_ROLES = ['ngo_admin', 'super_admin', 'coordinator'];
const CAMP_SUBMITTER_KEYS = [
  'submitted_by_name',
  'submitted_by_mobile',
  'submitted_by_email',
  'submitted_by_role',
];

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
//   ?branding=pending  camps whose organiser branding is awaiting review.
//                   Like bb_declined this is not necessarily in the future, so
//                   it escapes the default window too.
//   ?stale=true     "PL or LV" camps whose scheduled_date is at least a
//                   day in the past — these are the ones the admin needs
//                   to complete-or-cancel. 1-day grace so a same-day camp
//                   that's still being wound up isn't nagged.
router.get('/', verifyJWT, async (req, res) => {
  const districtId = req.query.district_id ? Number(req.query.district_id) : null;
  const status = req.query.status || null;
  const stale = req.query.stale === 'true';
  // The reassignment queue: camps whose partnered blood bank said no. These need
  // an admin to find another BB, and unlike `stale` they are not necessarily in
  // the past, so the filter has to escape the default future-only window too.
  const bbDeclined = req.query.bb_declined === 'true';
  const brandingPending = req.query.branding === 'pending';
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
              c.bb_response, c.bb_response_at,
              c.bb_decline_reason, c.bb_decline_note,
              i.display_name AS partnered_blood_bank_name,
              c.requested_blood_bank_id,
              rb.display_name AS requested_blood_bank_name,
              c.submitted_by_name, c.submitted_by_mobile,
              c.submitted_by_email, c.submitted_by_role,
              c.volunteer_training_requested, c.expected_volunteer_count,
              c.review_notes, c.declined_reason, c.cancelled_reason,
              c.verified_at, c.declined_at,
              -- Status only. logo_data_uri is NEVER selected here: 50 camps x
              -- ~67 KB of base64 is a 3 MB list payload. The bytes are on the
              -- detail route, which is where a review actually happens.
              c.branding_status,
              (c.status IN ('PL','LV')
                 AND c.scheduled_date < CURRENT_DATE - INTERVAL '1 day') AS is_stale
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
    LEFT JOIN institutions rb ON rb.id = c.requested_blood_bank_id
        WHERE ($1::int  IS NULL OR c.district_id = $1)
          AND ($2::text IS NULL OR c.status = $2)
          AND ($3::boolean IS TRUE
                 OR $4::boolean IS TRUE
                 OR $5::boolean IS TRUE
                 OR $2::text IS NOT NULL
                 OR (c.status IN ('PL','LV') AND c.scheduled_date >= CURRENT_DATE))
          AND ($3::boolean IS NOT TRUE
                 OR (c.status IN ('PL','LV')
                     AND c.scheduled_date < CURRENT_DATE - INTERVAL '1 day'))
          AND ($4::boolean IS NOT TRUE OR c.bb_response = 'DC')
          AND ($5::boolean IS NOT TRUE OR c.branding_status = 'PE')
     ORDER BY c.scheduled_date ASC, c.start_time ASC
        LIMIT 100`,
      [districtId, status, stale, bbDeclined, brandingPending],
    ),
  );

  // Non-reviewers (donors, hospitals, blood banks) never see the submitter
  // PII. The columns above are returned for the SQL convenience of a single
  // query; we redact them per-row before sending the response.
  const REDACT_KEYS = [
    ...CAMP_SUBMITTER_KEYS,
    'review_notes',
    'declined_reason',
    'bb_decline_reason',
    'bb_decline_note',
    'bb_response',
    'bb_response_at',
    'branding_status',
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
  let autoAcceptBb = false;
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

    // ── The capacity gate (migration 316) ────────────────────────────────
    //
    // The BB has published how many camps it can staff that day. If that day
    // is full, say so NOW — before a camp row exists — and hand back the days
    // it can still serve. A 409 with alternatives is a form the organiser can
    // finish; a filed camp that the BB later declines is three phone calls.
    //
    //   ⚠ ONLY A PUBLISHED, FULL DAY BLOCKS.
    //   A day with no capacity row is unpublished, never closed (316 header) —
    //   on the day this ships that is every day for every BB, and blocking
    //   there would stop camp hosting platform-wide. capacity.js encodes this
    //   as ok:true, so this reads `slot.ok` and never `max_camps`.
    //
    // Only `confirmed` (verified camps this BB is on the hook for) blocks.
    // Pending applications are surfaced on the BB's own calendar and never
    // gate, or one abandoned form would hold a day hostage.
    //
    // The NGO admin can still overbook at verify — they are the bridge, and an
    // emergency is exactly when a rule like this must yield to a person.
    const slot = await withRlsContextRaw({ actor_role: 'system' }, async (c) => {
      const day = await capacity.checkSlot(c, d.requested_blood_bank_id, d.scheduled_date);
      if (!day.ok) {
        day.next_open_dates = await capacity.nextOpenDates(
          c,
          d.requested_blood_bank_id,
          d.scheduled_date,
        );
        return day;
      }
      const s = await c.query(
        `SELECT auto_accept_within_capacity FROM bb_camp_settings WHERE blood_bank_id = $1`,
        [d.requested_blood_bank_id],
      );
      day.auto_accept = day.published && s.rows[0]?.auto_accept_within_capacity === true;
      return day;
    });

    if (!slot.ok) {
      return res.status(409).json({
        error: 'blood_bank_day_full',
        blood_bank_name: requestedBbName,
        scheduled_date: d.scheduled_date,
        max_camps: slot.max_camps,
        confirmed: slot.confirmed,
        // Actionable, not just a refusal. Published non-full days only — see
        // capacity.nextOpenDates.
        next_open_dates: slot.next_open_dates || [],
      });
    }

    // auto_accept_within_capacity: the BB has said in advance that anything
    // inside published capacity is a yes. Promote request → partner and stamp
    // 'AC' at apply time, leaving bb_response_by NULL — this is a standing
    // policy, not a person's click, and recording a user here would put a name
    // on a decision nobody made today.
    autoAcceptBb = slot.auto_accept === true;
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
           requested_blood_bank_id,
           partnered_blood_bank_id, bb_response, bb_response_at)
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
           $24,
           -- Only auto-accept writes a partner here. Otherwise the NGO admin's
           -- verify is what promotes requested → partnered, and 317's
           -- bb_response_needs_partner CHECK keeps bb_response NULL until then.
           -- Both casts are load-bearing: $26 appears twice, and without them
           -- Postgres cannot infer a type for the IS NULL use and rejects the
           -- statement outright ("could not determine data type of parameter").
           $25::uuid, $26::char(2),
           CASE WHEN $26::char(2) IS NULL THEN NULL ELSE clock_timestamp() END)
         RETURNING id, name, slug, scheduled_date, status,
                   partnered_blood_bank_id, bb_response`,
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
          autoAcceptBb ? d.requested_blood_bank_id : null,
          autoAcceptBb ? 'AC' : null,
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
    // 'AC' here means the BB pre-approved this day, so the success screen can
    // say "confirmed to collect" instead of "we'll arrange it". Absent unless
    // that BB opted into auto-accept.
    bb_response: created.bb_response || null,
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
              -- THE APPROVAL GATE, IN SQL ON PURPOSE (migration 319).
              -- Organiser-supplied branding is invisible to the public until an
              -- NGO admin approves it. Gating here rather than in JS means a
              -- future caller physically cannot forget it, and there is exactly
              -- one place to audit. 'PE' and 'RJ' both render as no branding.
              CASE WHEN c.branding_status = 'AP' THEN bl.logo_data_uri END
                AS logo_data_uri,
              CASE WHEN c.branding_status = 'AP' THEN c.organiser_tagline END
                AS organiser_tagline,
              d.name AS district_name,
              s.name AS state_name,
              i.display_name AS partnered_blood_bank_name
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
         JOIN states s    ON s.id = c.state_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
    LEFT JOIN camp_branding_logo bl ON bl.camp_id = c.id
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
                -- The blood bank's own answer (migration 317). The organiser is
                -- told a replacement is being arranged; bb_decline_reason and
                -- bb_decline_note are deliberately NOT selected here — 317's
                -- column comment reserves those for the NGO admin.
                c.bb_response,
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

// ═════════════════════════════════════════════════════════════════════════
// Blood-bank camp capacity (migrations 316 + 317)
//
// A blood bank publishes, in advance, how many camps it can staff per day.
// That single act pre-answers the question that generates every phone call
// between an organiser, the NGO admin and the blood bank — "can you do the
// 14th?" — and reduces the per-camp accept/decline below to an exception path.
//
// ⚠ EVERY literal path in this block is declared BEFORE GET /:id or Express
// binds it to the :id param. Same hazard as apply / mine / collectable /
// blood-bank-options above.
//
// ⚠ RLS IS INERT AT RUNTIME (the app connects as a BYPASSRLS owner; app_user is
// NOLOGIN). The `WHERE blood_bank_id = <resolved target>` in each handler below
// IS the security boundary, not migration 316's policies.
// ═════════════════════════════════════════════════════════════════════════

// Longest window any capacity read will serve. A month grid needs ~31 days and
// the hosting form's availability strip needs a quarter at the outside; beyond
// that this is somebody enumerating an institution's schedule.
const CAPACITY_MAX_DAYS = 92;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Resolve WHOSE capacity a request is about.
//
// For a blood_bank caller the answer is always its own institution, and any
// blood_bank_id in the query string is IGNORED — that is precisely the boundary,
// so it is resolved here once rather than trusted per handler.
//
// ngo_admin / super_admin MUST name a blood bank explicitly. On the day this
// ships no BB has published anything, and the admin is the bridge between
// organiser and blood bank, so bootstrapping capacity on a BB's behalf is a
// first-class action rather than a back door.
function resolveBbTarget(req) {
  if (req.user.role === 'blood_bank') {
    if (!req.user.institutionId) return { error: 'no_institution_on_session' };
    return { bbId: req.user.institutionId, onBehalf: false };
  }
  const asked = req.query.blood_bank_id || (req.body && req.body.blood_bank_id);
  if (!asked) return { error: 'blood_bank_id_required' };
  if (!/^[0-9a-f-]{36}$/i.test(String(asked))) return { error: 'invalid_blood_bank_id' };
  return { bbId: String(asked), onBehalf: true };
}

// from/to with defaults (today → +30d) and a hard span cap.
function parseRange(req) {
  const today = capacity.toIsoDate(new Date());
  const from = req.query.from ? String(req.query.from) : today;
  if (!ISO_DATE.test(from)) return { error: 'invalid_from' };
  let to = req.query.to ? String(req.query.to) : null;
  if (to && !ISO_DATE.test(to)) return { error: 'invalid_to' };
  if (!to) {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 30);
    to = d.toISOString().slice(0, 10);
  }
  if (to < from) return { error: 'range_inverted' };
  const span = capacity.datesBetween(from, to).length;
  if (span > CAPACITY_MAX_DAYS) return { error: 'range_too_wide', max_days: CAPACITY_MAX_DAYS };
  return { from, to };
}

// ── GET /camps/bb-availability (PUBLIC) ──────────────────────────────────
// The calendar an organiser sees while choosing a date on the public hosting
// form, before they have committed to anything.
//
// COUNTS AND NOTHING ELSE. Never a camp id, name, venue, organiser, target or
// note — a note can name a person ("2 techs on leave") and is deliberately
// dropped here even though the BB's own calendar shows it. What this does
// expose is one licensed establishment's schedule density, which is the same
// class of public-record fact already on PublicCampPage.
//
// No verifyJWT, matching GET /camps/blood-bank-options: POST /camps/apply is
// public by design, so its availability strip cannot require a token either.
// Left under the global 100/min IP limiter and deliberately NOT added to
// app.js's CAMP_EXEMPT_PATHS — that exemption exists for 40 donors bursting
// through one camp-WiFi NAT; this is one host loading one calendar.
router.get('/bb-availability', async (req, res) => {
  const bbId = String(req.query.blood_bank_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(bbId)) {
    return res.status(400).json({ error: 'invalid_blood_bank_id' });
  }
  const range = parseRange(req);
  if (range.error) return res.status(400).json(range);

  const out = await withRlsContextRaw({ actor_role: 'onboarding' }, async (c) => {
    // Confirm the blood bank is one the public picker would have offered in the
    // first place. Without this, the endpoint answers for any UUID — including
    // hospitals and archived institutions — and turns into an existence oracle.
    const bb = await c.query(
      `SELECT id, display_name FROM institutions
        WHERE id = $1 AND kind = 'BB' AND onboarding_status = 'AC' AND is_active = TRUE`,
      [bbId],
    );
    if (bb.rowCount === 0) return null;

    const days = await capacity.occupancyFor(c, bbId, range.from, range.to);
    return {
      blood_bank_id: bbId,
      blood_bank_name: bb.rows[0].display_name,
      from: range.from,
      to: range.to,
      // Gaps filled, so the strip renders a continuous run of days. An
      // unpublished day carries published:false and ok:true — it looks normal,
      // because it IS normal: absence of capacity is "not planned", not
      // "closed" (see migration 316's header).
      days: capacity.datesBetween(range.from, range.to).map((date) => {
        const d = capacity.dayOrEmpty(days, date);
        return {
          date: d.date,
          published: d.published,
          max_camps: d.max_camps,
          confirmed: d.confirmed,
          pending: d.pending,
          slots_left: d.slots_left,
          ok: d.ok,
        };
      }),
    };
  });

  if (!out) return res.status(404).json({ error: 'blood_bank_not_found' });
  res.json(out);
});

// ── GET /camps/bb/settings ───────────────────────────────────────────────
// The BB's standing posture: headcount arithmetic, the publish-month template,
// and whether it auto-accepts inside published capacity.
router.get(
  '/bb/settings',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const t = resolveBbTarget(req);
    if (t.error) return res.status(400).json({ error: t.error });

    const r = await withRlsContext(req, (c) =>
      c.query(`SELECT * FROM bb_camp_settings WHERE blood_bank_id = $1`, [t.bbId]),
    );
    // No row is a legitimate state, not a 404: a BB that has never opened this
    // tab has no settings, and the UI must render defaults rather than an error.
    const settings = r.rows[0] || null;
    res.json({
      blood_bank_id: t.bbId,
      settings,
      suggested_max_camps: capacity.suggestedMaxCamps(settings),
    });
  },
);

// ── PUT /camps/bb/settings ───────────────────────────────────────────────
const bbSettingsSchema = z.object({
  staff_total: z.number().int().min(0).max(500).nullable().optional(),
  staff_per_camp: z.number().int().min(1).max(100).nullable().optional(),
  default_max_camps: z.number().int().min(0).max(20).optional(),
  // ISO dow, 0 = Sunday. A template for publish-month, never a live gate.
  weekly_closed_days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  auto_accept_within_capacity: z.boolean().optional(),
  blood_bank_id: z.string().uuid().optional(), // admin-on-behalf; ignored for BB
});
router.put(
  '/bb/settings',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = bbSettingsSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const t = resolveBbTarget(req);
    if (t.error) return res.status(400).json({ error: t.error });
    const d = parsed.data;

    const out = await withRlsContext(
      req,
      async (c) => {
        // Upsert with COALESCE on every optional field so a partial PUT from
        // one half of the settings form cannot blank the other half. Explicit
        // null on staff_total / staff_per_camp is therefore "leave it" rather
        // than "clear it" — clearing headcount is not a thing the UI offers,
        // and silently wiping it on a partial save would be worse.
        const r = await c.query(
          `INSERT INTO bb_camp_settings (
             blood_bank_id, staff_total, staff_per_camp, default_max_camps,
             weekly_closed_days, auto_accept_within_capacity, updated_by_user_id)
           VALUES ($1, $2, $3, COALESCE($4, 1), COALESCE($5::smallint[], '{}'),
                   COALESCE($6, FALSE), $7)
           ON CONFLICT (blood_bank_id) DO UPDATE SET
             staff_total        = COALESCE($2, bb_camp_settings.staff_total),
             staff_per_camp     = COALESCE($3, bb_camp_settings.staff_per_camp),
             default_max_camps  = COALESCE($4, bb_camp_settings.default_max_camps),
             weekly_closed_days = COALESCE($5::smallint[], bb_camp_settings.weekly_closed_days),
             auto_accept_within_capacity =
               COALESCE($6, bb_camp_settings.auto_accept_within_capacity),
             updated_by_user_id = $7,
             updated_at         = clock_timestamp()
           RETURNING *`,
          [
            t.bbId,
            d.staff_total ?? null,
            d.staff_per_camp ?? null,
            d.default_max_camps ?? null,
            d.weekly_closed_days ?? null,
            d.auto_accept_within_capacity ?? null,
            req.user.userId,
          ],
        );
        return r.rows[0];
      },
      { change_reason: 'update bb camp settings' },
    );

    res.json({ settings: out, suggested_max_camps: capacity.suggestedMaxCamps(out) });
  },
);

// ── GET /camps/bb/capacity ───────────────────────────────────────────────
// The month grid the BB reads: published capacity joined with live occupancy,
// one row per day, gaps filled. Same numbers the booking gate uses, from the
// same service function — that is the whole point of services/camps/capacity.js.
router.get(
  '/bb/capacity',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const t = resolveBbTarget(req);
    if (t.error) return res.status(400).json({ error: t.error });
    const range = parseRange(req);
    if (range.error) return res.status(400).json(range);

    const out = await withRlsContext(req, async (c) => {
      const s = await c.query(`SELECT * FROM bb_camp_settings WHERE blood_bank_id = $1`, [t.bbId]);
      const days = await capacity.occupancyFor(c, t.bbId, range.from, range.to);
      return {
        settings: s.rows[0] || null,
        suggested_max_camps: capacity.suggestedMaxCamps(s.rows[0]),
        days: capacity
          .datesBetween(range.from, range.to)
          .map((date) => capacity.dayOrEmpty(days, date)),
      };
    });

    res.json({ blood_bank_id: t.bbId, from: range.from, to: range.to, ...out });
  },
);

// ── PUT /camps/bb/capacity ───────────────────────────────────────────────
// A whole month of edits in one request. The calendar UI is a grid the BB
// clicks around in; sending one request per cell would make a half-saved month
// the normal outcome of a flaky camp-WiFi connection.
const bbCapacityDaySchema = z.object({
  date: z.string().regex(ISO_DATE),
  // null = WITHDRAW the day back to unpublished. 0 = a published holiday.
  // These are different states and the UI needs both: 0 tells an organiser
  // "closed that day", null is the only undo for an accidental publish.
  max_camps: z.number().int().min(0).max(20).nullable(),
  staff_committed: z.number().int().min(0).max(500).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});
const bbCapacitySchema = z.object({
  days: z.array(bbCapacityDaySchema).min(1).max(CAPACITY_MAX_DAYS),
  blood_bank_id: z.string().uuid().optional(), // admin-on-behalf
});
router.put(
  '/bb/capacity',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = bbCapacitySchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const t = resolveBbTarget(req);
    if (t.error) return res.status(400).json({ error: t.error });

    // One date twice in one payload is a UI bug, and letting it through means
    // the last write silently wins. Say so instead.
    const seen = new Set();
    for (const d of parsed.data.days) {
      if (seen.has(d.date)) {
        return res.status(400).json({ error: 'duplicate_date', date: d.date });
      }
      seen.add(d.date);
    }

    const out = await withRlsContext(
      req,
      async (c) => {
        let written = 0;
        let removed = 0;
        for (const d of parsed.data.days) {
          if (d.max_camps === null) {
            const r = await c.query(
              `DELETE FROM bb_camp_capacity
                WHERE blood_bank_id = $1 AND capacity_date = $2::date`,
              [t.bbId, d.date],
            );
            removed += r.rowCount;
            continue;
          }
          await c.query(
            `INSERT INTO bb_camp_capacity (
               blood_bank_id, capacity_date, max_camps, staff_committed, note, set_by_user_id)
             VALUES ($1, $2::date, $3, $4, $5, $6)
             ON CONFLICT (blood_bank_id, capacity_date) DO UPDATE SET
               max_camps       = $3,
               staff_committed = $4,
               note            = $5,
               set_by_user_id  = $6,
               updated_at      = clock_timestamp()`,
            [
              t.bbId,
              d.date,
              d.max_camps,
              d.staff_committed ?? null,
              d.note ?? null,
              req.user.userId,
            ],
          );
          written += 1;
        }
        return { written, removed };
      },
      { change_reason: 'set bb camp capacity' },
    );

    logger.info(
      { blood_bank_id: t.bbId, ...out, on_behalf: t.onBehalf },
      'bb camp capacity updated',
    );
    res.json({ blood_bank_id: t.bbId, ...out });
  },
);

// ── POST /camps/bb/capacity/publish-month ────────────────────────────────
// "Plan the month" — one click turns default_max_camps + weekly_closed_days
// into a month of rows.
//
// ⚠ NEVER OVERWRITES A DAY THAT ALREADY HAS A ROW (ON CONFLICT DO NOTHING).
// A BB that closed the 12th–15th for Diwali and then hits Plan the month again
// must not silently reopen them. Re-publishing is additive by construction.
router.post(
  '/bb/capacity/publish-month',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const month = String((req.body && req.body.month) || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'invalid_month', expected: 'YYYY-MM' });
    }
    const t = resolveBbTarget(req);
    if (t.error) return res.status(400).json({ error: t.error });

    const today = capacity.toIsoDate(new Date());
    const monthStart = `${month}-01`;
    // Clamp to today: publishing capacity for days that have already passed
    // creates rows nothing will ever read, and makes the "already published"
    // count on the calendar header lie.
    const from = monthStart > today ? monthStart : today;

    const out = await withRlsContext(
      req,
      async (c) => {
        const s = await c.query(
          `SELECT default_max_camps, weekly_closed_days
             FROM bb_camp_settings WHERE blood_bank_id = $1`,
          [t.bbId],
        );
        // No settings row means nothing to template from. A silent 0-row
        // success here would read on the calendar as "the month is planned".
        if (!s.rows.length) {
          throw Object.assign(new Error('settings_not_set'), { status: 409 });
        }
        const { default_max_camps, weekly_closed_days } = s.rows[0];

        const r = await c.query(
          `INSERT INTO bb_camp_capacity (
             blood_bank_id, capacity_date, max_camps, set_by_user_id)
           SELECT $1, d::date,
                  CASE WHEN EXTRACT(DOW FROM d)::smallint = ANY($4::smallint[])
                       THEN 0 ELSE $5 END,
                  $6
             FROM generate_series(
                    $2::date,
                    (date_trunc('month', $3::date) + INTERVAL '1 month - 1 day')::date,
                    INTERVAL '1 day') AS d
           ON CONFLICT (blood_bank_id, capacity_date) DO NOTHING
           RETURNING capacity_date, max_camps`,
          [t.bbId, from, monthStart, weekly_closed_days || [], default_max_camps, req.user.userId],
        );
        return { created: r.rowCount, default_max_camps, weekly_closed_days };
      },
      { change_reason: `publish camp capacity for ${month}` },
    );

    res.json({ blood_bank_id: t.bbId, month, from, ...out });
  },
);

// ── GET /camps/bb/camps ──────────────────────────────────────────────────
// This blood bank's camps at ANY status, partnered OR requested-to-me.
//
// GET /camps cannot express this: it defaults to future PL/LV only, and it has
// no notion of "a camp that named me but nobody has verified yet" — which is
// precisely the queue the BB needs to answer. GET /camps/collectable cannot
// either: it is date-centred (±DATE_TOLERANCE_DAYS around one day) and includes
// every camp in the district, partnered or not.
//
// ⚠ ORGANISER CONTACT IS REVEALED ONLY AFTER THIS BB HAS ACCEPTED.
// While bb_response is 'PE' (or NULL), submitted_by_name / submitted_by_mobile
// are stripped — a BB deciding whether to take a camp does not need the host's
// number, and a request it may decline is not consent to their contact details.
// Once it sets 'AC' it needs them: gate access, table space, power on the day.
// Fetching that number from the NGO admin is one of the phone calls this whole
// feature exists to delete.
router.get(
  '/bb/camps',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const t = resolveBbTarget(req);
    if (t.error) return res.status(400).json({ error: t.error });
    const range = parseRange(req);
    if (range.error) return res.status(400).json(range);
    const pendingOnly = req.query.pending === 'true';

    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT c.id, c.name, c.slug, c.status, c.venue, c.address_line,
                to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                c.start_time, c.end_time,
                c.organiser_type, c.organiser_name,
                c.target_donor_count,
                c.registered_donor_count, c.attended_donor_count,
                c.deferred_donor_count, c.units_collected,
                c.bb_response, c.bb_response_at,
                c.bb_decline_reason, c.bb_decline_note,
                c.partnered_blood_bank_id, c.requested_blood_bank_id,
                c.submitted_by_name, c.submitted_by_mobile,
                d.name AS district_name, tk.name AS taluka_name,
                (SELECT COUNT(*)::int FROM donation_history dh
                  WHERE dh.donation_camp_id = c.id
                    AND dh.is_invalidated = FALSE) AS donations_recorded
           FROM donation_camps c
           JOIN districts d ON d.id = c.district_id
      LEFT JOIN talukas tk ON tk.id = c.taluka_id
          WHERE (c.partnered_blood_bank_id = $1 OR c.requested_blood_bank_id = $1)
            AND c.scheduled_date BETWEEN $2::date AND $3::date
            AND ($4 = FALSE OR c.bb_response IS NULL OR c.bb_response = 'PE')
       ORDER BY c.scheduled_date ASC, c.name ASC
          LIMIT 200`,
        [t.bbId, range.from, range.to, pendingOnly],
      ),
    );

    // Redact in the application layer rather than in SQL: the condition is
    // per-row, and a CASE expression repeated across two columns is one edit
    // away from disagreeing with itself.
    const camps = r.rows.map((row) => {
      if (row.bb_response === 'AC') return row;
      return { ...row, submitted_by_name: undefined, submitted_by_mobile: undefined };
    });

    res.json({
      blood_bank_id: t.bbId,
      from: range.from,
      to: range.to,
      camps,
      count: camps.length,
      awaiting_response: camps.filter((x) => !x.bb_response || x.bb_response === 'PE').length,
    });
  },
);

// ── POST /camps/:id/bb-response ──────────────────────────────────────────
// The partnered blood bank's answer. blood_bank ONLY: an admin clicking accept
// on a BB's behalf would put words in its mouth, and the whole point of this
// column is that the answer came from the party that has to staff the day.
//
// ⚠ NEVER TOUCHES status. The NGO's PE → PL gate is independent, so BB
// acceptance and NGO verification can happen in either order.
//
// ⚠ A DECLINE DOES NOT CLEAR partnered_blood_bank_id. The camp is still
// happening — possibly with 200 donors already RSVP'd — and clearing the
// partner would erase who declined and silently return the camp to "nobody
// asked yet", which is the state the admin most needs to tell it apart from.
const bbResponseSchema = z
  .object({
    response: z.enum(['AC', 'DC']),
    decline_reason: z.enum(['NC', 'ND', 'DT', 'VE', 'OT']).optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((v) => v.response !== 'DC' || !!v.decline_reason, {
    message: 'decline_reason is required when declining',
    path: ['decline_reason'],
  });

router.post('/:id/bb-response', verifyJWT, requireRole('blood_bank'), async (req, res) => {
  const parsed = bbResponseSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  if (!req.user.institutionId) {
    return res.status(400).json({ error: 'no_institution_on_session' });
  }
  const { response, decline_reason, note } = parsed.data;

  const result = await withRlsContext(
    req,
    async (c) => {
      // partnered_blood_bank_id = $2 IS the security boundary (RLS is inert at
      // runtime). It is also the business rule: only the BB actually on the
      // hook may answer, and a BB that merely appears in
      // requested_blood_bank_id has not been partnered yet — the NGO admin
      // still owns that promotion.
      // Every $3 is cast, for the same reason $26 is cast in POST /camps/apply:
      // Postgres infers one type per PLACEHOLDER, not per use. Assigned to
      // bb_response it deduces char(2); compared against the 'DC' literal it
      // deduces text, and the two readings collide as 42P08 ("inconsistent
      // types deduced for parameter $3") — a 500, not a validation error.
      const r = await c.query(
        `UPDATE donation_camps
            SET bb_response        = $3::char(2),
                bb_response_at     = clock_timestamp(),
                bb_response_by     = $4,
                bb_decline_reason  = CASE WHEN $3::char(2) = 'DC' THEN $5::char(2) ELSE NULL END,
                bb_decline_note    = CASE WHEN $3::char(2) = 'DC' THEN $6 ELSE NULL END
          WHERE id = $1
            AND partnered_blood_bank_id = $2
        RETURNING id, name, status, bb_response, bb_response_at,
                  bb_decline_reason,
                  to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
                  venue, submitted_by_name, submitted_by_mobile,
                  registered_donor_count, target_donor_count`,
        [
          req.params.id,
          req.user.institutionId,
          response,
          req.user.userId,
          decline_reason || null,
          note || null,
        ],
      );
      if (r.rowCount === 0) {
        throw Object.assign(new Error('not_your_camp'), { status: 409 });
      }
      return r.rows[0];
    },
    { change_reason: `blood bank camp response ${response}` },
  );

  logger.info(
    {
      camp_id: result.id,
      blood_bank_id: req.user.institutionId,
      bb_response: response,
      decline_reason: decline_reason || null,
    },
    'camp bb response recorded',
  );

  // Best-effort organiser notification. Per the product decision a late decline
  // is surfaced to the organiser IMMEDIATELY — but as a neutral reassignment
  // line only. The reason code is for the NGO admin; an organiser told "your
  // blood bank has no capacity" starts making calls, which is the behaviour
  // this feature exists to remove.
  if (result.submitted_by_mobile) {
    const templateType = response === 'AC' ? 'CAMP_BB_ACCEPTED' : 'CAMP_BB_CHANGED';
    sendNotification({
      recipientId: result.submitted_by_mobile,
      templateType,
      variables: {
        organiser_name: result.submitted_by_name || 'Organiser',
        camp_name: result.name,
        scheduled_date: result.scheduled_date,
      },
      channel: 'WA',
      language: 'en',
    }).catch((err) => logger.warn({ err: err.message }, 'camp bb-response notify failed'));
  }

  res.json({
    ...result,
    // On accept the BB keeps the organiser contact it just earned. On decline
    // it goes straight back out of reach.
    submitted_by_name: response === 'AC' ? result.submitted_by_name : undefined,
    submitted_by_mobile: response === 'AC' ? result.submitted_by_mobile : undefined,
  });
});

// ── GET /camps/:id/donations ─────────────────────────────────────────────
// The post-camp worklist: every donation recorded at this camp, and whether its
// TTI panel has been entered and verified yet.
//
// This adds NO screening write path. POST /donations/:id/screening and
// /screening/verify are reused byte-for-byte, so 4-eyes, the separate
// `screening` encryption key kind and the lookback cascade are all untouched.
// The only thing missing today is a way to REACH them: ScreeningEntry asks the
// operator to paste a donation UUID, and after a 200-donor camp that is 200
// UUIDs. This endpoint is the list that replaces them.
//
// ⚠ MOBILE IS MASKED (+91XXXXX1234). The tech is matching a paper sheet by the
// last four digits, not dialling. ?mobile= still accepts the FULL number as a
// lookup key — it goes in, it never comes back out.
router.get(
  '/:id/donations',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const pendingOnly = String(req.query.pending || '') === 'true';
    let mobile = null;
    if (req.query.mobile) {
      mobile = normaliseIndianMobile(String(req.query.mobile));
      if (!mobile) return res.status(400).json({ error: 'invalid_mobile' });
    }

    const out = await withRlsContext(req, async (c) => {
      // Scope. Deliberately WIDER than partnered_blood_bank_id: under the
      // collectable district fallback a BB can legitimately collect at a camp
      // it was never partnered on, and it must still be able to enter those
      // results. So either it is the partner, or it already recorded a donation
      // here. Admins pass NULL and see everything.
      const bbId = req.user.role === 'blood_bank' ? req.user.institutionId : null;
      if (req.user.role === 'blood_bank' && !bbId) {
        throw Object.assign(new Error('no_institution_on_session'), { status: 400 });
      }
      const guard = await c.query(
        `SELECT id FROM donation_camps
          WHERE id = $1
            AND ($2::uuid IS NULL
                 OR partnered_blood_bank_id = $2::uuid
                 OR EXISTS (SELECT 1 FROM donation_history dh
                             WHERE dh.donation_camp_id = $1
                               AND dh.blood_bank_id = $2::uuid))
          LIMIT 1`,
        [req.params.id, bbId],
      );
      if (guard.rowCount === 0) {
        throw Object.assign(new Error('not_your_camp'), { status: 403 });
      }

      // No field-level TTI here — overall_clearance and verified_at only. The
      // panel itself stays behind GET /donations/:id, which already gates it.
      const r = await c.query(
        `SELECT dh.id AS donation_id, dh.donor_id, dh.isbt_barcode,
                to_char(dh.collection_date, 'YYYY-MM-DD') AS collection_date,
                dh.volume_ml, dh.trust_level, dh.is_invalidated,
                bc.code AS component_code,
                d.full_name, d.mobile,
                bg.code AS blood_group_code,
                ds.id AS screening_id, ds.overall_clearance,
                ds.verification_required, ds.verified_at
           FROM donation_history dh
           JOIN donors d ON d.id = dh.donor_id
      LEFT JOIN blood_components bc ON bc.id = dh.component_id
      LEFT JOIN blood_groups bg ON bg.id = d.blood_group_verified
      LEFT JOIN donor_screening ds ON ds.donation_id = dh.id
          WHERE dh.donation_camp_id = $1
            AND ($2::char(13) IS NULL OR d.mobile = $2)
            AND ($3 = FALSE OR ds.id IS NULL OR ds.verified_at IS NULL)
          ORDER BY dh.collection_date ASC, dh.created_at ASC
          LIMIT 500`,
        [req.params.id, mobile, pendingOnly],
      );

      const rows = openRows(r.rows, ['full_name']);
      return rows.map((row) => ({
        ...row,
        mobile: undefined,
        mobile_masked: row.mobile ? maskMobile(row.mobile) : null,
      }));
    });

    res.json({
      camp_id: req.params.id,
      donations: out,
      count: out.length,
      awaiting_screening: out.filter((x) => !x.screening_id).length,
      awaiting_verification: out.filter((x) => x.screening_id && !x.verified_at).length,
    });
  },
);

// ── GET /camps/:id ───────────────────────────────────────────────────────
//
// SELECT c.* is convenient and returns submitter PII plus NGO-internal review
// text, so the response is filtered per viewer before it leaves. Three tiers:
//
//   reviewer (ngo_admin / super_admin / coordinator)  everything
//   the partnered BB that has ACCEPTED                organiser name + mobile,
//                                                     and its own decline text
//   everyone else (donor, hospital, other BB)         neither
//
// The middle tier is the founder's decision: a BB that has committed to staffing
// the day needs the host's number for gate access, table space and power, and
// fetching it from the NGO is one of the calls this feature exists to delete.
// Before it accepts — and for every OTHER blood bank, always — it sees nothing.
router.get('/:id', verifyJWT, async (req, res) => {
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT c.*, d.name AS district_name,
              i.display_name AS partnered_blood_bank_name,
              rb.display_name AS requested_blood_bank_name,
              -- UNGATED, and only on this route: the reviewer has to SEE the
              -- logo to approve it. Stripped below for every other viewer, so
              -- the bytes reach the admin screen and nowhere else. The public
              -- gate lives in GET /camps/public/:slug (migration 319).
              bl.logo_data_uri, bl.logo_bytes, bl.logo_content_type,
              bl.uploaded_at AS logo_uploaded_at
         FROM donation_camps c
         JOIN districts d ON d.id = c.district_id
    LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
    LEFT JOIN institutions rb ON rb.id = c.requested_blood_bank_id
    LEFT JOIN camp_branding_logo bl ON bl.camp_id = c.id
        WHERE c.id = $1`,
      [req.params.id],
    ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });

  const row = r.rows[0];
  if (CAMP_REVIEWER_ROLES.includes(req.user.role)) return res.json(row);

  const safe = { ...row };
  const acceptedPartner =
    req.user.role === 'blood_bank' &&
    !!req.user.institutionId &&
    row.partnered_blood_bank_id === req.user.institutionId &&
    row.bb_response === 'AC';

  // NGO-internal review text is never for anyone outside the reviewer tier —
  // not even the accepting BB. Its OWN decline note it may keep.
  delete safe.review_notes;
  delete safe.declined_reason;
  // Unapproved branding, and the reviewer's own notes on it, are as internal as
  // review_notes. The approved copy reaches the public through
  // GET /camps/public/:slug, which is the only route that should serve it.
  delete safe.logo_data_uri;
  delete safe.logo_bytes;
  delete safe.logo_content_type;
  delete safe.logo_uploaded_at;
  delete safe.branding_review_note;
  delete safe.branding_reviewed_by;
  if (!acceptedPartner) {
    delete safe.bb_decline_reason;
    delete safe.bb_decline_note;
  }
  if (!acceptedPartner) {
    for (const k of CAMP_SUBMITTER_KEYS) delete safe[k];
  }
  res.json(safe);
});

// ── GET /camps/:id/registrations ─────────────────────────────────────────
// Roster for the admin/coord/BB panel. Returns per-donor row + a summary
// block with counts by status so the UI can render a reconciliation strip
// without re-computing client-side. Mobile is plaintext CHAR(13) — admin,
// coordinator and the CAMP'S OWN blood bank are trusted to see it (the same
// roles already reach donor mobile via /donors/lookup). Frontend masks it for
// display.
//
//   ⚠ A BLOOD BANK MAY ONLY READ A ROSTER FOR ITS OWN CAMP.
//   The query's only predicate is camp_id, and RLS is inert at runtime, so
//   without the guard below any authenticated BB user could read ANY camp's
//   full roster — decrypted donor names and plaintext mobiles included. That
//   is a cross-tenant PII read, not a scoping nicety. Coordinators and admins
//   are district/platform-wide by role and stay unscoped.
//
// "Its own" is partnered OR requested-to-me, deliberately wider than
// bb_response='AC': a BB weighing up a request needs the turnout to answer at
// all, which is the whole point of asking it. Widened once more to a camp it
// has actually collected at, because GET /camps/collectable lets a BB serve a
// camp in its district that it was never partnered on.
router.get(
  '/:id/registrations',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin', 'blood_bank'),
  async (req, res) => {
    if (req.user.role === 'blood_bank') {
      if (!req.user.institutionId) {
        return res.status(403).json({ error: 'no_institution_on_session' });
      }
      const own = await withRlsContext(req, (c) =>
        c.query(
          `SELECT 1
             FROM donation_camps c
            WHERE c.id = $1
              AND (c.partnered_blood_bank_id = $2
                   OR c.requested_blood_bank_id = $2
                   OR EXISTS (SELECT 1 FROM donation_history dh
                               WHERE dh.donation_camp_id = c.id
                                 AND dh.blood_bank_id = $2))
            LIMIT 1`,
          [req.params.id, req.user.institutionId],
        ),
      );
      if (own.rowCount === 0) return res.status(403).json({ error: 'not_your_camp' });
    }

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
    // camp_announcement renders the camp name and date as its own {{1}}/{{2}},
    // so this carries only the detail those two cannot: the times and the
    // venue. Repeating the name here would print it twice in the message.
    const message = (
      `Now ${String(c2.start_time).slice(0, 5)}-${String(c2.end_time).slice(0, 5)} ` +
      `at ${c2.venue}. Please note this change.`
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
          // camp_name, not camp_id — a UUID cannot be rendered to a donor.
          variables: { camp_name: c2.name, camp_date: String(c2.scheduled_date), message },
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

        // ── Who is the blood bank, and has it answered? (migration 317) ──────
        //
        // The partner is resolved here in JS rather than by the COALESCE this
        // UPDATE used to carry, because bb_response depends on WHICH bank ends
        // up written — a fact the SQL would have to recompute that COALESCE to
        // know. Precedence is unchanged: the admin's explicit choice, then the
        // organiser's request, then whatever is already there. requested_ is
        // still left untouched — it stays the record of the ask.
        const before = await c.query(
          `SELECT partnered_blood_bank_id, requested_blood_bank_id, bb_response,
                  to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date
             FROM donation_camps
            WHERE id = $1 AND status = 'PE'
            FOR UPDATE`,
          [req.params.id],
        );
        if (before.rowCount === 0) {
          throw Object.assign(new Error('not_found_or_wrong_state'), { status: 409 });
        }
        const prev = before.rows[0];
        const newPartner =
          parsed.data.partnered_blood_bank_id ||
          prev.requested_blood_bank_id ||
          prev.partnered_blood_bank_id ||
          null;

        // 'PE' means "asked, awaiting an answer". Stamped when a partner is
        // first set or changed — never when it is unchanged, because that would
        // downgrade an apply-time auto-accept (or a BB's real click, if it
        // answered before the NGO got round to verifying) back to unanswered
        // every time an admin re-opened the camp.
        //
        //   ⚠ RE-PARTNERING MUST CLEAR THE DECLINE COLUMNS.
        //   317's bb_decline_reason_needs_decline is
        //   CHECK (bb_decline_reason IS NULL OR bb_response = 'DC'), so moving
        //   the response to 'PE' while the previous BB's reason is still sitting
        //   there fails the constraint outright — and would otherwise render a
        //   red "declined" flag against a blood bank that never said anything.
        const partnerChanged = !!newPartner && newPartner !== prev.partnered_blood_bank_id;
        let newResponse = prev.bb_response;
        if (!newPartner) newResponse = null;
        else if (partnerChanged || !prev.bb_response) newResponse = 'PE';
        const resetResponse = newResponse !== prev.bb_response;

        // Overbooking is the admin's call, not the platform's — they are the
        // bridge between organiser and blood bank, and an emergency is exactly
        // when a capacity rule must yield to a person. So this RECORDS the
        // override instead of blocking it: apply's 409 protects an organiser
        // from a day the BB has published as full, whereas here a human has
        // already decided otherwise and the note is what makes that decision
        // legible afterwards.
        let overbookNote = null;
        if (newPartner && (partnerChanged || !prev.bb_response)) {
          const slot = await capacity.checkSlot(c, newPartner, prev.scheduled_date);
          if (!slot.ok) {
            overbookNote =
              `[capacity override ${prev.scheduled_date}] blood bank had ` +
              `${slot.confirmed} of ${slot.max_camps} camps confirmed when partnered.`;
          }
        }

        const r = await c.query(
          `UPDATE donation_camps
              SET status = 'PL',
                  verified_by_user_id = $2,
                  verified_at = clock_timestamp(),
                  -- CONCAT_WS skips NULLs, so this reads as "keep what is there
                  -- unless the admin typed something", plus the override line
                  -- when there is one. review_notes is plain TEXT and
                  -- NGO-internal — never put a mobile number in it.
                  review_notes = NULLIF(
                    CONCAT_WS(E'\n', COALESCE($3, review_notes), $6::text), ''),
                  partnered_blood_bank_id = $4::uuid,
                  organising_coordinator_id = COALESCE($5::uuid, organising_coordinator_id),
                  bb_response = $7::char(2),
                  -- A response's metadata cannot outlive the response itself.
                  -- On a re-partner all four go together, which is what keeps
                  -- 317's bb_decline_reason_needs_decline satisfiable.
                  bb_response_at = CASE WHEN $8 THEN NULL ELSE bb_response_at END,
                  bb_response_by = CASE WHEN $8 THEN NULL ELSE bb_response_by END,
                  bb_decline_reason = CASE WHEN $8 THEN NULL ELSE bb_decline_reason END,
                  bb_decline_note = CASE WHEN $8 THEN NULL ELSE bb_decline_note END
            WHERE id = $1 AND status = 'PE'
        RETURNING id, status, verified_at, partnered_blood_bank_id, bb_response,
                  scheduled_date, submitted_by_name, submitted_by_mobile, name`,
          [
            req.params.id,
            req.user.userId,
            parsed.data.review_notes || null,
            newPartner,
            organisingCoordId,
            overbookNote,
            newResponse,
            resetResponse,
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

        // Everything the CAMP_BB_REQUEST send needs, gathered while we still
        // have the transaction. Only on 'PE': an unchanged bb_response means
        // this bank already answered, and an apply-time auto-accept ('AC')
        // needs no prompt at all. Read back AFTER the UPDATE so the join
        // follows the partner that was actually written, not the one this
        // handler computed.
        if (newResponse === 'PE') {
          const brief = await c.query(
            `SELECT i.display_name AS bb_name,
                    dc.venue,
                    dc.target_donor_count,
                    to_char(dc.scheduled_date, 'YYYY-MM-DD') AS camp_date
               FROM donation_camps dc
               JOIN institutions i ON i.id = dc.partnered_blood_bank_id
              WHERE dc.id = $1`,
            [req.params.id],
          );
          if (brief.rowCount > 0) camp.bbRequest = brief.rows[0];
        }
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
        // camp_organizer_link_v2 takes TWO body variables and the RAW token as
        // its URL-button parameter — Meta appends it to the approved button
        // path {BASE_URL}/camp/{{1}}. Passing magicUrl here would produce
        // /camp/https%3A%2F%2F… and a dead link. Order is positional.
        variables: {
          organiser_name: result.submitted_by_name || 'Organiser',
          camp_name: result.name,
          camp_token: token,
        },
        channel: 'WA',
        language: 'en',
      }).catch((err) => logger.warn({ err: err.message }, 'camp magic-link notify failed'));
    }

    // Tell the blood bank it has a camp to answer. The BB's institution UUID
    // goes in as recipientId rather than a bare number: the chokepoint resolves
    // it to primary_contact_mobile AND stamps recipient_institution_id, so the
    // notification_log row records WHICH institution was asked (precedent:
    // routes/donorAlerts.js:294, services/notifications/index.js resolveRecipient).
    // Body-only template, no button - a BB signs in with password + TOTP, so a
    // button here could only carry a constant /bb link, which is exactly what
    // got community_leader_welcome re-classified MARKETING (see env.js).
    if (result.bbRequest) {
      sendNotification({
        recipientId: result.partnered_blood_bank_id,
        templateType: 'CAMP_BB_REQUEST',
        variables: {
          bb_name: result.bbRequest.bb_name,
          camp_date: result.bbRequest.camp_date,
          venue: result.bbRequest.venue,
          expected_donors: String(result.bbRequest.target_donor_count || 0),
        },
        channel: 'WA',
        language: 'en',
      }).catch((err) => logger.warn({ err: err.message }, 'camp bb-request notify failed'));
    }

    res.json({
      ...result,
      submitted_by_mobile: undefined, // don't echo back; admin already has it
      submitted_by_name: undefined,
      bbRequest: undefined, // notification scratch space, not part of the contract
      organizer_dashboard: {
        token,
        url: magicUrl,
        expires_in_days: 'scheduled_date + 30',
      },
    });
  },
);

// ── POST /camps/:id/repartner ────────────────────────────────────────────
// Move an already-verified camp to a different blood bank.
//
// This exists because nothing else can. PATCH /camps/:id lists
// partnered_blood_bank_id under "WHAT IS NOT EDITABLE" — that column is the
// NGO's verdict, not the host's description of its own event — and
// POST /:id/verify only fires on status 'PE'. So the moment a BB declines a
// camp that is already 'PL', the admin has a red row and no button, which is
// not a workflow. This is the button.
//
// Deliberately NOT folded into PATCH: the host edits a camp with PATCH, whereas
// this is the NGO reassigning collection responsibility. Keeping them as
// separate, differently-authorised routes is what stops the two being confused.
//
//   ⚠ THE DECLINE COLUMNS MUST BE CLEARED — same reason verify clears them.
//   317's bb_decline_reason_needs_decline is
//   CHECK (bb_decline_reason IS NULL OR bb_response = 'DC'), so writing 'PE'
//   while the previous BB's reason still sits there fails the constraint
//   outright, and would otherwise render a red "declined" flag against a blood
//   bank that never said anything.
//
// status is untouched, exactly as on a decline: the camp is still happening and
// donors have already RSVP'd — only who collects is in question. And no
// organiser notification fires from here. The decline already sent the neutral
// "we're arranging a different blood bank" line, and the new BB's own accept
// sends the confirmation; a third message between the two would just be noise.
// (Notifying the incoming BB is the camp_bb_request template, which has no
// handler or env key yet — a call site here would be a silent no-op.)
const repartnerSchema = z.object({
  partnered_blood_bank_id: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
router.post(
  '/:id/repartner',
  verifyJWT,
  requireRole('coordinator', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = repartnerSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }

    const result = await withRlsContext(
      req,
      async (c) => {
        const before = await c.query(
          `SELECT status, partnered_blood_bank_id,
                  to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date
             FROM donation_camps
            WHERE id = $1
            FOR UPDATE`,
          [req.params.id],
        );
        if (before.rowCount === 0) {
          throw Object.assign(new Error('not_found'), { status: 404 });
        }
        const prev = before.rows[0];
        if (CAMP_TERMINAL_STATUSES.includes(prev.status)) {
          throw Object.assign(new Error('camp_is_closed'), { status: 409 });
        }

        // The FK alone would accept a hospital's id. Resolve against the same
        // predicate GET /camps/blood-bank-options offers, so an admin cannot
        // partner a camp to something that would never appear in the picker.
        const bb = await c.query(
          `SELECT id, display_name
             FROM institutions
            WHERE id = $1
              AND kind = 'BB'
              AND onboarding_status = 'AC'
              AND is_active = TRUE`,
          [parsed.data.partnered_blood_bank_id],
        );
        if (bb.rowCount === 0) {
          throw Object.assign(new Error('blood_bank_not_available'), { status: 400 });
        }
        const target = bb.rows[0];

        // Overbooking RECORDS rather than blocks, same as verify. A
        // reassignment usually happens because the first BB fell through days
        // before the camp — which is exactly when a capacity number must yield
        // to a person, and the note is what makes that decision legible later.
        const slot = await capacity.checkSlot(c, target.id, prev.scheduled_date);
        const noteParts = [];
        if (parsed.data.reason) {
          noteParts.push(`[repartner ${prev.scheduled_date}] ${parsed.data.reason}`);
        }
        if (!slot.ok) {
          noteParts.push(
            `[capacity override ${prev.scheduled_date}] ${target.display_name} had ` +
              `${slot.confirmed} of ${slot.max_camps} camps confirmed when partnered.`,
          );
        }
        const noteText = noteParts.length > 0 ? noteParts.join('\n') : null;

        // No status predicate on the UPDATE: the SELECT above holds this row
        // FOR UPDATE inside the same transaction, so the check it made cannot
        // have gone stale by the time this runs.
        const r = await c.query(
          `UPDATE donation_camps
              SET partnered_blood_bank_id = $2::uuid,
                  bb_response        = 'PE',
                  bb_response_at     = NULL,
                  bb_response_by     = NULL,
                  bb_decline_reason  = NULL,
                  bb_decline_note    = NULL,
                  -- CONCAT_WS skips NULLs: keep what is there, append the
                  -- reason and any override line. review_notes is plain TEXT
                  -- and NGO-internal — never put a mobile number in it.
                  review_notes = NULLIF(CONCAT_WS(E'\n', review_notes, $3::text), '')
            WHERE id = $1
        RETURNING id, name, status, partnered_blood_bank_id, bb_response,
                  venue, target_donor_count,
                  to_char(scheduled_date, 'YYYY-MM-DD') AS scheduled_date`,
          [req.params.id, target.id, noteText],
        );
        return {
          ...r.rows[0],
          blood_bank_name: target.display_name,
          previous_blood_bank_id: prev.partnered_blood_bank_id,
          capacity_overridden: !slot.ok,
        };
      },
      { change_reason: 'camp re-partnered to a different blood bank' },
    );

    logger.info(
      {
        camp_id: result.id,
        from_blood_bank_id: result.previous_blood_bank_id,
        to_blood_bank_id: result.partnered_blood_bank_id,
        capacity_overridden: result.capacity_overridden,
      },
      'camp re-partnered',
    );

    // The new blood bank is now the one on the hook, and this UPDATE always
    // writes bb_response='PE', so there is no condition to check: a re-partner
    // is by definition an unanswered ask. The bank it was moved AWAY from is
    // deliberately not notified - it either declined (it knows) or was swapped
    // out by the admin, and telling it about a camp it is no longer collecting
    // is the kind of message this feature exists to remove.
    sendNotification({
      recipientId: result.partnered_blood_bank_id,
      templateType: 'CAMP_BB_REQUEST',
      variables: {
        bb_name: result.blood_bank_name,
        camp_date: result.scheduled_date,
        venue: result.venue,
        expected_donors: String(result.target_donor_count || 0),
      },
      channel: 'WA',
      language: 'en',
    }).catch((err) => logger.warn({ err: err.message }, 'camp bb-request notify failed'));

    res.json(result);
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

// ── POST /camps/:id/branding/approve · /branding/reject ────────────
//
// The same person who verified the camp vets what the organiser put on it — the
// founder's decision. Until approve lands, GET /camps/public/:slug returns no
// logo and no tagline; that gate is in SQL, in that route (migration 319).
//
// Both stamp branding_reviewed_at/_by because 319's
// camp_branding_review_needs_reviewer CHECK refuses an outcome with nobody
// attached to it, and reject requires a note for the same structural reason
// (camp_branding_reject_needs_note): an organiser who reads "नाकारले" with no
// reason has nothing to act on.
//
// The `branding_status = 'PE'` predicate makes both a no-op rather than a
// silent re-write on a camp with nothing pending — a double-click, or a second
// admin acting on a stale list.
const rejectBrandingSchema = z.object({
  note: z.string().trim().min(1).max(280),
});

router.post(
  '/:id/branding/approve',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps
              SET branding_status      = 'AP',
                  branding_reviewed_at = clock_timestamp(),
                  branding_reviewed_by = $2,
                  branding_review_note = NULL
            WHERE id = $1
              AND branding_status = 'PE'
        RETURNING id, branding_status, branding_reviewed_at`,
          [req.params.id, req.user.userId],
        ),
      { change_reason: 'organiser branding approved' },
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'no_branding_pending' });
    res.json({ camp: r.rows[0] });
  },
);

router.post(
  '/:id/branding/reject',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = rejectBrandingSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donation_camps
              SET branding_status      = 'RJ',
                  branding_reviewed_at = clock_timestamp(),
                  branding_reviewed_by = $2,
                  branding_review_note = $3
            WHERE id = $1
              AND branding_status = 'PE'
        RETURNING id, branding_status, branding_reviewed_at, branding_review_note`,
          [req.params.id, req.user.userId, parsed.data.note],
        ),
      { change_reason: `organiser branding rejected: ${parsed.data.note.slice(0, 200)}` },
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'no_branding_pending' });
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
                  -- Same boundary as /camps/mine: the answer, never the reason.
                  c.bb_response,
                  -- UNGATED here, deliberately — this is the organiser's own
                  -- view of their own upload. They must be able to see what
                  -- they sent and, on 'RJ', read why. The public gate lives in
                  -- GET /camps/public/:slug (migration 319).
                  bl.logo_data_uri, c.organiser_tagline,
                  c.branding_status, c.branding_review_note,
                  d.name AS district_name,
                  i.display_name AS partnered_blood_bank_name
             FROM donation_camps c
             JOIN districts d ON d.id = c.district_id
        LEFT JOIN institutions i ON i.id = c.partnered_blood_bank_id
        LEFT JOIN camp_branding_logo bl ON bl.camp_id = c.id
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

// ── Organiser branding: logo + tagline (PUBLIC magic-link) ──────────
//
// The organiser's own identity on the page they share. Both endpoints
// authenticate through loadToken() — the magic-link token IS the credential; an
// organiser has no JWT and no session.
//
//   ⚠ NOTHING WRITTEN HERE IS PUBLIC UNTIL AN NGO ADMIN APPROVES IT.
//   Every write below sets branding_status='PE' and clears the review columns
//   IN THE SAME STATEMENT that writes the new value (migration 319's header).
//   A second statement could drift, and an organiser would then be able to get
//   a benign logo approved and swap it for something else afterwards.
//
// The bytes go into camp_branding_logo, not donation_camps: fn_audit_row()
// writes the full old AND new value of every changed field, audit_log is
// INSERT-only by hard rule 2, and a ~67 KB base64 string re-uploaded a few
// times would bloat a table nobody can ever prune. camp_branding_logo is
// deliberately un-audited and deliberately has no `id` column, so
// attach_audit_trigger() on it fails loudly. See migration 319.
//
// camp_branding_logo has no RLS policies and that is deliberate too: no
// migration in this repo GRANTs anything (the app connects as the DB owner, and
// RLS is inert at runtime — see the note in 316's header). Enabling RLS with no
// policies would deny every read the day the app moves to `app_user`, silently
// breaking this feature. The handler's own WHERE is the security boundary, as
// everywhere else in this router.
const LOGO_TYPES = {
  'image/jpeg': {
    magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  'image/png': {
    magic: (b) =>
      b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
};

// 50 KB DECODED. This lives here and not in a CHECK constraint because it is a
// payload-budget decision about rural 4G, not a patient-safety invariant —
// hard rule 1 cuts the other way. 50 KB becomes ~67 KB of base64 riding the
// JSON the RSVP page already fetches; 100 KB would be ~133 KB, a 25x jump on
// today's payload. The client resizes to a 400 px max edge first, so a real
// logo lands well inside this. migration 319's 200000-char CHECK is a loose
// backstop against something pathological, not this cap.
const LOGO_MAX_BYTES = 50000;

// ⚠ express.raw() runs BEFORE loadToken(), because loadToken is a plain
//   function and not middleware. An unauthenticated request therefore gets its
//   body parsed — bounded by the limit below and by the global 100/IP/min rate
//   limiter. Keep that limit tight; it is the only thing in front of the token
//   check. A raw Buffer body also passes through sanitizeInput untouched (it
//   only walks strings), which is why the magic-byte test IS the validation
//   here — the same reasoning as POST /onboarding/:id/mou-scan.
router.post(
  '/access/:token/logo-raw',
  express.raw({ type: Object.keys(LOGO_TYPES), limit: '100kb' }),
  async (req, res) => {
    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const spec = LOGO_TYPES[contentType];
    if (!spec) {
      return res
        .status(415)
        .json({ error: 'unsupported_media_type', accepted: Object.keys(LOGO_TYPES) });
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0) return res.status(400).json({ error: 'empty_body' });
    if (buf.length > LOGO_MAX_BYTES) {
      return res
        .status(413)
        .json({ error: 'logo_too_large', bytes: buf.length, max_bytes: LOGO_MAX_BYTES });
    }
    // A .txt renamed .jpg, or a PNG sent as image/jpeg, stops here.
    if (!spec.magic(buf)) {
      return res.status(400).json({ error: 'content_type_mismatch', declared: contentType });
    }

    const v = await loadToken(req.params.token);
    if (!v.ok) return res.status(403).json({ error: v.reason });

    const dataUri = `data:${contentType};base64,${buf.toString('base64')}`;
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');

    // ONE statement: the bytes land in the child table and the parent's review
    // state resets together, so the two can never disagree.
    const r = await withRlsContextRaw(
      {
        actor_role: 'camp_organizer',
        actor_system_process: `camp:${v.token.token.slice(0, 12)}`,
        camp_token: v.token.token,
        actor_ip_address: cleanClientIp(req),
        change_reason: `organizer uploaded branding logo (${buf.length} bytes)`,
      },
      (c) =>
        c.query(
          `WITH b AS (
             INSERT INTO camp_branding_logo
                    (camp_id, logo_data_uri, logo_bytes, logo_content_type, logo_sha256)
             VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (camp_id) DO UPDATE
                    SET logo_data_uri     = EXCLUDED.logo_data_uri,
                        logo_bytes        = EXCLUDED.logo_bytes,
                        logo_content_type = EXCLUDED.logo_content_type,
                        logo_sha256       = EXCLUDED.logo_sha256,
                        uploaded_at       = clock_timestamp()
               RETURNING camp_id
           )
           UPDATE donation_camps c
              SET branding_status      = 'PE',
                  branding_reviewed_at = NULL,
                  branding_reviewed_by = NULL,
                  branding_review_note = NULL
             FROM b
            WHERE c.id = b.camp_id
        RETURNING c.id, c.branding_status`,
          [v.token.camp_id, dataUri, buf.length, contentType, sha256],
        ),
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'camp_not_found' });

    // Never echo the data URI back — the caller already holds the bytes, and the
    // organiser dashboard re-reads GET /camps/access/:token anyway.
    res.json({
      bytes: buf.length,
      content_type: contentType,
      branding_status: r.rows[0].branding_status,
    });
  },
);

// PATCH /camps/access/:token/branding — the one line of the organiser's own words.
//
// The tagline rides the SAME approval gate as the logo. The founder's decision
// was about the logo, but 280 characters of free text on a public page beside a
// PENDING trade mark is the larger abuse surface of the two, and one review
// action covering both is less admin work than two.
const brandingSchema = z.object({
  tagline: z.string().trim().max(280).nullable().optional(),
});

router.patch('/access/:token/branding', async (req, res) => {
  const parsed = brandingSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  if (!('tagline' in parsed.data)) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }

  const v = await loadToken(req.params.token);
  if (!v.ok) return res.status(403).json({ error: v.reason });

  // '' is a clear, not a stored empty string.
  const tagline = parsed.data.tagline ? parsed.data.tagline : null;

  const r = await withRlsContextRaw(
    {
      actor_role: 'camp_organizer',
      actor_system_process: `camp:${v.token.token.slice(0, 12)}`,
      camp_token: v.token.token,
      actor_ip_address: cleanClientIp(req),
      change_reason: tagline
        ? 'organizer set branding tagline'
        : 'organizer cleared branding tagline',
    },
    (c) =>
      c.query(
        `UPDATE donation_camps c
            SET organiser_tagline = $2,
                -- Nothing submitted at all goes back to NULL rather than sitting
                -- in the admin's review queue forever; anything submitted is 'PE'.
                branding_status = CASE
                                    WHEN $2::text IS NULL
                                     AND NOT EXISTS (SELECT 1 FROM camp_branding_logo bl
                                                      WHERE bl.camp_id = c.id)
                                    THEN NULL
                                    ELSE 'PE'
                                  END,
                branding_reviewed_at = NULL,
                branding_reviewed_by = NULL,
                branding_review_note = NULL
          WHERE c.id = $1
      RETURNING c.id, c.organiser_tagline, c.branding_status`,
        [v.token.camp_id, tagline],
      ),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'camp_not_found' });
  res.json({ updated: true, ...r.rows[0] });
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
        // The camp name and date come along for the template: loadToken()
        // returns neither, and widening that shared helper would add fields to
        // an object several /access/:token/* routes spread straight into their
        // responses. Joining here keeps the change to the one caller that
        // needs it.
        `SELECT cr.donor_id, dc.name AS camp_name, dc.scheduled_date
           FROM camp_registrations cr
           JOIN donation_camps dc ON dc.id = cr.camp_id
          WHERE cr.camp_id = $1 AND cr.status IN ('RG', 'AT', 'DF')`,
        [v.token.camp_id],
      ),
  );

  let queued = 0;
  for (const row of donors.rows) {
    try {
      await sendNotification({
        recipientId: row.donor_id,
        templateType: 'CAMP_ANNC',
        // camp_name, not camp_id — a donor cannot read a UUID. Positional
        // order must match camp_announcement's {{1}}/{{2}}/{{3}}.
        variables: {
          camp_name: row.camp_name,
          camp_date: String(row.scheduled_date).slice(0, 10),
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
