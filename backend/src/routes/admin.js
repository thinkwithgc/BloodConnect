/**
 * NGO admin / ops endpoints (Phase 6 + Phase 8 + post-Phase-8).
 *
 *   GET  /admin/jobs                          list registered scheduler jobs
 *   POST /admin/jobs/run                      manually trigger one job (super_admin)
 *
 *   GET  /admin/coordinators                  list (filter: status=PE|AC|SU)
 *   POST /admin/coordinators/:id/verify       verification-queue approve
 *   POST /admin/coordinators/:id/suspend      suspend an active coordinator
 *
 *   GET  /admin/duplicates                    suspected_duplicate_of pairs
 *   POST /admin/duplicates/:id/clear          clear the flag (false positive)
 *   POST /admin/duplicates/:id/merge          STUB — see services/donors/merge.js
 *
 *   GET  /admin/referrals                     institution_referrals funnel summary
 *
 *   GET  /admin/audit                         filterable audit_log_safe view
 *                                             (table, record, actor, event type,
 *                                              since, until, limit)
 *   GET  /admin/audit/integrity               sample N rows + verify hash chain
 *
 *   POST /admin/community-leaders             invite a new community_leader
 *   GET  /admin/community-leaders             list (filter: status=active|suspended)
 *   POST /admin/community-leaders/:id/suspend  suspend a leader (auto-handover to co-leader is Phase 2)
 *   POST /admin/community-leaders/:id/reactivate  un-suspend a leader
 */
const express = require('express');
const { z } = require('zod');

const env = require('../config/env');
const { pool } = require('../config/db');
const { withRlsContext } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { normaliseIndianMobile } = require('../utils/phone');
const { redactAuditRow } = require('../utils/auditRedaction');
const { openRows, seal } = require('../services/pii');
const crypto = require('crypto');
const scheduler = require('../services/scheduler');
const { sendNotification } = require('../services/notifications');
const logger = require('../config/logger');
const setupSvc = require('../services/users/setup');
const { ROSTER_COLUMNS, CREDENTIAL_STATES, toRosterRow } = require('../services/users/directory');
const { eraseDonor } = require('../services/donors/erasure');

const router = express.Router();

// ── Scheduler (Phase 6) ──────────────────────────────────────────────────
router.get('/jobs', verifyJWT, requireRole('ngo_admin', 'super_admin'), (_req, res) => {
  res.json({ jobs: scheduler.listJobs() });
});

