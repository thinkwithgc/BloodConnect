/**
 * Redaction for anything that reads audit_log back over HTTP.
 *
 * fn_audit_generic() (database/migrations/025_audit_log.sql) has no column
 * blacklist: on UPDATE it walks every changed key and writes one row per field,
 * so a password reset lands the old and new password_hash in old_value /
 * new_value, and a 2FA enrolment lands the totp_secret. That is fine in a table
 * only audit_writer can insert to and audit_reader can read. It is not fine in a
 * response body — an audit viewer must not be a credential-material viewer, and
 * "the reader is a super-admin" is not a reason to hand over a password hash to
 * anything that could be logged, cached or screenshotted downstream.
 *
 * The field NAME is always kept: "the password was changed, by this actor, at
 * this time" is exactly what an audit view exists to show. Only the values go.
 *
 * Deny-by-pattern rather than by list, so a sensitive column added later is
 * covered without anyone remembering to come back here. The `_at` / `_attempts`
 * / `_count` escape hatch keeps the useful bookkeeping columns readable
 * (setup_token_expires_at, failed_login_attempts) — they are named after a
 * secret but hold no secret.
 */

function isSensitiveAuditField(name) {
  if (!name) return false;
  if (/(_at|_attempts|_count)$/.test(name)) return false;
  return /password|secret|token|_hash$/i.test(name);
}

/**
 * Blank the values on a sensitive row, flagging it so the UI can say "withheld"
 * rather than rendering an empty cell that reads like "no previous value".
 */
function redactAuditRow(row) {
  if (!isSensitiveAuditField(row.field_name)) return row;
  return { ...row, old_value: null, new_value: null, value_withheld: true };
}

module.exports = { isSensitiveAuditField, redactAuditRow };
