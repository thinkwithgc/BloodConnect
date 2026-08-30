// Donor-facing OTP errors, in the donor's own language.
//
// The two OTP surfaces (/login and /register) used to do
// `setError(err?.response?.data?.error || 'send_failed')` and render the result
// verbatim, so a donor could be shown the literal string `rate_limit_otp_send`.
// lib/errorMessage.js already does this job for staff, but it is English-only
// by design and its wording is aimed at a hospital clerk. Donors are the
// Marathi-first audience on this platform, so their codes get their own map
// with real MR / HI / EN copy in the main string dict.
//
// The important entry is `whatsapp_not_reachable`. `POST /auth/otp/send`
// answers it ONLY when Meta rejected the send for a recipient-side reason
// (see classifyFailure in services/notifications/whatsappCloudProvider.js) —
// never for an outage, an unapproved template or a missing env key. That
// distinction is the whole point: telling a donor whose WhatsApp works fine
// that they have no WhatsApp would send them away for nothing.

const CODE_KEYS = {
  // ── send ────────────────────────────────────────────────────────────────
  whatsapp_not_reachable: 'otp_err_no_whatsapp',
  otp_send_failed: 'otp_err_send_failed',
  rate_limit_otp_send: 'otp_err_rate_limited',
  rate_limit_login: 'otp_err_rate_limited',
  community_leader_not_registered: 'otp_err_leader_unknown',

  // ── verify ──────────────────────────────────────────────────────────────
  invalid_otp: 'otp_err_wrong_code',
  invalid_credentials: 'otp_err_wrong_code',
  otp_expired: 'otp_err_expired',
  account_locked: 'otp_err_locked',
  account_locked_too_many_attempts: 'otp_err_locked',

  // ── input (server + client both use these) ──────────────────────────────
  invalid_mobile: 'otp_err_bad_mobile',
  invalid_mobile_format: 'otp_err_bad_mobile',
  invalid_input: 'otp_err_bad_mobile',
  otp_must_be_6_digits: 'otp_err_six_digits',
};

/**
 * @param {unknown} err  a caught axios error, or a bare code string
 * @param {(key: string) => string} t  from useT()
 */
export function otpErrorText(err, t) {
  // A request that never got a response is the network, not the donor.
  if (err && err.request && !err.response) return t('otp_err_offline');

  const code = typeof err === 'string' ? err : err?.response?.data?.error;
  const key = CODE_KEYS[code];
  if (key) return t(key);

  if (err?.response?.status === 429) return t('otp_err_rate_limited');
  return t('otp_err_generic');
}

export default otpErrorText;