router.post('/jobs/run', verifyJWT, requireRole('super_admin'), async (req, res) => {
  const schema = z.object({ name: z.string().min(2) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  try {
    const result = await scheduler.runJob(parsed.data.name);
    res.json(result);
  } catch (err) {
    if (/unknown_job/.test(err.message)) {
      return res.status(404).json({ error: err.message });
    }
    throw err;
  }
});

// ── Coordinator management (Phase 8) ─────────────────────────────────────
// Coordinator schema: id_verified_at marks ID-proof verification (NULL =
// pending verification). is_active gates operational availability. Spec §7
// "verification queue" = id_verified_at IS NULL. "Active" = is_active = TRUE
// AND id_verified_at IS NOT NULL. "Suspended" = is_active = FALSE AND
// suspended_at IS NOT NULL.
router.get(
  '/coordinators',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const status = req.query.status || null; // 'pending' | 'active' | 'suspended' | null
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT co.id, co.display_name, co.district_id, co.is_district_lead,
                co.is_active, co.on_duty, co.reliability_score,
                co.id_verified_at, co.id_verified_by, co.joined_at,
                co.suspended_at, co.suspension_reason,
                co.donations_facilitated, co.requests_fulfilled,
                co.median_response_time_min,
                co.platform_user_id
           FROM coordinators co
          WHERE CASE
                  WHEN $1::text = 'pending'   THEN co.id_verified_at IS NULL
                  WHEN $1::text = 'active'    THEN co.is_active = TRUE AND co.id_verified_at IS NOT NULL
                  WHEN $1::text = 'suspended' THEN co.suspended_at IS NOT NULL
                  ELSE TRUE
                END
       ORDER BY (co.id_verified_at IS NULL) DESC, co.joined_at DESC
          LIMIT 500`,
        [status],
      ),
    );
    res.json({ coordinators: r.rows, count: r.rowCount });
  },
);

// ── POST /admin/coordinators ─────────────────────────────────────────────
// Invite a new NGO-employed coordinator. Coordinator is staff-cluster
// auth (migration 282) — username + password + TOTP, NOT mobile + OTP.
// Same setup-link magic-link pattern as institutional admin staff:
// backend creates the platform_users + coordinators profile rows,
// generates a setup token, sends the activation WhatsApp template,
// returns the activation URL as fallback.
const inviteCoordinatorSchema = z.object({
  mobile: z.string(),
  full_name: z.string().min(2).max(120),
  display_name: z.string().min(2).max(80).optional(),
  username: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{2,31}$/)
    .optional(),
  email: z.string().email().optional(),
  state_id: z.number().int().positive(),
  district_id: z.number().int().positive(),
  taluka_id: z.number().int().positive().optional(),
  village_id: z.number().int().positive().optional(),
  preferred_language: z.enum(['mr', 'hi', 'en']).optional(),
  is_district_lead: z.boolean().optional(),
});

router.post(
  '/coordinators',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = inviteCoordinatorSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const data = parsed.data;
    const mobile = normaliseIndianMobile(data.mobile);
    if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

    // Auto-derive a username from the full_name if the caller didn't
    // provide one — pattern is firstname_coord (slugified). Caller can
    // override; uniqueness checked below.
    const fallbackUsername = (
      data.username
        ? data.username
        : `${data.full_name
            .toLowerCase()
            .trim()
            .split(/\s+/)[0]
            .replace(/[^a-z0-9]/g, '')}_coord`
    ).slice(0, 32);

    // Check username + mobile uniqueness BEFORE the transaction so the
    // common "already invited" case gets a clean 409 instead of a CHECK
    // violation deep in the insert.
    const dup = await pool.query(
      `SELECT id FROM platform_users WHERE username = $1 OR (mobile = $2 AND role IN ('hospital','blood_bank','ngo_admin','super_admin','dho','coordinator'))`,
      [fallbackUsername, mobile],
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: 'username_or_mobile_already_in_staff_cluster' });
    }

    try {
      const placeholderHash = await setupSvc.unusablePasswordHash();
      const result = await withRlsContext(
        req,
        async (c) => {
          // 1. platform_users row — staff auth path, placeholder password
          //    until the coord activates via the setup token.
          const userR = await c.query(
            `INSERT INTO platform_users
               (role, username, mobile, email, password_hash, password_set_at,
                force_password_change)
             VALUES ('coordinator', $1, $2, $3, $4, NOW(), TRUE)
             RETURNING id`,
            [fallbackUsername, mobile, data.email || null, placeholderHash],
          );
          const userId = userR.rows[0].id;

          // 2. coordinators profile row.
          const coR = await c.query(
            `INSERT INTO coordinators
               (platform_user_id, full_name, display_name,
                preferred_language, state_id, district_id, taluka_id, village_id,
                is_district_lead)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              userId,
              data.full_name,
              data.display_name || data.full_name,
              data.preferred_language || 'en',
              data.state_id,
              data.district_id,
              data.taluka_id || null,
              data.village_id || null,
              data.is_district_lead ?? false,
            ],
          );

          // 3. setup token for the activation magic link.
          const { token, expiresAt } = await setupSvc.generateSetupToken(c, userId);
          return {
            platform_user_id: userId,
            coordinator_id: coR.rows[0].id,
            username: fallbackUsername,
            setupToken: token,
            expiresAt,
          };
        },
        { change_reason: 'invite coordinator' },
      );

      // Send the activation WhatsApp (reuses the proven `institution_link`
      // template — the body works generically for "<role> on Raktify"
      // and the URL button goes to /activate/<token>). Best-effort: row
      // is still committed even if the WhatsApp send fails (admin can
      // re-send via reset-password or share the URL out-of-band).
      let waSent = false;
      let waMessageId = null;
      try {
        const r = await sendNotification({
          recipientId: mobile,
          templateType: 'SETUP_LINK',
          variables: {
            signatory_name: data.display_name || data.full_name,
            institution_name: 'Choudhari Foundation',
            setup_token: result.setupToken,
          },
          channel: 'WA',
          language: 'en',
        });
        if (r?.success) {
          waSent = true;
          waMessageId = r.messageId || r.message_id || null;
        } else {
          logger.warn(
            { r, coordinator_id: result.coordinator_id },
            'coordinator invite WhatsApp non-success',
          );
        }
      } catch (err) {
        logger.error({ err: err.message }, 'coordinator invite WhatsApp threw');
      }

      const activationUrl = `${env.frontendUrl}/activate/${result.setupToken}`;
      res.status(201).json({
        coordinator_id: result.coordinator_id,
        platform_user_id: result.platform_user_id,
        username: result.username,
        mobile,
        activation_url: activationUrl,
        whatsapp_sent: waSent,
        whatsapp_message_id: waMessageId,
        next_step: waSent
          ? `Activation WhatsApp sent to ${mobile}. They'll set their password, then sign in at /staff/login as "${result.username}".`
          : `Row created. WhatsApp did NOT send — share the activation URL out-of-band so they can sign in as "${result.username}".`,
      });
    } catch (err) {
      if (err.code === '23514') {
        return res.status(400).json({
          error: 'check_violation',
          constraint: err.constraint || 'unknown',
          detail: err.detail || err.message,
        });
      }
      if (/idx_platform_users_mobile_staff_cluster/.test(err.message)) {
        return res.status(409).json({ error: 'mobile_already_in_staff_cluster' });
      }
      logger.error({ err: err.message, code: err.code }, 'coordinator invite failed');
      return res.status(500).json({ error: 'invite_failed', detail: err.message });
    }
  },
);

