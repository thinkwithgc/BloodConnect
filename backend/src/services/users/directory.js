/**
 * Staff-user directory helpers — shared by the two surfaces that list
 * institution logins:
 *
 *   GET /institutions/:id/users        (the institution's own Team panel)
 *   GET /admin/institution-users       (NGO admin, cross-institution)
 *
 * Both must agree on what "this account is stuck" means, so the SELECT list and
 * the state machine live here rather than being written twice. The NGO-admin
 * screen exists precisely because an account can be stuck — an activation whose
 * SETUP_LINK WhatsApp never arrived is invisible from every other screen — so
 * the state label is the load-bearing part of this module.
 *
 * Nothing here touches the setup-token hash. `generateSetupToken` stores only
 * SHA-256(token); the plaintext exists solely in the delivered URL. The roster
 * can therefore report *that* a link is outstanding and when it expires, but
 * never re-derive it — re-issuing mints a new token (see the reissue-setup
 * route), which also invalidates the old one.
 */

/**
 * Column list for a staff roster row. Ordered as it renders.
 *
 * Deliberately omits `setup_token_hash` (a credential-equivalent digest),
 * `password_hash`, `totp_secret`, `otp_hash` and `last_login_ip` — the roster is
 * an administrative view, not an auth path, and none of those are needed to
 * decide what to click. `setup_token_hash IS NOT NULL` is projected as a boolean
 * instead so the state machine can see an outstanding link without the digest
 * crossing a router boundary.
 *
 * Callers prefix it with their own table alias.
 */
const ROSTER_COLUMNS = `
  pu.id,
  pu.role,
  pu.username,
  pu.mobile,
  pu.email,
  pu.institution_id,
  pu.district_id,
  pu.is_institution_admin,
  pu.password_set_at,
  pu.force_password_change,
  pu.totp_enabled,
  pu.totp_verified_at,
  pu.is_locked,
  pu.locked_until,
  pu.failed_login_attempts,
  pu.last_login_at,
  (pu.setup_token_hash IS NOT NULL) AS has_setup_token,
  pu.setup_token_expires_at,
  pu.setup_token_used_at,
  pu.deactivated_at,
  pu.deactivated_by,
  pu.deactivation_reason,
  pu.created_at
`;

/** Every state `computeCredentialState` can return, worst-first. */
const CREDENTIAL_STATES = [
  'deactivated',
  'locked',
  'setup_expired',
  'setup_pending',
  'never_signed_in',
  'active',
];

/**
 * One label per account, describing whether that person can sign in right now
 * and what the operator should do about it.
 *
 * Precedence is worst-first, and the order matters: an account can easily be
 * both locked and holding an unused setup link, and the lock is what has to be
 * cleared first. Similarly `setup_expired` outranks `setup_pending` only
 * because they are mutually exclusive by construction (one token, one expiry).
 *
 *   deactivated     — retired. POST /auth/institutional/login returns 403.
 *   locked          — too many failed sign-ins; clears itself at locked_until,
 *                     or immediately via the unlock action.
 *   setup_expired   — a link was issued and never used before it lapsed. This
 *                     is the state a hospital whose WhatsApp silently failed
 *                     lands in after 7 days; re-issue.
 *   setup_pending   — a live link is outstanding. If the send failed, the URL
 *                     from the issuing response is the only copy — re-issue if
 *                     it was lost.
 *   never_signed_in — password is set but the account has never been used.
 *                     Usually benign (a second admin), occasionally a sign the
 *                     credentials went to the wrong person.
 *   active          — has signed in at least once and nothing is blocking.
 *
 * @param {object} row A row selected with ROSTER_COLUMNS.
 * @param {Date}  [now] Injectable for tests.
 * @returns {'deactivated'|'locked'|'setup_expired'|'setup_pending'|'never_signed_in'|'active'}
 */
function computeCredentialState(row, now = new Date()) {
  if (row.deactivated_at) return 'deactivated';

  // `locked_until` in the past means the lock has aged out — POST
  // /auth/institutional/login auto-clears it on the next attempt, so reporting
  // it as locked would send an operator chasing a lock that isn't there.
  if (row.is_locked && (!row.locked_until || new Date(row.locked_until) > now)) {
    return 'locked';
  }

  // An outstanding setup link means the password is a random placeholder
  // (services/users/setup.js unusablePasswordHash) — nobody can sign in until
  // the link is consumed, whatever password_set_at says.
  if (row.has_setup_token && !row.setup_token_used_at) {
    const expires = row.setup_token_expires_at ? new Date(row.setup_token_expires_at) : null;
    if (!expires || expires <= now) return 'setup_expired';
    return 'setup_pending';
  }

  if (!row.last_login_at) return 'never_signed_in';
  return 'active';
}

/**
 * Mask all but the last four digits of a mobile number.
 *
 * Mirrors maskMobile in frontend/src/pages/admin/OnboardingTab.jsx and the
 * hospital-facing donor-mobile rule in CLAUDE.md (§ "Hospital-facing API
 * rule"). Applied to the roster because a staff roster is a directory, not a
 * contact list: an operator needs to confirm *which* number a setup link went
 * to, which the last four digits answer, and nothing on these screens needs the
 * full number. The institution's own admin sees the same masked form — they
 * already know their colleagues' numbers, and it keeps one code path.
 *
 * @param {string|null|undefined} m
 * @returns {string|null} null when there is no number on file.
 */
function maskMobile(m) {
  if (!m) return null;
  const s = String(m).replace(/\s+/g, '');
  if (s.length < 5) return '••••';
  return `${s.slice(0, -10)}••••••${s.slice(-4)}`;
}

/**
 * Shape one roster row for the wire: mask the mobile, add the computed state,
 * drop nothing else. Both list endpoints run every row through this so the two
 * screens can never disagree about what a state means.
 *
 * @param {object} row  A row selected with ROSTER_COLUMNS (plus any joined
 *                      institution columns the caller added — they pass
 *                      through untouched).
 * @param {Date}  [now]
 */
function toRosterRow(row, now = new Date()) {
  const { mobile, ...rest } = row;
  return {
    ...rest,
    mobile_masked: maskMobile(mobile),
    has_mobile: Boolean(mobile),
    credential_state: computeCredentialState(row, now),
  };
}

module.exports = {
  ROSTER_COLUMNS,
  CREDENTIAL_STATES,
  computeCredentialState,
  maskMobile,
  toRosterRow,
};
