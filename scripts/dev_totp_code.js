#!/usr/bin/env node
/**
 * DEV ONLY — print the current TOTP code for a staff account.
 *
 * Staff 2FA is mandatory (migration 296), so every local test of an /admin,
 * /hospital, /bb, /coordinator or /dho screen needs a live 6-digit code. If the
 * account's authenticator isn't on your phone (smoke-test accounts, or an admin
 * enrolled on another machine) this reads `totp_secret` from the DB, decrypts it
 * with the local encryption key, and prints the code for the current 30s window.
 *
 * Usage:
 *   node scripts/dev_totp_code.js <username>
 *   node scripts/dev_totp_code.js --list          # staff accounts + whether their secret decrypts
 *
 * Refuses to run unless NODE_ENV=development. It prints only the 6-digit code,
 * never the secret. A "DECRYPT FAIL" in --list means that account was enrolled
 * under a different LOCAL_ENCRYPTION_KEY_HEX and can no longer log in at all —
 * the server hits the same error when verifying. Use the admin reset-2fa
 * endpoint, or bootstrap a fresh account.
 */
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Pool } = require('pg');

const encryption = require('../backend/src/services/encryption');
const totp = require('../backend/src/utils/totp');

if ((process.env.NODE_ENV || 'development') !== 'development') {
  console.error('Refusing to run outside NODE_ENV=development.');
  process.exit(1);
}

const STAFF_ROLES = ['hospital', 'blood_bank', 'ngo_admin', 'super_admin', 'dho', 'coordinator'];

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/dev_totp_code.js <username> | --list');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    if (arg === '--list') {
      const r = await pool.query(
        `SELECT username, role, totp_enabled, totp_secret
           FROM platform_users
          WHERE role = ANY($1) AND username IS NOT NULL
          ORDER BY role, created_at`,
        [STAFF_ROLES],
      );
      const rows = [];
      for (const u of r.rows) {
        let secretState = 'not enrolled';
        if (u.totp_secret) {
          try {
            encryption.decrypt(u.totp_secret);
            secretState = 'ok';
          } catch {
            secretState = 'DECRYPT FAIL (wrong key — account locked out)';
          }
        }
        rows.push({
          username: u.username,
          role: u.role,
          totp_enabled: u.totp_enabled,
          secret: secretState,
        });
      }
      console.table(rows);
      return;
    }

    const r = await pool.query(
      `SELECT username, role, totp_enabled, totp_secret
         FROM platform_users WHERE username = $1`,
      [arg],
    );
    if (r.rowCount === 0) {
      console.error(`No platform_users row with username "${arg}". Try --list.`);
      process.exit(1);
    }
    const u = r.rows[0];
    if (!u.totp_secret) {
      console.error(
        `${u.username} (${u.role}) has no TOTP secret yet — log in once to get the enrolment QR.`,
      );
      process.exit(1);
    }

    let secret;
    try {
      secret = encryption.decrypt(u.totp_secret);
    } catch {
      console.error(
        `${u.username}: totp_secret was sealed with a different LOCAL_ENCRYPTION_KEY_HEX than the ` +
          `one in .env, so it cannot be decrypted — this account cannot log in at all (the server ` +
          `hits the same error). Reset its 2FA or bootstrap a fresh admin.`,
      );
      process.exit(1);
    }

    const code = await totp.currentCode(secret);
    console.log(`${u.username} (${u.role})  code: ${code}`);
    console.log('Valid for the rest of this 30-second window — re-run if it expires.');
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
