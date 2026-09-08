/**
 * Setup-token service — magic-link password setup for institutional admins.
 *
 * Each function expects an already-connected pg client (so callers can run
 * inside their own transaction / RLS context). Plaintext tokens leave this
 * module only on generateToken() — every other function consumes them.
 *
 * Token shape: 43-char base64url string (32 random bytes encoded).
 * Storage: SHA-256 hash only. The URL we send to WhatsApp is the only
 * place the plaintext ever exists in our system.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DEFAULT_TTL_DAYS = 7;

/**
 * Mirrors migration 268's `username_format` CHECK verbatim. The DB is the
 * binding gate; this is the friendly one. Lower-case only — `username` is
 * CITEXT (so uniqueness is case-insensitive) but the CHECK rejects uppercase
 * outright, which is why normalisation lower-cases rather than merely trims.
 */
const USERNAME_RE = /^[a-z][a-z0-9_-]{2,31}$/;

/**
 * Names nobody may claim. Nothing in the schema reserved anything before now,
 * which was harmless while every username was derived from a shortname and is
 * not once the person at the keyboard chooses it.
 *
 * EXACT MATCH ONLY — not a prefix or substring test. Every institution admin
 * already in production is named `<shortname>_admin`, and a substring rule
 * would retroactively invalidate all of them.
 */
