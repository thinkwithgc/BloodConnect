/**
 * Authentication routes.
 *
 *   POST /auth/otp/send        — donors and coordinators (mobile OTP)
 *   POST /auth/otp/verify      — verify OTP, return JWT
 *   POST /auth/institutional/login         — username + password + TOTP
 *   POST /auth/institutional/setup-totp    — bootstrap TOTP secret
 *   POST /auth/institutional/confirm-totp  — first verification enables it
 *   POST /auth/institutional/reset-password — ngo_admin only
 *   POST /auth/logout          — invalidate session (current behavior: stateless JWT)
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const totp = require('../utils/totp');
const { z } = require('zod');

const env = require('../config/env');
const logger = require('../config/logger');
const { pool } = require('../config/db');
const { withRlsContextRaw } = require('../middleware/rlsContext');
const { verifyJWT, requireRole } = require('../middleware/auth');
const { sign, newSessionId } = require('../utils/jwt');
const { normaliseIndianMobile } = require('../utils/phone');
const otp = require('../utils/otp');
const encryption = require('../services/encryption');
const { sendNotification } = require('../services/notifications');

const router = express.Router();

// ── Rate limits (spec §10) ──────────────────────────────────────────────
const otpSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: otp.RATE_LIMIT_PER_HOUR,
  keyGenerator: (req) => normaliseIndianMobile(req.body?.mobile) || req.ip,
  standardHeaders: 'draft-8',
  message: { error: 'rate_limit_otp_send' },
});

const institutionalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => req.ip,
  standardHeaders: 'draft-8',
  message: { error: 'rate_limit_login' },
});

// ── Helpers ──────────────────────────────────────────────────────────────
function shouldUnlock(user) {
  return user.is_locked && user.locked_until && new Date(user.locked_until) <= new Date();
}

// ── POST /auth/otp/send ──────────────────────────────────────────────────
router.post('/otp/send', otpSendLimiter, async (req, res) => {
  const schema = z.object({
    mobile: z.string(),
    // coordinator dropped from OTP cluster in migration 282 — they now
    // auth via /auth/institutional/login (username + password + TOTP).
    role_hint: z.enum(['donor', 'community_leader']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const mobile = normaliseIndianMobile(parsed.data.mobile);
  if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

  // OTP-cluster auth path: donor + community_leader only (migration 282
  // moved coordinator to staff auth). role_hint disambiguates which
  // platform_users row to load when a mobile holds rows in both buckets
  // (Q8 in the Phase-1 planning: "a community leader can also be a donor").
  // Defaults to 'donor' when absent so the legacy donor-login UX is
  // unchanged.
  const targetRole = parsed.data.role_hint || 'donor';
  const existing = await pool.query(
    `SELECT id, role, is_locked, locked_until, otp_attempts
       FROM platform_users
      WHERE mobile = $1
        AND role = $2`,
    [mobile, targetRole],
  );

  let userId;
  if (existing.rowCount === 0) {
    // Auto-create a thin platform_users row in 'donor' role on first OTP
    // request. The donor profile (donors table) is created later by the
    // registration form. community_leader rows are NEVER auto-created —
    // they're invited by ngo_admin via POST /admin/community-leaders.
    if (parsed.data.role_hint === 'community_leader') {
      return res.status(403).json({ error: 'community_leader_not_registered' });
    }
    const created = await withRlsContextRaw(
      { actor_role: 'registration', change_reason: 'auth otp send first contact' },
      async (c) => {
        const r = await c.query(
          `INSERT INTO platform_users (role, mobile) VALUES ('donor', $1) RETURNING id`,
          [mobile],
        );
        return r.rows[0].id;
      },
    );
    userId = created;
  } else {
    const u = existing.rows[0];
    if (u.is_locked && !shouldUnlock(u)) {
      return res.status(429).json({ error: 'account_locked', locked_until: u.locked_until });
    }
    if (shouldUnlock(u)) {
      await pool.query(
        `UPDATE platform_users SET is_locked = FALSE, locked_until = NULL,
         otp_attempts = 0 WHERE id = $1`,
        [u.id],
      );
    }
    userId = u.id;
  }

  const code = otp.generate();
  const codeHash = otp.hash(code);
  const expiresAt = new Date(Date.now() + otp.OTP_TTL_MIN * 60_000);

  await pool.query(
    `UPDATE platform_users
        SET otp_hash = $1, otp_expires_at = $2, otp_attempts = 0
      WHERE id = $3`,
    [codeHash, expiresAt, userId],
  );

  // Dispatch via the notification service. In dev with NOTIFICATIONS_PROVIDER=console,
  // this writes to .outbox/<id>.json. Real MSG91 lands in Phase 6.
  await sendNotification({
    recipientId: mobile,
    templateType: 'OTP',
    variables: { otp: code, ttl_minutes: otp.OTP_TTL_MIN },
    channel: 'WA',
    language: 'en',
  });

  // Surface the OTP in the response for local dev, and for staging when the
  // OTP_ECHO flag is explicitly set (so a live staging site can be demoed
  // without a working SMS/WhatsApp channel). Never enabled in real production.
  const echoOtp = env.nodeEnv === 'development' || env.otpEcho;
  const devEcho = echoOtp ? { dev_otp: code } : {};
  res.json({ status: 'sent', expires_at: expiresAt.toISOString(), ...devEcho });
});

// ── POST /auth/otp/verify ────────────────────────────────────────────────
router.post('/otp/verify', async (req, res) => {
  const schema = z.object({
    mobile: z.string(),
    otp: z.string().regex(/^\d{6}$/, 'otp must be 6 digits'),
    // coordinator dropped from OTP cluster in migration 282.
    role_hint: z.enum(['donor', 'community_leader']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const mobile = normaliseIndianMobile(parsed.data.mobile);
  if (!mobile) return res.status(400).json({ error: 'invalid_mobile_format' });

  // Per-role lookup (migration 274). The same mobile may hold donor +
  // coordinator + community_leader rows in parallel — role_hint picks
  // which row's OTP we're verifying. Defaults to 'donor' if absent so
  // the legacy DonorLogin flow continues to work without changes; the
  // updated DonorLogin now forwards the URL ?role= param explicitly.
  const targetRole = parsed.data.role_hint || 'donor';
  const r = await pool.query(
    `SELECT id, role, institution_id, otp_hash, otp_expires_at, otp_attempts,
            is_locked, locked_until
       FROM platform_users
      WHERE mobile = $1
        AND role = $2`,
    [mobile, targetRole],
  );
  if (r.rowCount === 0) return res.status(401).json({ error: 'invalid_credentials' });
  const u = r.rows[0];

  if (u.is_locked && !shouldUnlock(u)) {
    return res.status(429).json({ error: 'account_locked' });
  }
  if (!u.otp_hash || !u.otp_expires_at || new Date(u.otp_expires_at) < new Date()) {
    return res.status(401).json({ error: 'otp_expired' });
  }

  const submitted = otp.hash(parsed.data.otp);
  if (!otp.constantTimeEquals(submitted, u.otp_hash)) {
    const attempts = (u.otp_attempts || 0) + 1;
    const locking = attempts >= otp.MAX_ATTEMPTS;
    await pool.query(
      `UPDATE platform_users
          SET otp_attempts = $1,
              is_locked = $2,
              locked_until = CASE WHEN $2 THEN NOW() + make_interval(mins => $4)
                                  ELSE locked_until END
        WHERE id = $3`,
      [attempts, locking, u.id, otp.LOCK_DURATION_MIN],
    );
    return res.status(401).json({
      error: locking ? 'account_locked_too_many_attempts' : 'invalid_otp',
      attempts_remaining: Math.max(0, otp.MAX_ATTEMPTS - attempts),
    });
  }

  // Success — clear OTP, stamp last_login, return JWT.
  const sessionId = newSessionId();
  await pool.query(
    `UPDATE platform_users
        SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0,
            last_login_at = clock_timestamp(), is_locked = FALSE, locked_until = NULL
      WHERE id = $1`,
    [u.id],
  );

  // Donor mobile re-verification (Phase 3 cleanup): if a donor row is paired
  // to this platform_user and mobile_verified is still FALSE, set it TRUE.
  // The donors table has its own mobile_verified flag (not on platform_users).
  if (u.role === 'donor') {
    await pool.query(
      `UPDATE donors
          SET mobile_verified = TRUE,
              mobile_verified_at = clock_timestamp()
        WHERE platform_user_id = $1
          AND mobile_verified = FALSE`,
      [u.id],
    );
  }

  const token = sign({ sub: u.id, role: u.role, sid: sessionId, inst: u.institution_id });
  res.json({
    token,
    role: u.role,
    user_id: u.id,
    institution_id: u.institution_id,
    session_id: sessionId,
  });
});

// ── POST /auth/institutional/login ───────────────────────────────────────
// Username-based as of migration 268. The username is auto-assigned at
// onboarding time (`<institutions.shortname>_admin` for HO/BB; manually
// chosen for ngo_admin/super_admin/dho) so the login identifier survives
// officer turnover — when a hospital's admin changes, the new officer
// activates the SAME username via a fresh setup link.
router.post('/institutional/login', institutionalLoginLimiter, async (req, res) => {
  const schema = z.object({
    username: z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/),
    password: z.string().min(8),
    totp_code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const r = await pool.query(
    `SELECT pu.id, pu.role, pu.institution_id, pu.district_id, pu.password_hash,
            pu.totp_secret, pu.totp_enabled, pu.failed_login_attempts,
            pu.is_locked, pu.locked_until, pu.force_password_change,
            pu.deactivated_at,
            i.onboarding_status
       FROM platform_users pu
  LEFT JOIN institutions i ON i.id = pu.institution_id
      WHERE pu.username = $1`,
    [parsed.data.username],
  );
  if (r.rowCount === 0) return res.status(401).json({ error: 'invalid_credentials' });
  const u = r.rows[0];

  // A retired account is refused before the password is even compared.
  // platform_users rows are never deleted (clinical FKs from donation_history,
  // donor_screening.entered_by/verified_by, bag_events and audit_log must stay
  // resolvable — migration 311), so this check is the whole of what
  // deactivation means. Without it the column would be decorative.
  if (u.deactivated_at) {
    return res.status(403).json({ error: 'account_deactivated' });
  }

  // Auto-unlock once the lock window has elapsed.
  if (u.is_locked && shouldUnlock(u)) {
    await pool.query(
      `UPDATE platform_users
          SET is_locked = FALSE, locked_until = NULL, failed_login_attempts = 0
        WHERE id = $1`,
      [u.id],
    );
    u.is_locked = false;
  }
  if (u.is_locked) {
    return res.status(429).json({ error: 'account_locked', locked_until: u.locked_until });
  }
  if (!u.password_hash) return res.status(401).json({ error: 'invalid_credentials' });

  const ok = await bcrypt.compare(parsed.data.password, u.password_hash);
  if (!ok) {
    // Per-account lockout (audit hardening) — mirrors the OTP-verify path so a
    // slow, IP-rotating password brute force trips the same 5-attempt lock.
    const attempts = (u.failed_login_attempts || 0) + 1;
    const locking = attempts >= otp.MAX_ATTEMPTS;
    await pool.query(
      `UPDATE platform_users
          SET failed_login_attempts = $1,
              is_locked = $2,
              locked_until = CASE WHEN $2 THEN NOW() + make_interval(mins => $4)
                                  ELSE locked_until END
        WHERE id = $3`,
      [attempts, locking, u.id, otp.LOCK_DURATION_MIN],
    );
    return res.status(401).json({
      error: locking ? 'account_locked_too_many_attempts' : 'invalid_credentials',
      attempts_remaining: Math.max(0, otp.MAX_ATTEMPTS - attempts),
    });
  }
  // Password correct — clear the failure counter.
  if (u.failed_login_attempts > 0) {
    await pool.query(`UPDATE platform_users SET failed_login_attempts = 0 WHERE id = $1`, [u.id]);
  }

  // For staff roles, ensure their institution is ACTIVE. DHOs have no
  // institution (district_id binding instead), so the check is skipped for them.
  if (['hospital', 'blood_bank'].includes(u.role) && u.onboarding_status !== 'AC') {
    return res.status(403).json({ error: 'institution_not_active' });
  }

  const sessionId = newSessionId();

  // 2FA is mandatory (audit hardening — no more grace mode).
  if (u.totp_enabled) {
    if (!parsed.data.totp_code) return res.status(401).json({ error: 'totp_required' });
    const secret = encryption.decrypt(u.totp_secret);
    if (!(await totp.verifyCode(secret, parsed.data.totp_code))) {
      return res.status(401).json({ error: 'invalid_totp' });
    }
    await pool.query(`UPDATE platform_users SET last_login_at = clock_timestamp() WHERE id = $1`, [
      u.id,
    ]);
    const token = sign({
      sub: u.id,
      role: u.role,
      sid: sessionId,
      inst: u.institution_id,
      dist: u.district_id,
    });
    return res.json({
      token,
      role: u.role,
      user_id: u.id,
      institution_id: u.institution_id,
      district_id: u.district_id,
      force_password_change: u.force_password_change,
    });
  }

  // Not yet enrolled → issue a restricted `tp` token. verifyJWT blocks it from
  // everything except the TOTP-enrolment endpoints; the client sends the user
  // to /staff/setup-2fa, which finishes enrolment and swaps it for a full token.
  const setupToken = sign({
    sub: u.id,
    role: u.role,
    sid: sessionId,
    inst: u.institution_id,
    dist: u.district_id,
    tp: true,
  });
  return res.json({ token: setupToken, role: u.role, user_id: u.id, totp_setup_required: true });
});

// ── POST /auth/institutional/setup-totp ──────────────────────────────────
router.post('/institutional/setup-totp', verifyJWT, async (req, res) => {
  if (!['hospital', 'blood_bank', 'ngo_admin', 'super_admin', 'dho'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const r = await pool.query('SELECT email, totp_enabled FROM platform_users WHERE id = $1', [
    req.user.userId,
  ]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  if (r.rows[0].totp_enabled) {
    return res.status(409).json({ error: 'totp_already_enabled' });
  }

  const secret = totp.newSecret();
  const encryptedSecret = encryption.encrypt(secret);
  await pool.query(
    `UPDATE platform_users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2`,
    [encryptedSecret, req.user.userId],
  );

  const otpauth = totp.buildUri({ accountName: r.rows[0].email, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauth);

  res.json({
    otpauth_url: otpauth,
    qr_code_data_url: qrDataUrl,
    instructions:
      'Scan with Google Authenticator / Authy. Then POST the 6-digit code to /auth/institutional/confirm-totp.',
  });
});

// ── POST /auth/institutional/confirm-totp ────────────────────────────────
router.post('/institutional/confirm-totp', verifyJWT, async (req, res) => {
  const schema = z.object({ totp_code: z.string().regex(/^\d{6}$/) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

  const r = await pool.query(`SELECT totp_secret, totp_enabled FROM platform_users WHERE id = $1`, [
    req.user.userId,
  ]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
  if (r.rows[0].totp_enabled) return res.status(409).json({ error: 'totp_already_enabled' });
  if (!r.rows[0].totp_secret) return res.status(400).json({ error: 'totp_setup_first' });

  const secret = encryption.decrypt(r.rows[0].totp_secret);
  if (!(await totp.verifyCode(secret, parsed.data.totp_code))) {
    // 400 (not 401): the enrolment token is still valid — the *code* was wrong.
    // A 401 would trip the client's auth-expired interceptor and log them out
    // mid-enrolment.
    return res.status(400).json({ error: 'invalid_totp' });
  }

  await pool.query(
    `UPDATE platform_users SET totp_enabled = TRUE, totp_verified_at = NOW() WHERE id = $1`,
    [req.user.userId],
  );

  // Enrolment complete — swap the restricted `tp` token for a full session so
  // the user goes straight into the app instead of logging in again.
  const sessionId = newSessionId();
  const token = sign({
    sub: req.user.userId,
    role: req.user.role,
    sid: sessionId,
    inst: req.user.institutionId,
    dist: req.user.districtId,
  });
  res.json({
    status: 'totp_enabled',
    token,
    role: req.user.role,
    user_id: req.user.userId,
    institution_id: req.user.institutionId,
    district_id: req.user.districtId,
  });
});

// ── POST /auth/institutional/reset-2fa ───────────────────────────────────
// ngo_admin / super_admin clears a staff member's authenticator enrolment
// (lost / changed phone). Their TOTP secret is wiped and the account is
// unlocked; on their next login they're routed back through 2FA enrolment.
// Does NOT reset the password — that's reset-password. Identifies by username.
router.post(
  '/institutional/reset-2fa',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const schema = z.object({ username: z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

    const r = await pool.query(
      `UPDATE platform_users
          SET totp_secret = NULL,
              totp_enabled = FALSE,
              totp_verified_at = NULL,
              is_locked = FALSE,
              locked_until = NULL,
              failed_login_attempts = 0
        WHERE username = $1
          AND role IN ('hospital','blood_bank','ngo_admin','super_admin','dho')
      RETURNING id, username, role`,
      [parsed.data.username],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    logger.warn(
      { by: req.user.userId, target: r.rows[0].id, username: r.rows[0].username },
      'Admin reset 2FA for staff account',
    );
    res.json({ status: 'reset', username: r.rows[0].username, role: r.rows[0].role });
  },
);

// ── POST /auth/institutional/reset-password ──────────────────────────────
// ngo_admin / super_admin triggers a magic-link password reset for a staff
// account by username. Reuses the same setup-token + WhatsApp template
// (`institution_link`) as initial onboarding — no separate code path, no
// temporary password ever transits the wire.
//
// Resolves the user's mobile by preferring the platform_users.mobile column
// (set at onboarding time = institution's primary_contact_mobile at the
// time of setup); falls back to the live institution mobile if the user
// row's mobile is null (legacy rows from before migration 268). The link
// goes to whichever mobile is on record — the assumption being that the
// admin doing the reset has already confirmed the new officer's mobile is
// reflected in the institution row.
router.post(
  '/institutional/reset-password',
  verifyJWT,
  requireRole('ngo_admin', 'super_admin'),
  async (req, res) => {
    const schema = z.object({ username: z.string().regex(/^[a-z][a-z0-9_-]{2,31}$/) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });

    const r = await pool.query(
      `SELECT pu.id, pu.role, pu.username, pu.mobile,
              i.primary_contact_mobile, i.primary_contact_name,
              i.display_name, i.shortname
         FROM platform_users pu
    LEFT JOIN institutions i ON i.id = pu.institution_id
        WHERE pu.username = $1`,
      [parsed.data.username],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'user_not_found' });
    const u = r.rows[0];

    const placeholderHash = await setupSvc.unusablePasswordHash();
    const mobile = u.mobile || u.primary_contact_mobile;
    if (!mobile) return res.status(400).json({ error: 'no_mobile_on_file' });

    const { token: setupToken, expiresAt } = await withRlsContextRaw(
      { actor_role: 'onboarding', change_reason: 'admin password reset' },
      async (c) => {
        // Wipe password + clear any lock — they're getting a fresh setup link.
        await c.query(
          `UPDATE platform_users
              SET password_hash = $1, password_set_at = NOW(),
                  force_password_change = TRUE,
                  is_locked = FALSE, locked_until = NULL,
                  mobile = $2
            WHERE id = $3`,
          [placeholderHash, mobile, u.id],
        );
        return setupSvc.generateSetupToken(c, u.id);
      },
    );

    // Best-effort send, and it MUST be best-effort: the password has already
    // been wiped and the token issued by the transaction above. A throw here
    // used to 500 the request after that write, leaving the account with no
    // password and its only setup link discarded with the response — strictly
    // worse than before the reset. Both the exception and a non-success return
    // now fall through to a response carrying the URL.
    let waSent = false;
    try {
      const sent = await sendNotification({
        recipientId: mobile,
        templateType: 'SETUP_LINK',
        variables: {
          signatory_name: u.primary_contact_name || u.username,
          institution_name: u.display_name || u.shortname || 'Raktify',
          setup_token: setupToken,
        },
        channel: 'WA',
        language: 'en',
      });
      if (sent?.success) {
        waSent = true;
      } else {
        logger.warn(
          { event: 'staff_reset_link_unsent', username: u.username, result: sent },
          'password-reset WhatsApp did not send — setup URL returned to admin instead',
        );
      }
    } catch (err) {
      logger.error(
        { event: 'staff_reset_link_failed', username: u.username, err: err.message },
        'password-reset WhatsApp threw — setup URL returned to admin instead',
      );
    }

    // Returned unconditionally — see the equivalent note in
    // routes/onboarding.js POST /activate/:id. Only SHA-256(token) is stored, so
    // this response is the only copy of the link; dev-gating it made a failed
    // send unrecoverable.
    res.json({
      status: waSent ? 'reset_link_sent' : 'reset_link_issued_not_sent',
      username: u.username,
      setup_url: `${env.frontendUrl}/setup/${setupToken}`,
      setup_expires_at: expiresAt,
      whatsapp_sent: waSent,
      next_step: waSent
        ? `Setup link sent to ${mobile}. The old password no longer works.`
        : `Link issued but the WhatsApp did NOT send — the old password no longer works, so share the setup URL out-of-band. It is shown once; re-issue if lost.`,
    });
  },
);

// ── Setup-link password setup (institutional admins) ──────────────────────
//
// GET  /auth/setup/:token  — public; returns user/institution info for the
//                            password-setup form (or 404 invalid / 410 used+expired).
// POST /auth/setup/:token  — public; body { password, confirm_password };
//                            consumes the token, sets password.
//
// Token issued by /onboarding/mou-signed (single-use, 7-day TTL).
// See `services/users/setup.js` for the storage / validation logic.
const setupSvc = require('../services/users/setup');

const setupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20, // generous: tokens are 256-bit; brute force isn't realistic
  keyGenerator: (req) => req.ip,
  standardHeaders: 'draft-8',
  message: { error: 'rate_limit_setup' },
});

router.get('/setup/:token', setupLimiter, async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('raktify.actor_role', 'system', TRUE)`);
    const v = await setupSvc.validateSetupToken(c, req.params.token);
    if (!v.ok) {
      const status = v.code === 'invalid' ? 404 : 410;
      return res.status(status).json({ error: v.code });
    }
    return res.json({
      username: v.user.username,
      email: v.user.email,
      role: v.user.role,
      institution_name: v.institution.name,
      institution_shortname: v.institution.shortname,
      signatory_name: v.institution.signatory_name,
      expires_at: v.expires_at,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'setup token GET failed');
    res.status(500).json({ error: 'internal' });
  } finally {
    c.release();
  }
});

router.post('/setup/:token', setupLimiter, async (req, res) => {
  // Password rules: 12+ chars, at least one letter + one digit. Industry
  // standard for low-friction first-password setup; staff can self-rotate
  // to anything stronger later. We deliberately don't require special
  // characters — they hurt adoption + don't measurably help against modern
  // attacks (NIST SP 800-63B agrees).
  const schema = z.object({
    password: z
      .string()
      .min(12, 'min_12_chars')
      .max(200, 'too_long')
      .regex(/[A-Za-z]/, 'need_letter')
      .regex(/[0-9]/, 'need_digit'),
    confirm_password: z.string(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });
  }
  if (parsed.data.password !== parsed.data.confirm_password) {
    return res.status(400).json({ error: 'password_mismatch' });
  }

  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('raktify.actor_role', 'system', TRUE)`);
    const r = await setupSvc.consumeSetupToken(c, req.params.token, parsed.data.password);
    if (!r.ok) {
      const status = r.code === 'invalid' ? 404 : 410;
      return res.status(status).json({ error: r.code });
    }
    return res.json({ status: 'set', user_id: r.user_id });
  } catch (err) {
    logger.error({ err: err.message }, 'setup token POST failed');
    res.status(500).json({ error: 'internal' });
  } finally {
    c.release();
  }
});

// ── GET /auth/available-roles ────────────────────────────────────────────
// Same mobile can hold platform_users rows in multiple OTP-cluster roles
// (donor + community_leader). Frontend calls this to show "switch to X"
// buttons in the dashboard header without forcing the user to log out.
//
// Only OTP-cluster roles (donor, community_leader) are cross-linkable via
// this endpoint. Staff cluster roles use username+password and are never
// linked to an OTP session for security separation.
router.get('/available-roles', verifyJWT, async (req, res) => {
  const me = await pool.query(`SELECT mobile FROM platform_users WHERE id = $1`, [req.user.userId]);
  if (me.rowCount === 0 || !me.rows[0].mobile) {
    return res.json({ roles: [] });
  }
  // Filter out same-role rows defensively — historical data anomalies
  // (rows created before migration 274 enforced per-role uniqueness) could
  // otherwise surface as "Switch to your community leader dashboard" while
  // you're already ON the leader dashboard.
  const r = await pool.query(
    `SELECT id, role FROM platform_users
      WHERE mobile = $1
        AND role IN ('donor', 'community_leader')
        AND role <> $3
        AND id <> $2
        AND is_locked = FALSE`,
    [me.rows[0].mobile, req.user.userId, req.user.role],
  );
  res.json({
    roles: r.rows.map((row) => ({ user_id: row.id, role: row.role })),
  });
});

// ── POST /auth/switch-role ───────────────────────────────────────────────
// Mints a fresh JWT for another role bound to the same mobile. Only works
// across the OTP cluster (donor <-> community_leader). The current session
// stays valid until natural expiry — frontend just replaces the token in
// localStorage.
const switchRoleSchema = z.object({
  target_role: z.enum(['donor', 'community_leader']),
});
router.post('/switch-role', verifyJWT, async (req, res) => {
  const parsed = switchRoleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_input' });
  const targetRole = parsed.data.target_role;
  if (targetRole === req.user.role) {
    return res.status(400).json({ error: 'already_in_target_role' });
  }
  const me = await pool.query(`SELECT mobile FROM platform_users WHERE id = $1`, [req.user.userId]);
  if (me.rowCount === 0 || !me.rows[0].mobile) {
    return res.status(404).json({ error: 'mobile_missing' });
  }
  const target = await pool.query(
    `SELECT id, role, is_locked, institution_id
       FROM platform_users
      WHERE mobile = $1 AND role = $2`,
    [me.rows[0].mobile, targetRole],
  );
  if (target.rowCount === 0) {
    return res.status(404).json({ error: 'no_such_role_for_this_mobile' });
  }
  if (target.rows[0].is_locked) {
    return res.status(423).json({ error: 'target_role_account_locked' });
  }
  const u = target.rows[0];
  const sessionId = newSessionId();
  await pool.query(`UPDATE platform_users SET last_login_at = clock_timestamp() WHERE id = $1`, [
    u.id,
  ]);
  const token = sign({ sub: u.id, role: u.role, sid: sessionId, inst: u.institution_id });
  logger.info(
    {
      from_user_id: req.user.userId,
      from_role: req.user.role,
      to_user_id: u.id,
      to_role: u.role,
    },
    'auth: role switched',
  );
  res.json({
    token,
    role: u.role,
    user_id: u.id,
    institution_id: u.institution_id,
    session_id: sessionId,
  });
});

// ── POST /auth/logout ─────────────────────────────────────────────────────
// JWTs are stateless. A real session-blacklist would land in a Redis-backed
// store. For now, the API just acknowledges; the client must drop the token.
router.post('/logout', verifyJWT, async (req, res) => {
  logger.info({ user_id: req.user.userId, session_id: req.user.sessionId }, 'logout');
  res.json({ status: 'logged_out' });
});

module.exports = router;