router.post(
  '/coordinators/:id/verify',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE coordinators
              SET id_verified_at = clock_timestamp(),
                  id_verified_by = $2,
                  is_active = TRUE
            WHERE id = $1
              AND id_verified_at IS NULL
         RETURNING id, id_verified_at, is_active`,
          [req.params.id, req.user.userId],
        ),
      { change_reason: 'admin verifies coordinator' },
    );
    if (r.rowCount === 0) return res.status(409).json({ error: 'not_pending_or_not_found' });
    res.json(r.rows[0]);
  },
);

router.post(
  '/coordinators/:id/suspend',
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
          `UPDATE coordinators
              SET is_active = FALSE,
                  on_duty = FALSE,
                  suspended_at = clock_timestamp(),
                  suspension_reason = $2
            WHERE id = $1
         RETURNING id, is_active, suspended_at`,
          [req.params.id, parsed.data.reason],
        ),
      { change_reason: `admin suspends coordinator: ${parsed.data.reason}` },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  },
);

// ── Institution staff-user directory (cross-institution) ─────────────────
// The one screen that answers "is anyone stuck?".
//
// Every other surface is institution-scoped, which is exactly the blind spot
// that let an activated hospital sit with an undelivered setup link and nobody
// able to see it. The credential_state column here (services/users/directory.js)
// is what makes a stuck account visible: setup_expired / setup_pending on an
// account that never signed in is the signature of a SETUP_LINK that silently
// failed to send.
//
// `dho` rows are included: they are institution-scoped staff logins provisioned
// the same way, and a DHO who never received their link is the same problem.
// Their `institution_id` is usually NULL, so the join is a LEFT JOIN.
const institutionUsersQuerySchema = z
  .object({
    institution_id: z.string().uuid().optional(),
    role: z.enum(['hospital', 'blood_bank', 'dho']).optional(),
    state: z.enum(CREDENTIAL_STATES).optional(),
    q: z.string().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .strict();

router.get(
  '/institution-users',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = institutionUsersQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_query', details: parsed.error.format() });
    }
    const { institution_id, role, state, q, limit } = parsed.data;

    // institution_id / role / q filter in SQL; `state` filters in JS because
    // credential_state is computed (it depends on "now" relative to
    // locked_until and setup_token_expires_at) and must stay defined in exactly
    // one place — duplicating that precedence as a SQL CASE is how the two
    // surfaces would drift apart.
    const where = [`pu.role IN ('hospital','blood_bank','dho')`];
    const params = [];
    if (institution_id) {
      params.push(institution_id);
      where.push(`pu.institution_id = $${params.length}`);
    }
    if (role) {
      params.push(role);
      where.push(`pu.role = $${params.length}`);
    }
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(
        `(LOWER(pu.username) LIKE $${params.length}
          OR LOWER(COALESCE(i.display_name, '')) LIKE $${params.length}
          OR LOWER(COALESCE(i.shortname, '')) LIKE $${params.length})`,
      );
    }

    const r = await withRlsContext(req, (c) =>
      c.query(
        // ROSTER_COLUMNS is a module constant; `where` is built from
        // Zod-validated enums and numbered placeholders only — every user value
        // is a parameter.
        // eslint-disable-next-line no-restricted-syntax
        `SELECT ${ROSTER_COLUMNS},
                i.shortname        AS institution_shortname,
                i.display_name     AS institution_display_name,
                i.kind             AS institution_kind,
                i.onboarding_status AS institution_onboarding_status,
                db.username        AS deactivated_by_username
           FROM platform_users pu
      LEFT JOIN institutions i ON i.id = pu.institution_id
      LEFT JOIN platform_users db ON db.id = pu.deactivated_by
          WHERE ${where.join(' AND ')}
          ORDER BY i.display_name NULLS FIRST,
                   pu.is_institution_admin DESC,
                   pu.username ASC`,
        params,
      ),
    );

    const now = new Date();
    let users = r.rows.map((row) => toRosterRow(row, now));
    if (state) users = users.filter((u) => u.credential_state === state);

    // Counts are computed over the UNFILTERED set so the tab can show
    // "3 stuck" while the operator is looking at a single state.
    const stateCounts = {};
    for (const s of CREDENTIAL_STATES) stateCounts[s] = 0;
    for (const row of r.rows) stateCounts[toRosterRow(row, now).credential_state] += 1;

    const total = users.length;
    if (limit) users = users.slice(0, limit);

    res.json({
      users,
      count: users.length,
      total,
      state_counts: stateCounts,
      // Accounts that cannot sign in and never have — the actionable set.
      needs_attention: stateCounts.setup_expired + stateCounts.locked,
    });
  },
);

// ── Duplicate donor review (Phase 8) ─────────────────────────────────────
router.get('/duplicates', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT d.id AS suspected_id, d.full_name, d.date_of_birth,
                d.suspected_duplicate_of AS canonical_id,
                cd.full_name AS canonical_name, cd.date_of_birth AS canonical_dob,
                d.created_at
           FROM donors d
           JOIN donors cd ON cd.id = d.suspected_duplicate_of
          WHERE d.suspected_duplicate_of IS NOT NULL
       ORDER BY d.created_at DESC
          LIMIT 200`,
    ),
  );
  // full_name + canonical_name are column-encrypted at rest.
  openRows(r.rows, ['full_name', 'canonical_name']);
  res.json({ pairs: r.rows, count: r.rowCount });
});