const RESERVED_NAMES = new Set([
  'admin',
  'root',
  'superadmin',
  'system',
  'raktify',
  'support',
  'test',
  'postgres',
  'api',
]);

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function normaliseUsername(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * Format + denylist + collision check for a candidate username.
 *
 * Returns a plain { available, reason } with reason ∈ format | reserved |
 * taken | ok. It deliberately never reveals WHO holds a taken name, nor
 * whether the holder is staff or a donor — `idx_platform_users_username` is
 * global, so a leak here would be a cross-institution one.
 *
 * `selfUserId` lets the caller's own current username come back available:
 * the setup screen pre-fills the provisional name, and the person has to be
 * able to simply accept it.
 */
async function isUsernameAvailable(client, candidate, selfUserId = null) {
  const u = normaliseUsername(candidate);
  if (!u || !USERNAME_RE.test(u)) return { available: false, reason: 'format' };
  if (RESERVED_NAMES.has(u)) return { available: false, reason: 'reserved' };

  const { rows } = await client.query(`SELECT id FROM platform_users WHERE username = $1`, [u]);
  if (rows.length === 0) return { available: true, reason: 'ok' };
  if (selfUserId && rows[0].id === selfUserId) return { available: true, reason: 'ok' };
  return { available: false, reason: 'taken' };
}

/**
 * Generate a fresh setup token for a platform_users row.
 * Stores the hash + expiry; clears any prior used_at marker so re-issuance
 * works after expiry. Returns the plaintext token (caller embeds in URL).
 */
async function generateSetupToken(client, userId, ttlDays = DEFAULT_TTL_DAYS) {
  const plaintext = crypto.randomBytes(32).toString('base64url');
  const hash = sha256(plaintext);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await client.query(
    `UPDATE platform_users
        SET setup_token_hash       = $1,
            setup_token_expires_at = $2,
            setup_token_used_at    = NULL
      WHERE id = $3`,
    [hash, expiresAt, userId],
  );

  return { token: plaintext, expiresAt };
}

/**
 * Look up a platform_users row by setup token. Returns user + institution
 * info for the setup-page UI, or a clear error code on failure.
 *
 * Returns { ok: true, user, institution } OR
 *         { ok: false, code: 'invalid' | 'expired' | 'used' }
 */
async function validateSetupToken(client, plaintextToken) {
  if (!plaintextToken || typeof plaintextToken !== 'string') {
    return { ok: false, code: 'invalid' };
  }
  const hash = sha256(plaintextToken);

  const { rows } = await client.query(
    `SELECT pu.id, pu.username, pu.email, pu.role, pu.institution_id,
            pu.setup_token_expires_at, pu.setup_token_used_at,
            i.shortname           AS institution_shortname,
            i.legal_name          AS institution_name,
            i.mou_signatory_name  AS signatory_name
       FROM platform_users pu
       LEFT JOIN institutions i ON i.id = pu.institution_id
      WHERE pu.setup_token_hash = $1`,
    [hash],
  );

  if (rows.length === 0) return { ok: false, code: 'invalid' };
  const r = rows[0];

  if (r.setup_token_used_at) return { ok: false, code: 'used' };
  if (new Date(r.setup_token_expires_at) <= new Date()) {
    return { ok: false, code: 'expired' };
  }

  return {
    ok: true,
    user: {
      id: r.id,
      username: r.username,
      email: r.email,
      role: r.role,
    },
    institution: {
      id: r.institution_id,
      shortname: r.institution_shortname,
      name: r.institution_name,
      signatory_name: r.signatory_name,
    },
    expires_at: r.setup_token_expires_at,
  };
}

/**
 * Consume a setup token: validate, bcrypt the new password, atomically
 * update password_hash + mark used_at. Single-use: a second consume call
 * with the same plaintext returns { ok: false, code: 'used' }.
 *
 * `chosenUsername` is OPTIONAL and, when given, renames the row over the
 * provisional `<shortname>_admin` / `<shortname>_<suffix>` name that
 * activate.js and POST /institutions/:id/users mint at INSERT time. It has to
 * stay optional: migration 268 designates this same route as the staff
 * PASSWORD-RESET path, and a password reset must never force a rename.
 */
async function consumeSetupToken(client, plaintextToken, newPassword, chosenUsername = null) {
  const v = await validateSetupToken(client, plaintextToken);
  if (!v.ok) return v;

  let username = null;
  if (chosenUsername !== null && chosenUsername !== undefined) {
    username = normaliseUsername(chosenUsername);
    if (!username || !USERNAME_RE.test(username)) {
      return { ok: false, code: 'username_format' };
    }
    if (RESERVED_NAMES.has(username)) {
      return { ok: false, code: 'username_reserved' };
    }
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  const hash = sha256(plaintextToken);

  // TWO CONSTANT STATEMENTS, not one assembled string. eslint's
  // no-restricted-syntax rule forbids interpolating anything into a query, and
  // the fixed column list is also the guarantee that this PUBLIC route can
  // never touch institution_id / role / is_institution_admin / mobile. The
  // row's institution was fixed when it was created, from the inviting
  // institution — naming cannot move it, which is what keeps a self-registered
  // user scoped to the institution that invited them.
  //
  // The WHERE clause includes setup_token_used_at IS NULL so a race
  // between two concurrent setup attempts produces a single winner — the
  // loser sees 0 rows updated and returns { ok: false, code: 'used' }.
  const SQL_PASSWORD_ONLY = `UPDATE platform_users
        SET password_hash         = $1,
            password_set_at       = NOW(),
            force_password_change = FALSE,
            setup_token_used_at   = NOW()
      WHERE setup_token_hash = $2
        AND setup_token_used_at IS NULL
        AND setup_token_expires_at > NOW()
      RETURNING id`;

  const SQL_WITH_USERNAME = `UPDATE platform_users
        SET password_hash         = $1,
            password_set_at       = NOW(),
            force_password_change = FALSE,
            setup_token_used_at   = NOW(),
            username              = $3
      WHERE setup_token_hash = $2
        AND setup_token_used_at IS NULL
        AND setup_token_expires_at > NOW()
      RETURNING id`;

  let result;
  try {
    result = username
      ? await client.query(SQL_WITH_USERNAME, [passwordHash, hash, username])
      : await client.query(SQL_PASSWORD_ONLY, [passwordHash, hash]);
  } catch (err) {
    // A lost race for the name must NOT burn the token: the UPDATE that would
    // have stamped setup_token_used_at is the same statement that failed, so
    // used_at stays NULL and the person can retry with a different name. The
    // caller must not be inside an open transaction for that to hold — the
    // only caller (POST /auth/setup/:token) runs on a bare pooled client.
    if (/idx_platform_users_username/.test(err.message)) {
      return { ok: false, code: 'username_taken' };
    }
    if (err.code === '23514' && /username_format/.test(err.message)) {
      return { ok: false, code: 'username_format' };
    }
    throw err;
  }

  if (result.rowCount === 0) return { ok: false, code: 'used' };
  return { ok: true, user_id: result.rows[0].id, username: username || v.user.username };
}

/**
 * Placeholder password to satisfy the auth_path_required CHECK constraint
 * on platform_users (staff roles need password_hash NOT NULL). The
 * plaintext is 32 random bytes that nobody sees — the user MUST go through
 * the setup link to set a real password.
 */
async function unusablePasswordHash() {
  return bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
}

module.exports = {
  generateSetupToken,
  validateSetupToken,
  consumeSetupToken,
  isUsernameAvailable,
  normaliseUsername,
  unusablePasswordHash,
  DEFAULT_TTL_DAYS,
  RESERVED_NAMES,
  USERNAME_RE,
};
