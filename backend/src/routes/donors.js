/**
 * Donor routes (Phase 3).
 *
 *   POST /donors/register                    public; pairs to platform_users via mobile/JWT
 *   GET  /donors/me                          authenticated donor; own profile
 *   GET  /donors/:id/passport                authenticated; donor self / coordinator / admin
 *   POST /donors/:id/blood-group/verify      bb_writer (blood_bank role); writes blood_group_verified
 *   POST /donors/:id/availability            authenticated donor; toggles is_available
 *   POST /donors/:id/consent                 authenticated donor; grants/revokes consent (gated by trg_donors_consent_protect)
 *   POST /donors/merge                       ngo_admin; STUB — see services/donors/merge.js
 *
 * Eligibility screening: spec §5 4-step web form is partially implemented:
 *   - Step 2 (personal details) → POST /donors/register
 *   - Step 4 (consent) → POST /donors/:id/consent
 *   - Step 1 (pre-screening permanent) and Step 3 (temporary deferrals)
 *     use the medically signed-off question bank (see services/donors/eligibility.js;
 *     Medical Review 10-Jul-2026). The questions are served via
 *     GET /donors/eligibility/questions for the frontend to render. This
 *     pre-screen is a soft, donor-facing filter — the binding gate is the DB.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');

const { withRlsContext, withRlsContextRaw } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { normaliseIndianMobile } = require('../utils/phone');
const { seal, open, blindIndex } = require('../services/pii');
const { checkDuplicates } = require('../services/donors/duplicates');
const { buildPassport } = require('../services/donors/passport');
const eligibility = require('../services/donors/eligibility');

const router = express.Router();

// Camp-day safe register limiter — key on the submitted mobile so 50 donors
// registering from one camp WiFi don't trip an IP throttle. IP throttling
// is intentionally weaker here because a mobile is a stronger identity than
// an IP for this endpoint (each real signup uses a unique number anyway).
// The global limiter in app.js is exempted for this path.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  limit: 5, // per mobile, per hour — plenty for legit retries, kills bots
  keyGenerator: (req) => normaliseIndianMobile(req.body?.mobile) || req.ip,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'rate_limit_donor_register' },
});

// Registration-status probe limiter. Keyed on the queried mobile (camp-safe,
// like registerLimiter) so many donors behind one WiFi aren't throttled as a
// group. The global per-IP limiter (app.js) still backstops bulk enumeration.
const regStatusLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1h
  limit: 30, // per mobile, per hour — the client debounces to ~1 per entry
  keyGenerator: (req) => normaliseIndianMobile(req.query?.mobile) || req.ip,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'rate_limit_registration_status' },
});

// Is there an active donor with this mobile? Shared by the register-status
// probe and the register 409 guard so the existence check lives in one place.
async function donorExistsByMobile(client, mobile) {
  const r = await client.query(
    `SELECT 1 FROM donors WHERE mobile = $1 AND is_active = TRUE LIMIT 1`,
    [mobile],
  );
  return r.rowCount > 0;
}

// ── GET /donors/eligibility/questions (public) ───────────────────────────
router.get('/eligibility/questions', (_req, res) => {
  res.json({
    permanent: eligibility.PERMANENT_QUESTIONS,
    temporary: eligibility.TEMPORARY_QUESTIONS,
    draft: eligibility.DRAFT_PENDING_REVIEW,
    note: eligibility.DRAFT_PENDING_REVIEW
      ? 'Question bank is provisional — pending medical advisor sign-off.'
      : null,
  });
});

const registerSchema = z.object({
  mobile: z.string(),
  full_name: z.string().min(2).max(120),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['M', 'F', 'O']),
  abha_id: z
    .string()
    .regex(/^\d{17}$/)
    .optional(),
  aadhaar_last4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  preferred_language: z.enum(['mr', 'hi', 'en']).default('en'),
  village_id: z.number().int().positive().optional(),
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .optional(),
  address_line: z.string().optional(),
  max_travel_km: z.number().int().min(1).max(999).default(10),
  blood_group_self_reported: z.number().int().min(1).max(8).optional(),
  preferred_contact_channel: z.enum(['WA', 'SM', 'CA']).default('WA'),
  whatsapp_opted_in: z.boolean().default(false),
  sms_opted_in: z.boolean().default(true),
  community_id: z.string().uuid().optional(),
  // Phase 3: if a donor signs up via a public community page or referral
  // link, we credit the specific leader who recruited them. When the URL
  // only carried community_id (or slug), the resolver defaults to the
  // community owner at registration time — see resolver below.
  referred_by_community_leader_id: z.string().uuid().optional(),
  registration_source: z.enum(['QRC', 'WAB', 'WEB', 'APP', 'BBK', 'CAM']).default('WEB'),
  registration_camp_id: z.string().uuid().optional(),
  // Pre-screening answers (Step 1) — soft-checked against the signed-off
  // eligibility bank (informational). See services/donors/eligibility.js.
  prescreening_answers: z.record(z.string(), z.enum(['YES', 'NO'])).optional(),
});

// ── GET /donors/registration-status?mobile= (public) ─────────────────────
// UX helper for the register form: tells the client whether a mobile already
// belongs to a donor profile, so a returning donor is steered to OTP login
// (and can then correct their profile) instead of filling out the whole form
// only to hit a duplicate error at submit.
//
// Returns ONLY a boolean — never any donor PII (no name, status, or count) —
// so its enumeration value is limited to "is this number a Raktify donor",
// which the register + login pages already reveal implicitly. Runs under the
// same `registration` actor the register flow uses (it already SELECTs donors
// for duplicate detection); the handler never returns the row.
router.get('/registration-status', regStatusLimiter, async (req, res) => {
  const mobile = normaliseIndianMobile(req.query.mobile);
  if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });
  const registered = await withRlsContextRaw(
    { actor_role: 'registration', change_reason: 'donor register-form status check' },
    (c) => donorExistsByMobile(c, mobile),
  );
  res.json({ registered });
});

// ── POST /donors/register (public) ───────────────────────────────────────
router.post('/register', registerLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const data = parsed.data;
  const mobile = normaliseIndianMobile(data.mobile);
  if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

  // QR camp validation: if registration_source='QRC', registration_camp_id is
  // required and must point to a planned/live camp.
  if (data.registration_source === 'QRC') {
    if (!data.registration_camp_id) {
      return res.status(400).json({ error: 'qr_registration_requires_camp_id' });
    }
    const { pool } = require('../config/db');
    const campR = await pool.query(`SELECT id, status FROM donation_camps WHERE id = $1`, [
      data.registration_camp_id,
    ]);
    if (campR.rowCount === 0) {
      return res.status(400).json({ error: 'camp_not_found' });
    }
    if (!['PL', 'LV'].includes(campR.rows[0].status)) {
      return res.status(409).json({ error: 'camp_not_active', status: campR.rows[0].status });
    }
  }

  // Quick eligibility soft-check using the signed-off bank — informational only.
  const screening = data.prescreening_answers
    ? eligibility.evaluate(data.prescreening_answers)
    : null;
  if (screening && !screening.eligible) {
    return res.status(200).json({
      status: 'soft_decline',
      reason: 'permanent_exclusion',
      blocks: screening.permanent_blocks,
      message:
        'Based on your answers we are unable to register you as a donor at this time. Please consult a doctor for guidance.',
      draft: screening.draft,
    });
  }

  try {
    const result = await withRlsContextRaw(
      { actor_role: 'registration', change_reason: 'donor self-registration' },
      async (c) => {
        // Resolve / create the platform_users auth row
        const userR = await c.query(
          // ON CONFLICT target matches the partial unique index defined by
          // migration 274: `(mobile) WHERE mobile IS NOT NULL AND role = 'donor'`.
          // The DO UPDATE is a no-op (we always insert role='donor'), but it's
          // required so the RETURNING clause emits the existing row's id when
          // a donor with this mobile already exists.
          `INSERT INTO platform_users (role, mobile)
           VALUES ('donor', $1)
           ON CONFLICT (mobile) WHERE mobile IS NOT NULL AND role = 'donor'
             DO UPDATE SET role = EXCLUDED.role
           RETURNING id`,
          [mobile],
        );
        const platformUserId = userR.rows[0].id;

        // Already a donor with this mobile? Return a clean 409 that the
        // register form turns into "you're already registered — log in".
        // Without this the donors(mobile) partial unique index would raise a
        // raw 23505 that surfaced to the user as a generic 500.
        if (await donorExistsByMobile(c, mobile)) {
          throw Object.assign(
            new Error('This mobile number is already registered. Please log in instead.'),
            { status: 409, code: 'mobile_already_registered' },
          );
        }

        // Duplicate detection (BLOCK on ABHA, FLAG on name+DOB / aadhaar+DOB)
        const dup = await checkDuplicates(c, {
          abha_id: data.abha_id || null,
          full_name: data.full_name,
          date_of_birth: data.date_of_birth,
          aadhaar_last4: data.aadhaar_last4 || null,
        });
        if (dup.action === 'BLOCK') {
          throw Object.assign(new Error(dup.message), {
            status: 409,
            code: dup.code,
            match_id: dup.match_id,
          });
        }

        // Phase 3 attribution: if the donor came via a community page but
        // the URL didn't carry a specific leader id, default to the
        // community's current owner so somebody gets credit.
        let referredByLeader = data.referred_by_community_leader_id || null;
        if (data.community_id && !referredByLeader) {
          const co = await c.query(
            `SELECT owner_community_leader_id FROM communities WHERE id = $1`,
            [data.community_id],
          );
          if (co.rowCount > 0 && co.rows[0].owner_community_leader_id) {
            referredByLeader = co.rows[0].owner_community_leader_id;
          }
        }

        const insR = await c.query(
          `INSERT INTO donors (
              mobile, mobile_verified, full_name, date_of_birth, gender,
              abha_id, aadhaar_last4, preferred_language,
              village_id, pincode, address_line, max_travel_km,
              blood_group_self_reported,
              preferred_contact_channel, whatsapp_opted_in, sms_opted_in,
              community_id, referred_by_community_leader_id, platform_user_id,
              registration_source, registration_camp_id,
              suspected_duplicate_of, full_name_bidx)
           VALUES (
              $1, FALSE, $2, $3, $4,
              $5, $6, $7,
              $8, $9, $10, $11,
              $12,
              $13, $14, $15,
              $16, $17, $18,
              $19, $20,
              $21, $22)
           RETURNING id`,
          [
            mobile,
            seal(data.full_name), // donor name — column-encrypted (main key)
            data.date_of_birth,
            data.gender,
            data.abha_id || null,
            data.aadhaar_last4 || null,
            data.preferred_language,
            data.village_id || null,
            data.pincode || null,
            seal(data.address_line || null), // donor PII (main key)
            data.max_travel_km,
            data.blood_group_self_reported || null,
            data.preferred_contact_channel,
            data.whatsapp_opted_in,
            data.sms_opted_in,
            data.community_id || null,
            referredByLeader,
            platformUserId,
            data.registration_source,
            data.registration_camp_id || null,
            dup.action === 'FLAG' ? dup.match_id : null,
            blindIndex(data.full_name), // duplicate-lookup index for the sealed name
          ],
        );

        return {
          donor_id: insR.rows[0].id,
          platform_user_id: platformUserId,
          duplicate_flag: dup.action === 'FLAG' ? dup.code : null,
        };
      },
    );

    res.status(201).json({
      status: 'registered',
      ...result,
      mobile_verification_required: true,
      next_step:
        'POST /auth/otp/send to verify the mobile, then POST /donors/me/consent to grant data-use consent.',
    });
  } catch (err) {
    if (err.status === 409) {
      return res
        .status(409)
        .json({ error: err.code, message: err.message, match_id: err.match_id });
    }
    throw err;
  }
});

// ── GET /donors/lookup?mobile=… ─────────────────────────────────────────
// Blood-bank-side mobile lookup for donation recording (spec §7 BB portal).
// Returns donor id + the minimum fields needed to pre-fill the donation form:
//   verified blood group, deferral status, next-eligible date, availability.
// Full name is included so the BB staff can confirm identity at the chair.
//
// RLS note: the `donors_self` SELECT policy for blood_bank is gated on
// donation_history at this BB — fine for return donors, useless for first
// timers. We therefore run this lookup under the elevated `system` actor
// role (migration 240 permits) — same pattern matching + notifications use.
// Auth is enforced by verifyJWT + requireRole; the system elevation only
// covers this single by-mobile read.
router.get(
  '/lookup',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const mobile = normaliseIndianMobile(req.query.mobile);
    if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

    const r = await withRlsContextRaw(
      {
        actor_role: 'system',
        actor_user_id: req.user.userId,
        access_reason: 'blood_bank donor mobile lookup for donation recording',
      },
      (c) =>
        c.query(
          `SELECT d.id, d.full_name, d.date_of_birth, d.gender,
                  d.blood_group_verified, bgv.code AS blood_group_verified_code,
                  d.blood_group_self_reported, bgs.code AS blood_group_self_reported_code,
                  d.blood_group_verified_at,
                  d.deferral_status, d.deferral_until, d.next_eligible_date,
                  d.is_available,
                  d.consent_data_use, d.registration_source
             FROM donors d
        LEFT JOIN blood_groups bgv ON bgv.id = d.blood_group_verified
        LEFT JOIN blood_groups bgs ON bgs.id = d.blood_group_self_reported
            WHERE d.mobile = $1
            LIMIT 1`,
          [mobile],
        ),
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'donor_not_found' });
    const d = r.rows[0];
    res.json({
      donor_id: d.id,
      full_name: open(d.full_name), // column-encrypted at rest
      date_of_birth: d.date_of_birth,
      gender: d.gender,
      blood_group_verified_code: d.blood_group_verified_code,
      blood_group_self_reported_code: d.blood_group_self_reported_code,
      blood_group_self_reported: d.blood_group_self_reported,
      blood_group_verified: Boolean(d.blood_group_verified_code),
      deferral_status: d.deferral_status,
      deferral_until: d.deferral_until,
      next_eligible_date: d.next_eligible_date,
      is_available: d.is_available,
      // Phase 4c bulk import: if FALSE + source IN (IMP,BBK), the donor
      // was bulk-imported and never completed consent. BB UI surfaces a
      // "Complete registration" inline flow before recording the donation.
      consent_data_use: d.consent_data_use,
      registration_source: d.registration_source,
      needs_activation: !d.consent_data_use,
    });
  },
);

// ── GET /donors/me ───────────────────────────────────────────────────────
router.get('/me', verifyJWT, requireRole('donor'), async (req, res) => {
  const r = await withRlsContext(req, (c) =>
    c.query(`SELECT id FROM donors WHERE platform_user_id = $1 LIMIT 1`, [req.user.userId]),
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'donor_profile_not_found' });
  const passport = await withRlsContext(req, (c) => buildPassport(c, r.rows[0].id));
  res.json(passport);
});

// ── POST /donors/me/profile ──────────────────────────────────────────────
// Donor self-service profile correction. A returning donor who logs in can
// fix details they mis-entered at registration. Whitelisted fields only —
// mobile (identity / login handle), consent, and blood_group_verified
// (lab-only) are deliberately NOT editable here. Partial update: any omitted
// field is left unchanged (COALESCE). Declared before the `/:id/*` routes so
// 'me' is never captured as an :id.
const profileUpdateSchema = z.object({
  full_name: z.string().trim().min(2).max(120).optional(),
  gender: z.enum(['M', 'F', 'O']).optional(),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  blood_group_self_reported: z.number().int().min(1).max(8).optional(),
  village_id: z.number().int().positive().optional(),
  max_travel_km: z.number().int().min(1).max(999).optional(),
  preferred_contact_channel: z.enum(['WA', 'SM', 'CA']).optional(),
  whatsapp_opted_in: z.boolean().optional(),
  sms_opted_in: z.boolean().optional(),
  preferred_language: z.enum(['mr', 'hi', 'en']).optional(),
});

router.post('/me/profile', verifyJWT, requireRole('donor'), async (req, res) => {
  const parsed = profileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const d = parsed.data;
  if (Object.keys(d).length === 0) return res.status(400).json({ error: 'no_fields_to_update' });

  // full_name is column-encrypted: changing it means re-sealing AND
  // recomputing the blind index in lockstep (duplicate detection queries it).
  const nameSealed = d.full_name != null ? seal(d.full_name) : null;
  const nameBidx = d.full_name != null ? blindIndex(d.full_name) : null;

  try {
    const passport = await withRlsContext(
      req,
      async (c) => {
        const r = await c.query(
          // updated_at is maintained by a BEFORE UPDATE trigger. Every SET
          // target is a fixed column name; all values are placeholders.
          `UPDATE donors SET
              full_name                 = COALESCE($2, full_name),
              full_name_bidx            = COALESCE($3, full_name_bidx),
              gender                    = COALESCE($4, gender),
              date_of_birth             = COALESCE($5::date, date_of_birth),
              blood_group_self_reported = COALESCE($6::int, blood_group_self_reported),
              village_id                = COALESCE($7::int, village_id),
              max_travel_km             = COALESCE($8::int, max_travel_km),
              preferred_contact_channel = COALESCE($9, preferred_contact_channel),
              whatsapp_opted_in         = COALESCE($10::boolean, whatsapp_opted_in),
              sms_opted_in              = COALESCE($11::boolean, sms_opted_in),
              preferred_language        = COALESCE($12, preferred_language)
            WHERE platform_user_id = $1
        RETURNING id`,
          [
            req.user.userId,
            nameSealed,
            nameBidx,
            d.gender ?? null,
            d.date_of_birth ?? null,
            d.blood_group_self_reported ?? null,
            d.village_id ?? null,
            d.max_travel_km ?? null,
            d.preferred_contact_channel ?? null,
            d.whatsapp_opted_in ?? null,
            d.sms_opted_in ?? null,
            d.preferred_language ?? null,
          ],
        );
        if (r.rowCount === 0) return null;
        // Build the fresh passport on the SAME connection — no second pool
        // acquire / transaction just to re-read what we wrote.
        return buildPassport(c, r.rows[0].id);
      },
      { change_reason: 'donor self profile update' },
    );
    if (passport === null) return res.status(404).json({ error: 'donor_profile_not_found' });
    res.json(passport);
  } catch (err) {
    // DB guards: age CHECK (23514), village_id FK (23503), bad date (2200x).
    if (['23514', '23503', '22007', '22008'].includes(err.code)) {
      return res
        .status(400)
        .json({ error: 'invalid_field_value', detail: err.detail || err.message });
    }
    throw err;
  }
});

// ── GET /donors/:id/passport ─────────────────────────────────────────────
router.get('/:id/passport', verifyJWT, async (req, res) => {
  // Self / coordinator / admin / blood_bank can read; RLS gates the underlying
  // donors row read in buildPassport().
  const passport = await withRlsContext(req, (c) => buildPassport(c, req.params.id));
  if (!passport) return res.status(404).json({ error: 'donor_not_found_or_no_access' });
  res.json(passport);
});

// ── POST /donors/:id/availability ────────────────────────────────────────
router.post('/:id/availability', verifyJWT, requireRole('donor'), async (req, res) => {
  const schema = z.object({
    is_available: z.boolean(),
    available_hours_start: z.number().int().min(0).max(23).optional(),
    available_hours_end: z.number().int().min(0).max(23).optional(),
    emergency_override: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const fields = Object.entries(parsed.data);
  const setSql = fields.map(([k], i) => `${k} = $${i + 3}`).join(', ');
  const values = [req.params.id, req.user.userId, ...fields.map(([, v]) => v)];

  const r = await withRlsContext(
    req,
    // setSql is a comma-joined list of `<col> = $<n>` fragments where every
    // `<col>` comes from the Zod schema's whitelisted keys (is_available,
    // available_hours_*, emergency_override). All values flow through
    // parameter placeholders. No user input touches the SQL string.
    (c) =>
      c.query(
        // eslint-disable-next-line no-restricted-syntax
        `UPDATE donors SET ${setSql}
          WHERE id = $1 AND platform_user_id = $2
       RETURNING id, is_available, available_hours_start, available_hours_end, emergency_override`,
        values,
      ),
    { change_reason: 'donor toggled availability' },
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_not_owner' });
  res.json(r.rows[0]);
});

// ── POST /donors/:id/consent ─────────────────────────────────────────────
// Spec §3 trg_donors_consent_protect rejects this from non-donor actors.
router.post('/:id/consent', verifyJWT, requireRole('donor'), async (req, res) => {
  const schema = z.object({ consent_data_use: z.boolean() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  try {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donors
              SET consent_data_use = $3,
                  consent_given_at = CASE WHEN $3 = TRUE THEN clock_timestamp() ELSE consent_given_at END
            WHERE id = $1 AND platform_user_id = $2
        RETURNING id, consent_data_use, consent_given_at`,
          [req.params.id, req.user.userId, parsed.data.consent_data_use],
        ),
      { change_reason: 'donor consent change' },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found_or_not_owner' });
    res.json(r.rows[0]);
  } catch (err) {
    if (/consent.*donor themselves/i.test(err.message)) {
      return res.status(403).json({ error: 'consent_self_only' });
    }
    throw err;
  }
});

// ── POST /donors/:id/blood-group/verify (blood_bank only) ────────────────
// Spec §5.4: blood_group_verified is the ONLY field used in matching, and
// can ONLY be written by the bb_writer Postgres role used by the blood-bank
// API connection. RLS enforces; the route additionally checks role.
router.post('/:id/blood-group/verify', verifyJWT, requireRole('blood_bank'), async (req, res) => {
  const schema = z.object({
    blood_group_id: z.number().int().min(1).max(8),
    verification_method: z.string().min(2).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  // bb_writer-roled connection is acquired here. Note: in the
  // current pool config, all backend connections run as the migration user
  // which is a member of bb_writer. The role gating is enforced by the RLS
  // policy on donors UPDATE which inspects raktify.actor_role.
  const r = await withRlsContext(
    req,
    (c) =>
      c.query(
        `UPDATE donors
              SET blood_group_verified = $1,
                  blood_group_verified_at = clock_timestamp(),
                  blood_group_verified_by = $2
            WHERE id = $3
        RETURNING id, blood_group_verified, blood_group_verified_at`,
        [parsed.data.blood_group_id, req.user.institutionId, req.params.id],
      ),
    { change_reason: 'lab blood-group verification' },
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

// ── POST /donors/merge (ngo_admin) ───────────────────────────────────────
router.post('/merge', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (_req, res) => {
  // STUB. See services/donors/merge.js for the design and the reason this
  // is gated until the medical advisor confirms deferral merge semantics.
  res
    .status(501)
    .json({ error: 'not_implemented', message: 'donor merge pending medical-advisor review' });
});

// ── POST /donors/bulk-upload (ngo_admin + blood_bank) ────────────────────
// Bulk-import legacy donor records. Imported rows are INERT until the
// donor next walks in for a donation OR self-activates via web register.
// They DO NOT receive any outbound WhatsApp on import. The matching
// engine already excludes consent_data_use=FALSE so imported rows are
// invisible to alerts.
//
// Payload: array of donor objects parsed from CSV client-side.
//   Required per row: full_name, mobile, blood_group_code
//   Optional:         date_of_birth (YYYY-MM-DD), gender (M/F/O), pincode,
//                     village_id
//
// Response: per-row results { imported, skipped_duplicate, invalid }.
//
// registration_source:
//   ngo_admin invokes        → 'IMP'  (general NGO-side import)
//   blood_bank staff invokes → 'BBK'  (blood-bank historical record import)
//
// RLS: writes use actor_role='registration' (donors_register policy admits).
const BG_CODE_TO_ID = {
  'A+': 1,
  'A-': 2,
  'B+': 3,
  'B-': 4,
  'AB+': 5,
  'AB-': 6,
  'O+': 7,
  'O-': 8,
};

const bulkRowSchema = z.object({
  full_name: z.string().trim().min(2).max(120),
  mobile: z.string(),
  blood_group_code: z.string().toUpperCase(),
  date_of_birth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .or(z.literal('')),
  gender: z.enum(['M', 'F', 'O']).optional().or(z.literal('')),
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .optional()
    .or(z.literal('')),
  village_id: z.number().int().positive().optional(),
});

const bulkPayloadSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(2000),
});

router.post(
  '/bulk-upload',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin', 'blood_bank'),
  async (req, res) => {
    const parsed = bulkPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const source = req.user.role === 'blood_bank' ? 'BBK' : 'IMP';
    const results = [];
    let imported = 0;
    let skipped = 0;
    let invalid = 0;

    // Process rows sequentially — per-row tx so a bad row doesn't poison
    // the whole batch. 2000-row cap (validation above) bounds total time.
    for (let i = 0; i < parsed.data.rows.length; i += 1) {
      const raw = parsed.data.rows[i];
      const row = bulkRowSchema.safeParse(raw);
      if (!row.success) {
        results.push({
          row_index: i,
          status: 'invalid',
          reason: row.error.issues[0]?.message || 'schema',
        });
        invalid += 1;
        continue;
      }
      const data = row.data;
      const mobile = normaliseIndianMobile(data.mobile);
      if (!mobile) {
        results.push({ row_index: i, status: 'invalid', reason: 'invalid_mobile_format' });
        invalid += 1;
        continue;
      }
      const bloodGroupId = BG_CODE_TO_ID[data.blood_group_code];
      if (!bloodGroupId) {
        results.push({ row_index: i, status: 'invalid', reason: 'unknown_blood_group_code' });
        invalid += 1;
        continue;
      }

      try {
        const inserted = await withRlsContextRaw(
          {
            actor_role: 'registration',
            change_reason: `bulk import (${source})`,
            actor_user_id: req.user.userId,
          },
          async (c) => {
            // Skip if a donor row already exists with this mobile —
            // duplicate detection by exact mobile match.
            const existing = await c.query(`SELECT id FROM donors WHERE mobile = $1`, [mobile]);
            if (existing.rowCount > 0) {
              return { kind: 'skipped', donor_id: existing.rows[0].id };
            }

            // Insert platform_users row first (auto-upsert mobile, donor role).
            const userR = await c.query(
              // Same partial-index-aware upsert as the web /register path.
              `INSERT INTO platform_users (role, mobile)
               VALUES ('donor', $1)
               ON CONFLICT (mobile) WHERE mobile IS NOT NULL AND role = 'donor'
                 DO UPDATE SET role = platform_users.role
               RETURNING id`,
              [mobile],
            );
            const platformUserId = userR.rows[0].id;

            // Insert donor row. consent_data_use stays FALSE (default).
            // mobile_verified stays FALSE — they haven't OTP'd from this
            // device. blood_group_self_reported gets the upload value;
            // blood_group_verified stays NULL (BB will verify in person).
            const donorR = await c.query(
              `INSERT INTO donors (
                 mobile, full_name, date_of_birth, gender,
                 pincode, village_id,
                 blood_group_self_reported,
                 platform_user_id,
                 registration_source, full_name_bidx)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
               RETURNING id`,
              [
                mobile,
                seal(data.full_name), // donor name — column-encrypted (main key)
                data.date_of_birth || null,
                data.gender || null,
                data.pincode || null,
                data.village_id || null,
                bloodGroupId,
                platformUserId,
                source,
                blindIndex(data.full_name), // duplicate-lookup index for the sealed name
              ],
            );
            return { kind: 'imported', donor_id: donorR.rows[0].id };
          },
        );

        if (inserted.kind === 'imported') {
          imported += 1;
          results.push({ row_index: i, status: 'imported', donor_id: inserted.donor_id });
        } else {
          skipped += 1;
          results.push({ row_index: i, status: 'skipped_duplicate', donor_id: inserted.donor_id });
        }
      } catch (err) {
        invalid += 1;
        results.push({
          row_index: i,
          status: 'invalid',
          reason: err.message?.slice(0, 200) || 'insert_failed',
        });
      }
    }

    res.json({
      total: parsed.data.rows.length,
      imported,
      skipped_duplicate: skipped,
      invalid,
      source,
      results,
    });
  },
);

// ── POST /donors/:id/complete-import (blood_bank) ────────────────────────
// BB activates an imported donor at the point of donation — captures
// consent + the missing fields (DOB, gender, etc.). After this, the
// donor is treated as fully-registered (consent_data_use=TRUE,
// mobile_verified=TRUE — the BB physically saw them).
//
// Only allowed when the donor was imported (consent_data_use = FALSE).
// Idempotent failure: trying to "complete" an already-active donor
// returns 409.
const completeImportSchema = z.object({
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['M', 'F', 'O']),
  blood_group_self_reported: z.number().int().min(1).max(8).optional(),
  pincode: z
    .string()
    .regex(/^[1-9]\d{5}$/)
    .optional()
    .or(z.literal('')),
  address_line: z.string().max(240).optional().or(z.literal('')),
  village_id: z.number().int().positive().optional(),
  prescreening_answers: z.record(z.string(), z.enum(['YES', 'NO'])).optional(),
  // Consent capture — BB confirms verbally with the donor + ticks the box.
  consent_given: z.literal(true),
});

router.post(
  '/:id/complete-import',
  verifyJWT,
  requireRole('blood_bank', 'ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = completeImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const data = parsed.data;

    // Pre-screening evaluation against the signed-off bank — same as web register.
    if (data.prescreening_answers) {
      const verdict = eligibility.evaluate(data.prescreening_answers);
      if (!verdict.eligible) {
        return res.status(200).json({
          status: 'soft_decline',
          reason: 'permanent_exclusion',
          blocks: verdict.permanent_blocks,
        });
      }
    }

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donors
              SET date_of_birth          = $1,
                  gender                 = $2,
                  blood_group_self_reported = COALESCE($3, blood_group_self_reported),
                  pincode                = COALESCE(NULLIF($4, ''), pincode),
                  address_line           = COALESCE(NULLIF($5, ''), address_line),
                  village_id             = COALESCE($6, village_id),
                  consent_data_use       = TRUE,
                  consent_given_at       = NOW(),
                  consent_version        = COALESCE(consent_version, 1),
                  mobile_verified        = TRUE,
                  mobile_verified_at     = NOW()
            WHERE id = $7
              AND consent_data_use = FALSE
         RETURNING id, full_name, mobile`,
          [
            data.date_of_birth,
            data.gender,
            data.blood_group_self_reported || null,
            data.pincode || '',
            // Seal only when present — keep '' so the SQL's NULLIF($5,'')
            // "empty means don't overwrite" semantics still work.
            data.address_line ? seal(data.address_line) : '',
            data.village_id || null,
            req.params.id,
          ],
        ),
      { change_reason: 'BB completes imported donor registration' },
    );
    if (r.rowCount === 0) {
      return res.status(409).json({ error: 'donor_already_consented_or_not_found' });
    }
    const donor = r.rows[0];
    donor.full_name = open(donor.full_name); // column-encrypted at rest
    res.json({ status: 'activated', donor });
  },
);

module.exports = router;