router.post(
  '/duplicates/:id/clear',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE donors
              SET suspected_duplicate_of = NULL
            WHERE id = $1
              AND suspected_duplicate_of IS NOT NULL
         RETURNING id`,
          [req.params.id],
        ),
      { change_reason: 'admin cleared duplicate flag (false positive)' },
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'not_flagged_or_not_found' });
    res.json({ status: 'cleared', donor_id: r.rows[0].id });
  },
);

// Merge is still a stub — see services/donors/merge.js for the design notes
// (worst-case vs strictest deferral_until). Pre-condition: medical-advisor
// confirmation of the merge semantics.
router.post(
  '/duplicates/:id/merge',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (_req, res) => {
    res
      .status(501)
      .json({ error: 'not_implemented', detail: 'see services/donors/merge.js design notes' });
  },
);

// ── Donor erasure — DPDP §12 (right to erasure) ──────────────────────────
// Admin-initiated on a verified donor request (app button, WhatsApp, phone).
// Anonymises the donor + auth row, keeps the de-identified clinical record.
// Blocked while an open lookback references the donor (services/donors/erasure.js).
router.post(
  '/donors/:id/erase',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const result = await withRlsContext(req, (c) => eraseDonor(c, req.params.id), {
      change_reason: 'dpdp_erasure',
    });
    if (!result.ok) {
      const code = result.error === 'donor_not_found' ? 404 : 409;
      return res.status(code).json(result);
    }
    res.json(result);
  },
);

// ── Referral funnel (Phase 8) ────────────────────────────────────────────
// funnel_status: NE=new, CO=contacted, IN=interested, ON=onboarded,
//                DC=declined, DR=dropped (institution_referrals.sql)
router.get('/referrals', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const summary = await withRlsContext(req, (c) =>
    c.query(
      `SELECT funnel_status, COUNT(*)::int AS count
           FROM institution_referrals
          GROUP BY funnel_status
          ORDER BY funnel_status`,
    ),
  );
  const recent = await withRlsContext(req, (c) =>
    c.query(
      `SELECT id, target_kind, target_name, target_district_id,
                target_contact_name,
                funnel_status, status_changed_at, status_changed_by, notes,
                onboarded_institution_id, onboarded_at, declined_reason,
                referrer_count,
                created_at
           FROM institution_referrals
       ORDER BY created_at DESC
          LIMIT 100`,
    ),
  );

  // Conversion rate: onboarded / total. Denominator excludes nothing —
  // every referral started in NE. Spec doesn't define a 'reaches' baseline.
  const total = summary.rows.reduce((s, r) => s + r.count, 0);
  const onboarded = summary.rows.find((r) => r.funnel_status === 'ON')?.count || 0;
  const conversion_rate = total === 0 ? 0 : onboarded / total;

  res.json({
    funnel: summary.rows,
    total,
    onboarded,
    conversion_rate,
    recent: recent.rows,
  });
});

// ── Audit log viewer (Phase 8) ───────────────────────────────────────────
// Reads the `audit_log_safe` view, which masks row_hash / previous_row_hash
// and is the only audit object granted to a normal application role.
//
// Filterable by record_id as well as table, so "the history of this one
// institution / donor / user" is a query rather than a scan the caller does
// client-side. Values on credential fields are withheld by redactAuditRow()
// — see utils/auditRedaction.js for why the trigger writes them at all.
router.get('/audit', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const schema = z.object({
    table_name: z.string().optional(),
    // audit_log.record_id is TEXT, not UUID (025_audit_log.sql), because the log
    // spans tables with different key types. Every table this endpoint is used
    // against has a UUID key, so validate as one and cast on the way in — a
    // malformed value then gets a 400 rather than a 22P02 out of Postgres.
    record_id: z.string().uuid().optional(),
    actor_user_id: z.string().uuid().optional(),
    event_type: z.enum(['INSERT', 'UPDATE', 'DELETE']).optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const f = parsed.data;

  const r = await pool.query(
    `SELECT id, event_time, event_type, table_name, record_id, field_name,
              old_value, new_value,
              actor_user_id, actor_role, actor_institution_id,
              request_reference, change_reason
         FROM audit_log_safe
        WHERE ($1::text IS NULL OR table_name = $1)
          AND ($2::text IS NULL OR record_id = $2)
          AND ($3::uuid IS NULL OR actor_user_id = $3)
          AND ($4::text IS NULL OR event_type = $4)
          AND ($5::timestamptz IS NULL OR event_time >= $5)
          AND ($6::timestamptz IS NULL OR event_time <= $6)
     ORDER BY event_time DESC
        LIMIT $7`,
    [
      f.table_name || null,
      f.record_id || null,
      f.actor_user_id || null,
      f.event_type || null,
      f.since || null,
      f.until || null,
      f.limit,
    ],
  );
  const rows = r.rows.map(redactAuditRow);
  res.json({ rows, count: rows.length });
});

// Hash-chain integrity check: pull the most recent N audit rows in event-time
// order and recompute each row's expected `previous_row_hash` from the row
// before it. Any mismatch indicates tampering or out-of-order writes.
router.get(
  '/audit/integrity',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    // We need the raw audit_log here (not the safe view) because integrity
    // verification must use the row_hash + previous_row_hash columns. Those
    // columns are not exposed via audit_log_safe. The pool runs as
    // audit_reader so SELECT on audit_log is permitted (if not, this returns
    // 500 — a deliberate signal that infra needs the GRANT fixed).
    let rows;
    try {
      const r = await pool.query(
        `SELECT id, event_time, table_name, record_id,
                row_hash, previous_row_hash
           FROM audit_log
       ORDER BY event_time DESC, id DESC
          LIMIT $1`,
        [limit],
      );
      rows = r.rows.reverse(); // oldest → newest for chain check
    } catch (err) {
      return res.status(500).json({
        error: 'audit_read_denied',
        detail: 'pool role cannot SELECT audit_log — check audit_reader grants',
        message: err.message,
      });
    }

    let breaks = 0;
    const broken = [];
    for (let i = 1; i < rows.length; i += 1) {
      if (rows[i].previous_row_hash !== rows[i - 1].row_hash) {
        breaks += 1;
        broken.push({
          id: rows[i].id,
          event_time: rows[i].event_time,
          expected_prev: rows[i - 1].row_hash,
          actual_prev: rows[i].previous_row_hash,
        });
        if (broken.length >= 20) break; // cap response size
      }
    }
    res.json({
      sampled: rows.length,
      breaks,
      ok: breaks === 0,
      broken_examples: broken,
    });
  },
);

// ── GET /admin/communities ───────────────────────────────────────────────
// Director / NGO admin view of ALL communities across the platform.
// Returns owner display_name (whether coordinator-owned or
// community_leader-owned), region, denormalised counters, status.
// Filter: ?status=active|suspended|all (default all). ?owner_type=
// coordinator|community_leader|all (default all).
router.get('/communities', verifyJWT, requireRole('ngo_admin', 'super_admin'), async (req, res) => {
  const status = req.query.status || 'all';
  const ownerType = req.query.owner_type || 'all';
  // owner_id filter — drives the "leader drill-down" UX. When set,
  // returns communities OWNED OR CO-LED by that leader (or coordinator).
  // Empty/null = no filter (the default flat list).
  const ownerId = req.query.owner_id || null;
  const r = await withRlsContext(req, (c) =>
    c.query(
      `SELECT co.id, co.name, co.slug, co.description,
                co.is_public, co.is_active,
                co.donor_count, co.active_donor_count, co.donations_facilitated,
                co.created_at,
                s.name AS state_name,
                d.name AS district_name,
                t.name AS taluka_name,
                CASE
                  WHEN co.owner_community_leader_id IS NOT NULL THEN 'community_leader'
                  WHEN co.owner_coordinator_id IS NOT NULL THEN 'coordinator'
                  ELSE 'unknown'
                END AS owner_type,
                COALESCE(cl.display_name, coord.display_name) AS owner_display_name,
                COALESCE(co.owner_community_leader_id::text, co.owner_coordinator_id::text)
                  AS owner_id,
                (SELECT COUNT(*)::int FROM community_moderators cm
                  WHERE cm.community_id = co.id) AS moderator_count,
                CASE
                  WHEN $3::text IS NULL THEN NULL
                  WHEN co.owner_community_leader_id::text = $3 THEN 'owner'
                  WHEN co.owner_coordinator_id::text      = $3 THEN 'owner'
                  ELSE 'co_leader'
                END AS relation
           FROM communities co
           LEFT JOIN community_leaders cl   ON cl.id    = co.owner_community_leader_id
           LEFT JOIN coordinators       coord ON coord.id = co.owner_coordinator_id
           LEFT JOIN states    s ON s.id = co.state_id
           LEFT JOIN districts d ON d.id = co.district_id
           LEFT JOIN talukas   t ON t.id = co.taluka_id
          WHERE CASE
                  WHEN $1 = 'active'    THEN co.is_active = TRUE
                  WHEN $1 = 'suspended' THEN co.is_active = FALSE
                  ELSE TRUE
                END
            AND CASE
                  WHEN $2 = 'community_leader' THEN co.owner_community_leader_id IS NOT NULL
                  WHEN $2 = 'coordinator'      THEN co.owner_coordinator_id IS NOT NULL
                  ELSE TRUE
                END
            AND ($3::text IS NULL
                 OR co.owner_community_leader_id::text = $3
                 OR co.owner_coordinator_id::text      = $3
                 OR co.id IN (
                   SELECT community_id FROM community_moderators
                    WHERE community_leader_id::text = $3
                       OR coordinator_id::text      = $3
                 ))
          ORDER BY co.created_at DESC
          LIMIT 500`,
      [status, ownerType, ownerId],
    ),
  );
  res.json({ communities: r.rows, count: r.rowCount });
});

// ── Community-leader management (post-Phase-8) ───────────────────────────
// External volunteers who run pre-existing donor communities (WhatsApp
// groups). NGO admin invites them; they log in via mobile + OTP (donor-style
// auth path). Profile lives in community_leaders (migration 271). See the
// Phase 1 plan in this session for the full taxonomy + capability split.
//
// Activation is intentionally low-friction in v1: the NGO admin enters
// mobile + name, backend inserts both rows, then NGO admin tells the leader
// out-of-band ("I've added you, log in at raktify.choudhari.ngo/login").
// No setup token / no automatic WhatsApp template — the leader's existing
// WhatsApp group is THEIR comms channel, we don't insert ourselves into it.
//
// Phase 2 adds: communities CRUD, co-leader mgmt, suspension auto-handover.
// Phase 3 adds: donor roster, referral attribution, public community page.

const inviteLeaderSchema = z.object({
  mobile: z.string(),
  full_name: z.string().min(2).max(120),
  display_name: z.string().min(2).max(80),
  preferred_language: z.enum(['mr', 'hi', 'en']).optional(),
  state_id: z.number().int().positive().optional(),
  district_id: z.number().int().positive().optional(),
  email: z.string().email().optional(),
  invitation_notes: z.string().max(500).optional(),
});

router.post(
  '/community-leaders',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = inviteLeaderSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const data = parsed.data;
    const mobile = normaliseIndianMobile(data.mobile);
    if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

    // The OTP-cluster partial unique index (migration 269) prevents two leader
    // rows for one mobile. Check explicitly so we can return a clean 409
    // instead of letting the DB raise a violation that the user has to parse.
    const existing = await pool.query(
      `SELECT id FROM platform_users WHERE mobile = $1 AND role = 'community_leader'`,
      [mobile],
    );
    if (existing.rowCount > 0) {
      return res.status(409).json({ error: 'mobile_already_invited' });
    }

    try {
      const result = await withRlsContext(
        req,
        async (c) => {
          // 1. platform_users row — OTP-auth path, no password.
          const userR = await c.query(
            `INSERT INTO platform_users (role, mobile)
             VALUES ('community_leader', $1)
             RETURNING id`,
            [mobile],
          );
          const userId = userR.rows[0].id;

          // 2. community_leaders profile row — approved immediately since the
          //    ngo_admin's invite IS the approval.
          const profR = await c.query(
            `INSERT INTO community_leaders
               (platform_user_id, full_name, display_name,
                preferred_language, state_id, district_id,
                email, invitation_notes,
                approved_at, approved_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
             RETURNING id`,
            [
              userId,
              data.full_name,
              data.display_name,
              data.preferred_language || 'en',
              data.state_id || null,
              data.district_id || null,
              data.email || null,
              data.invitation_notes || null,
              req.user.userId,
            ],
          );
          return { platform_user_id: userId, community_leader_id: profR.rows[0].id };
        },
        { change_reason: 'invite community_leader' },
      );

      // Fire the welcome WhatsApp (community_leader_welcome template). This
      // is best-effort — if the template isn't approved yet, or Meta has a
      // transient issue, we still return success for the invite (the row is
      // created; the admin can re-send manually). The send failure is logged
      // so ops can spot template approval/billing problems.
      let waSent = false;
      let waMessageId = null;
      try {
        // Send in English — the signin template is only registered in en
        // at Meta today. Sending with language='mr'/'hi' returns Meta
        // error 132001 ("Template name does not exist in the translation").
        // The leader's preferred_language is still stored on their profile
        // for downstream messages once we register MR/HI translations.
        //
        // templateType: COMMUNITY_LEADER_SIGNIN (replaces the deprecated
        // COMMUNITY_LEADER_WELCOME — see comment in env.js / provider).
        // The mobile is passed in variables so the URL button substitution
        // (?m={{1}}) gets the per-recipient value Meta needs to read this
        // as Utility-class transactional, not Marketing.
        const sendResult = await sendNotification({
          recipientId: mobile,
          templateType: 'COMMUNITY_LEADER_SIGNIN',
          variables: {
            leader_name: data.display_name,
            organization_name: 'Choudhari Foundation',
            mobile,
          },
          channel: 'WA',
          language: 'en',
        });
        if (sendResult?.success) {
          waSent = true;
          waMessageId = sendResult.messageId || sendResult.message_id || null;
        } else {
          logger.warn(
            { sendResult, community_leader_id: result.community_leader_id },
            'community_leader_welcome send returned non-success — invite row created without delivery',
          );
        }
      } catch (err) {
        logger.error(
          { err: err.message, community_leader_id: result.community_leader_id },
          'community_leader_welcome send threw — invite row created without delivery',
        );
      }

      res.status(201).json({
        community_leader_id: result.community_leader_id,
        platform_user_id: result.platform_user_id,
        mobile,
        display_name: data.display_name,
        whatsapp_sent: waSent,
        whatsapp_message_id: waMessageId,
        next_step: waSent
          ? `WhatsApp invitation sent to ${mobile}. Leader taps "Sign in" → enters mobile → OTP → dashboard.`
          : `Row created but WhatsApp invitation did NOT send (template may still be pending Meta approval). Tell the leader out-of-band: log in at /login?role=community_leader with mobile ${mobile}.`,
      });
    } catch (err) {
      // Defensive: per-role index could still trip if a race happened
      // between the existence check above and the INSERT.
      if (/idx_platform_users_mobile_community_leader/.test(err.message)) {
        return res.status(409).json({ error: 'mobile_already_invited' });
      }
      // Postgres error code 23514 = check_violation. Surface a readable
      // version of which constraint tripped so the admin doesn't see a
      // bare "23514" in the UI.
      if (err.code === '23514') {
        logger.error(
          { constraint: err.constraint, table: err.table, detail: err.detail },
          'community_leader invite hit a CHECK constraint',
        );
        return res.status(400).json({
          error: 'check_violation',
          constraint: err.constraint || 'unknown',
          detail: err.detail || err.message,
        });
      }
      // Any other DB error: log + return generic 500. Don't leak DB internals.
      logger.error(
        { err: err.message, code: err.code, constraint: err.constraint },
        'community_leader invite failed',
      );
      return res.status(500).json({ error: 'invite_failed', detail: err.message });
    }
  },
);

router.get(
  '/community-leaders',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const status = req.query.status || 'all'; // 'active' | 'suspended' | 'all'
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT cl.id, cl.display_name, cl.is_active,
                cl.suspended_at, cl.suspension_reason,
                cl.communities_count, cl.total_donor_count,
                cl.donations_facilitated, cl.camps_hosted,
                cl.preferred_language, cl.joined_at, cl.created_at,
                cl.invitation_notes,
                pu.mobile, pu.last_login_at,
                d.name AS district_name,
                s.name AS state_name
           FROM community_leaders cl
           JOIN platform_users pu ON pu.id = cl.platform_user_id
           LEFT JOIN districts d ON d.id = cl.district_id
           LEFT JOIN states    s ON s.id = cl.state_id
          WHERE CASE
                  WHEN $1 = 'active'    THEN cl.is_active = TRUE
                  WHEN $1 = 'suspended' THEN cl.suspended_at IS NOT NULL
                  ELSE TRUE
                END
          ORDER BY cl.created_at DESC
          LIMIT 500`,
        [status],
      ),
    );
    // Mask mobile in the list view — the admin can see the last 4 digits,
    // but the full number stays masked at this scope per the donor-PII pattern.
    const leaders = r.rows.map((l) => ({
      ...l,
      mobile: l.mobile ? `+91XXXXX${l.mobile.slice(-4)}` : null,
    }));
    res.json({ leaders, count: r.rowCount });
  },
);

