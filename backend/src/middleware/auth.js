/**
 * verifyJWT — extracts Bearer token, verifies, fetches the platform_users
 * row to confirm not-locked, attaches { userId, role, institutionId, sessionId }
 * to req.user. Returns 401 on any failure.
 *
 * requireRole(...roles) — gates the route to a whitelist of roles.
 *
 * requireInstitution — for hospital/blood_bank, verifies that the
 * institution_id in the URL params or body matches req.user.institutionId.
 *
 * requireReason({ min }) — demands an operator-written justification on the
 * request body before a consequential write is allowed through.
 */
const { verify } = require('../utils/jwt');
const { pool } = require('../config/db');
const logger = require('../config/logger');

// The only endpoints a TOTP-pending (`tp`) enrolment token may reach. Every
// other route is blocked until the staff member finishes 2FA enrolment.
const TOTP_ENROLL_PATHS = new Set([
  '/auth/institutional/setup-totp',
  '/auth/institutional/confirm-totp',
]);

async function verifyJWT(req, res, next) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/);
  if (!m) return res.status(401).json({ error: 'missing_token' });

  let payload;
  try {
    payload = verify(m[1]);
  } catch (err) {
    logger.debug({ err: err.message }, 'JWT verify failed');
    return res.status(401).json({ error: 'invalid_token' });
  }

  // Verify the user still exists and is not locked.
  const r = await pool.query(
    'SELECT id, role, institution_id, district_id, is_locked FROM platform_users WHERE id = $1',
    [payload.sub],
  );
  if (r.rowCount === 0) return res.status(401).json({ error: 'user_not_found' });
  const u = r.rows[0];
  if (u.is_locked) return res.status(403).json({ error: 'account_locked' });
  if (u.role !== payload.role) return res.status(401).json({ error: 'role_mismatch' });

  // Enforce 2FA enrolment: a `tp` token can only reach the enrolment endpoints.
  // req.baseUrl + req.path reconstructs the full mounted path (req.path alone
  // is router-relative).
  if (payload.tp && !TOTP_ENROLL_PATHS.has(req.baseUrl + req.path)) {
    return res.status(403).json({ error: 'totp_enrollment_required' });
  }

  req.user = {
    userId: u.id,
    role: u.role,
    institutionId: u.institution_id,
    districtId: u.district_id,
    sessionId: payload.sid,
    totpPending: payload.tp === true,
  };
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

function requireInstitution(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
  if (!['hospital', 'blood_bank'].includes(req.user.role)) {
    return next(); // not a staff role; nothing to check
  }
  const wantedId = req.params.id || req.body.institution_id;
  if (wantedId && wantedId !== req.user.institutionId) {
    return res.status(403).json({ error: 'institution_mismatch' });
  }
  next();
}

/**
 * Demands a written justification before a consequential write proceeds.
 *
 * The audit chain already carries the "why": fn_audit_generic() reads
 * current_setting('raktify.change_reason', TRUE) into every audit row, and
 * middleware/rlsContext.js sets that GUC from the third argument to
 * withRlsContext(). What was missing is anyone being *asked*. Nearly every
 * existing call site passes a hardcoded system description ("admin update
 * institution"), which records what the code did rather than why a person
 * decided to do it — useless six months later when a licence number is wrong
 * and nobody remembers who changed it or on whose word.
 *
 * So this is the gate rather than a per-handler `if`: one place that decides
 * what counts as a reason, applied identically to suspending a blood bank,
 * archiving a hospital, and retiring a colleague's login.
 *
 * On success sets req.changeReason (trimmed). Handlers pass it on as
 *   { change_reason: `<action>: ${req.changeReason}` }
 * so the audit row names both the operation and the justification.
 *
 * min defaults to 10, not 5: "typo" and "asked" are keystrokes, not reasons.
 * The cap at 500 matches the widest reason column on the tables these routes
 * write (institutions.suspension_reason, platform_users.deactivation_reason).
 */
function validateReason(raw, { min = 10 } = {}) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'reason_required', min_length: min };
  }
  const reason = raw.trim();
  if (reason.length < min) return { ok: false, error: 'reason_too_short', min_length: min };
  if (reason.length > 500) return { ok: false, error: 'reason_too_long', max_length: 500 };
  return { ok: true, reason };
}

function requireReason({ min = 10, field = 'reason' } = {}) {
  return (req, res, next) => {
    const v = validateReason(req.body?.[field], { min });
    if (!v.ok) {
      const { ok, reason, ...body } = v; // eslint-disable-line no-unused-vars
      return res.status(400).json(body);
    }
    req.changeReason = v.reason;
    next();
  };
}

module.exports = {
  verifyJWT,
  requireRole,
  requireInstitution,
  requireReason,
  // Exported for the one gate that is conditional on WHICH fields a body
  // touches (PUT /institutions/:id), where a middleware cannot decide yet.
  validateReason,
};