router.post(
  '/community-leaders/:id/suspend',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const schema = z.object({ reason: z.string().min(3).max(500) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE community_leaders
              SET suspended_at = NOW(),
                  suspended_by = $1,
                  suspension_reason = $2
            WHERE id = $3 AND suspended_at IS NULL
            RETURNING id, display_name`,
          [req.user.userId, parsed.data.reason, req.params.id],
        ),
      { change_reason: `suspend community_leader: ${parsed.data.reason.slice(0, 100)}` },
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'not_found_or_already_suspended' });
    }
    res.json({ community_leader_id: r.rows[0].id, status: 'suspended' });
  },
);

router.post(
  '/community-leaders/:id/reactivate',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE community_leaders
              SET suspended_at = NULL,
                  suspended_by = NULL,
                  suspension_reason = NULL
            WHERE id = $1 AND suspended_at IS NOT NULL
            RETURNING id, display_name`,
          [req.params.id],
        ),
      { change_reason: 'reactivate community_leader' },
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'not_found_or_already_active' });
    }
    res.json({ community_leader_id: r.rows[0].id, status: 'active' });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Vendor integrations — /admin/vendor-partners, /admin/partner-keys
//
// Manages vendor push webhook credentials (see /developers and
// backend/src/routes/vendor-webhooks.js). Reads open to ngo_admin +
// super_admin; writes are super_admin only because they mint / revoke
// bearer credentials.
//
// hmac_secret is stored sealed via services/pii/seal(). The plaintext is
// returned to the caller ONCE at issue time and never again.
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/vendor-partners — list vendors with aggregated key counts.
router.get(
  '/vendor-partners',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT v.id, v.name, v.contact_email, v.notes, v.created_at,
                COUNT(pk.partner_key) FILTER (WHERE pk.is_active) AS active_keys,
                COUNT(pk.partner_key) FILTER (WHERE pk.is_active AND pk.is_sandbox) AS sandbox_keys,
                COUNT(pk.partner_key)                                    AS total_keys
           FROM vendor_partners v
           LEFT JOIN partner_keys pk ON pk.vendor_partner_id = v.id
          GROUP BY v.id
          ORDER BY v.created_at DESC`,
      ),
    );
    res.json({ vendors: r.rows });
  },
);

// GET /admin/vendor-partners/:id — vendor details + keys grouped by
// institution. Never exposes the sealed hmac_secret.
router.get(
  '/vendor-partners/:id',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const vR = await withRlsContext(req, (c) =>
      c.query(`SELECT * FROM vendor_partners WHERE id = $1`, [req.params.id]),
    );
    if (vR.rowCount === 0) return res.status(404).json({ error: 'not_found' });

    const kR = await withRlsContext(req, (c) =>
      c.query(
        `SELECT pk.partner_key, pk.vendor_partner_id, pk.institution_id,
                pk.is_active, pk.is_sandbox, pk.created_at, pk.created_by,
                pk.rotated_from, pk.revoked_at, pk.revoked_by, pk.notes,
                i.shortname AS institution_shortname,
                i.display_name AS institution_display_name,
                i.kind AS institution_kind
           FROM partner_keys pk
           LEFT JOIN institutions i ON i.id = pk.institution_id
          WHERE pk.vendor_partner_id = $1
          ORDER BY pk.is_active DESC, pk.created_at DESC`,
        [req.params.id],
      ),
    );
    res.json({ vendor: vR.rows[0], keys: kR.rows });
  },
);

// POST /admin/vendor-partners — create a new vendor.
const createVendorSchema = z.object({
  name: z.string().min(2).max(120),
  contact_email: z.string().email().optional(),
  notes: z.string().max(1000).optional(),
});
router.post('/vendor-partners', verifyJWT, requireRole('super_admin'), async (req, res) => {
  const parsed = createVendorSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(422).json({ error: 'invalid_input', details: parsed.error.format() });
  }
  const { name, contact_email, notes } = parsed.data;
  try {
    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `INSERT INTO vendor_partners (name, contact_email, notes, created_by)
             VALUES ($1, $2, $3, $4)
             RETURNING id, name, contact_email, notes, created_at`,
          [name, contact_email || null, notes || null, req.user.userId],
        ),
      { change_reason: 'create vendor_partner' },
    );
    res.status(201).json({ vendor: r.rows[0] });
  } catch (err) {
    if (/unique constraint/i.test(err.message)) {
      return res.status(409).json({ error: 'vendor_name_taken' });
    }
    throw err;
  }
});

// POST /admin/vendor-partners/:id/keys — issue a new partner_key.
// Returns the plaintext HMAC secret exactly once. Callers MUST save it
// immediately; the DB only stores the sealed form.
const issueKeySchema = z
  .object({
    institution_id: z.string().uuid().optional(),
    institution_shortname: z.string().optional(),
    is_sandbox: z.boolean().optional().default(false),
    notes: z.string().max(1000).optional(),
  })
  .refine((d) => d.institution_id || d.institution_shortname, {
    message: 'either institution_id or institution_shortname is required',
    path: ['institution_id'],
  });
router.post(
  '/vendor-partners/:id/keys',
  verifyJWT,
  requireRole('super_admin'),
  async (req, res) => {
    const parsed = issueKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const { institution_id, institution_shortname, is_sandbox, notes } = parsed.data;

    // Sanity: does the vendor exist?
    const vR = await pool.query(`SELECT id FROM vendor_partners WHERE id = $1`, [req.params.id]);
    if (vR.rowCount === 0) return res.status(404).json({ error: 'vendor_not_found' });

    // Resolve institution by ID (preferred) or shortname (convenience for
    // the admin UI). Either identifies the target BB / HO uniquely.
    const iR = await pool.query(
      institution_id
        ? `SELECT id, shortname, display_name, onboarding_status FROM institutions WHERE id = $1`
        : `SELECT id, shortname, display_name, onboarding_status FROM institutions WHERE shortname = $1`,
      [institution_id || institution_shortname],
    );
    if (iR.rowCount === 0) return res.status(404).json({ error: 'institution_not_found' });
    const resolvedInstitutionId = iR.rows[0].id;
    if (iR.rows[0].onboarding_status !== 'AC' && !is_sandbox) {
      return res.status(409).json({
        error: 'institution_not_active',
        hint: 'Institution must be onboarded (status=AC) before issuing a prod key. Sandbox keys bypass this.',
      });
    }

    // Mint fresh key + secret.
    const partnerKey = `pk_${crypto.randomBytes(16).toString('base64url')}`;
    const secretPlain = crypto.randomBytes(32).toString('base64url');
    const sealedSecret = seal(secretPlain);

    try {
      await withRlsContext(
        req,
        (c) =>
          c.query(
            `INSERT INTO partner_keys
               (partner_key, vendor_partner_id, institution_id, hmac_secret,
                is_active, is_sandbox, created_by, notes)
             VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7)`,
            [
              partnerKey,
              req.params.id,
              resolvedInstitutionId,
              sealedSecret,
              is_sandbox,
              req.user.userId,
              notes || null,
            ],
          ),
        { change_reason: `issue partner_key (sandbox=${is_sandbox})` },
      );
    } catch (err) {
      logger.error({ err: err.message }, 'issue partner_key failed');
      return res.status(500).json({ error: 'issue_failed' });
    }

    res.status(201).json({
      partner_key: partnerKey,
      hmac_secret: secretPlain,
      is_sandbox,
      institution: {
        id: iR.rows[0].id,
        shortname: iR.rows[0].shortname,
        display_name: iR.rows[0].display_name,
      },
      warning:
        'This is the ONLY time the HMAC secret is displayed. Save it in your credentials store now.',
    });
  },
);

// POST /admin/partner-keys/:key/revoke — mark inactive.
// The webhook rejects further pushes with the revoked key immediately
// (verifyVendorHmacMw checks is_active on every request).
const revokeSchema = z.object({ reason: z.string().max(500).optional() });
router.post(
  '/partner-keys/:key/revoke',
  verifyJWT,
  requireRole('super_admin'),
  async (req, res) => {
    const parsed = revokeSchema.safeParse(req.body || {});
    const reason = parsed.success ? parsed.data.reason : null;

    const r = await withRlsContext(
      req,
      (c) =>
        c.query(
          `UPDATE partner_keys
              SET is_active = FALSE,
                  revoked_at = NOW(),
                  revoked_by = $1,
                  notes = CASE
                    WHEN $2::text IS NULL THEN notes
                    ELSE COALESCE(notes,'') || E'\n[revoked ' || NOW()::text || '] ' || $2::text
                  END
            WHERE partner_key = $3 AND is_active = TRUE
        RETURNING partner_key, revoked_at`,
          [req.user.userId, reason || null, req.params.key],
        ),
      { change_reason: 'revoke partner_key' },
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'not_found_or_already_revoked' });
    }
    res.json({ partner_key: r.rows[0].partner_key, revoked_at: r.rows[0].revoked_at });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Blood-group HITL discrepancy queue + resolve (PR (b) — migration 309)
//
// When a second BB pushes a different blood group for a donor already at
// state=VE, the webhook transitions the donor to state=DP. This queue lets
// an NGO admin see both attested values + the source BBs, then choose
// which is authoritative. The chosen value locks (state=LK, immutable via
// DB trigger).
//
// Rare-blood safety net: if the donor is in rare_blood_registry, resolution
// escalates to super_admin only — a rare-blood mismatch is much higher-
// severity than a routine A+/B+ mix-up, and we don't want a busy ngo_admin
// clicking through it fast.
// ─────────────────────────────────────────────────────────────────────────────

router.get(
  '/donors/blood-group-discrepancies',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    // Reveal masked mobile + decrypted full_name for the admin queue — same
    // pattern as other admin endpoints on this file. Both existing_source
    // (blood_group_verified_by) and disputed_source
    // (blood_group_discrepancy_source_id) are institutions the admin needs
    // to see to make a call.
    const r = await withRlsContext(req, (c) =>
      c.query(
        `SELECT d.id, d.mobile, d.full_name, d.date_of_birth, d.gender,
                d.blood_group_verified                AS existing_value_id,
                bge.code                              AS existing_value,
                d.blood_group_verified_at             AS existing_at,
                d.blood_group_verified_by             AS existing_source_id,
                ie.display_name                       AS existing_source_display_name,
                ie.shortname                          AS existing_source_shortname,
                d.blood_group_discrepancy_new         AS disputed_value_id,
                bgd.code                              AS disputed_value,
                d.blood_group_discrepancy_source_id   AS disputed_source_id,
                id.display_name                       AS disputed_source_display_name,
                id.shortname                          AS disputed_source_shortname,
                d.updated_at                          AS discrepancy_raised_at,
                EXISTS (
                  SELECT 1 FROM rare_blood_registry rbr WHERE rbr.donor_id = d.id
                )                                     AS is_rare_blood
           FROM donors d
           LEFT JOIN blood_groups bge ON bge.id = d.blood_group_verified
           LEFT JOIN blood_groups bgd ON bgd.id = d.blood_group_discrepancy_new
           LEFT JOIN institutions ie  ON ie.id  = d.blood_group_verified_by
           LEFT JOIN institutions id  ON id.id  = d.blood_group_discrepancy_source_id
          WHERE d.blood_group_verification_state = 'DP'
            AND d.is_active = TRUE
          ORDER BY d.updated_at DESC
          LIMIT 200`,
      ),
    );
    // Decrypt names in place (openRows imported at top).
    const rows = openRows(r.rows, ['full_name']);
    res.json({ discrepancies: rows, count: rows.length });
  },
);

const resolveDiscrepancySchema = z.object({
  chosen_value_id: z.number().int().positive(),
  notes: z.string().min(20).max(2000),
});

router.post(
  '/donors/:id/resolve-blood-group-discrepancy',
  verifyJWT,
  // Coarse gate; the rare-blood auto-escalation is checked inside the handler
  // because it depends on the specific donor row.
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const parsed = resolveDiscrepancySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({ error: 'invalid_input', details: parsed.error.format() });
    }
    const { chosen_value_id, notes } = parsed.data;

    // Load current state + rare-blood flag.
    const dR = await pool.query(
      `SELECT d.id, d.blood_group_verified                AS existing_value_id,
              d.blood_group_discrepancy_new               AS disputed_value_id,
              d.blood_group_verification_state            AS state,
              EXISTS (SELECT 1 FROM rare_blood_registry rbr WHERE rbr.donor_id = d.id) AS is_rare_blood
         FROM donors d
        WHERE d.id = $1`,
      [req.params.id],
    );
    if (dR.rowCount === 0) return res.status(404).json({ error: 'donor_not_found' });
    const donor = dR.rows[0];

    if (donor.state !== 'DP') {
      return res.status(409).json({
        error: 'not_in_discrepancy_state',
        current_state: donor.state,
      });
    }
    if (
      chosen_value_id !== donor.existing_value_id &&
      chosen_value_id !== donor.disputed_value_id
    ) {
      return res.status(422).json({
        error: 'chosen_value_must_be_one_of_disputed',
        existing_value_id: donor.existing_value_id,
        disputed_value_id: donor.disputed_value_id,
      });
    }

    // Rare-blood auto-escalation. ngo_admin sees the queue but can't submit
    // a resolution for a rare-blood donor — clinical safety.
    if (donor.is_rare_blood && req.user.role !== 'super_admin') {
      return res.status(403).json({
        error: 'rare_blood_requires_super_admin',
        hint: 'This donor is on the rare-blood registry. Resolution requires super_admin sign-off.',
      });
    }

    // Resolve — state → LK, chosen value → verified, discrepancy cleared,
    // reviewer + timestamp stamped. The immutability trigger (migration
    // 309) blocks future writes to blood_group_verified while state=LK.
    try {
      const r = await withRlsContext(
        req,
        (c) =>
          c.query(
            `UPDATE donors
                SET blood_group_verified                = $1,
                    blood_group_verified_at             = NOW(),
                    blood_group_verified_by             = COALESCE(
                      CASE WHEN $1 = blood_group_verified          THEN blood_group_verified_by
                           WHEN $1 = blood_group_discrepancy_new   THEN blood_group_discrepancy_source_id
                      END,
                      blood_group_verified_by
                    ),
                    blood_group_verification_state      = 'LK',
                    blood_group_locked_at               = NOW(),
                    blood_group_locked_by               = $2,
                    blood_group_discrepancy_new         = NULL,
                    blood_group_discrepancy_source_id   = NULL
              WHERE id = $3 AND blood_group_verification_state = 'DP'
          RETURNING id, blood_group_verified, blood_group_locked_at`,
            [chosen_value_id, req.user.userId, req.params.id],
          ),
        {
          actor_role: req.user.role,
          change_reason: `BLOOD_GROUP_LOCKED [chosen=${chosen_value_id}, rare=${donor.is_rare_blood}]: ${notes.slice(0, 200)}`,
        },
      );
      if (r.rowCount === 0) {
        return res.status(409).json({ error: 'concurrent_state_change' });
      }
      return res.json({
        donor_id: r.rows[0].id,
        blood_group_verified: r.rows[0].blood_group_verified,
        blood_group_locked_at: r.rows[0].blood_group_locked_at,
        state: 'LK',
      });
    } catch (err) {
      logger.error(
        { err: err.message, donor_id: req.params.id },
        'resolve blood-group discrepancy failed',
      );
      return res.status(500).json({ error: 'resolve_failed' });
    }
  },
);

module.exports = router;
