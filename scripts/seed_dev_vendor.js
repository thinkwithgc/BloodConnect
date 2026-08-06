#!/usr/bin/env node
/**
 * seed_dev_vendor.js — one-shot dev tool to make the vendor push webhook
 * testable without needing Strides.
 *
 * What it does:
 *  1. Creates (or finds) a `vendor_partners` row for a fake vendor.
 *  2. Picks an existing blood-bank institution on this DB (kind='BB'). Prefers
 *     onboarding_status='AC'; falls back to any BB it finds. Errors out if none.
 *  3. Generates a random 32-byte HMAC secret, seals it via services/pii/seal(),
 *     inserts a `partner_keys` row bound to that vendor + institution.
 *  4. Prints the plaintext secret + partner_key to stdout — this is the ONLY
 *     time the plaintext secret is visible. Copy it into the simulator command.
 *
 * Usage:
 *   node scripts/seed_dev_vendor.js
 *
 * Optional flags:
 *   --vendor-name "Strides Software"    (default)
 *   --institution-shortname pdmc-amt    (override the auto-picked BB)
 *   --rotate                            (revoke existing keys for this vendor+BB
 *                                        and issue a fresh one)
 *
 * Runs against whatever DATABASE_URL is set in your local .env — for dev this
 * should point at Neon. Refuses to run against a URL that looks like prod
 * unless you set ALLOW_PROD=1 (safety net).
 */
const path = require('path');
// Load .env explicitly from repo root (npm run typically sets CWD to the
// repo root, but this makes the script robust to being called directly too).
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
// Also load backend/.env if it exists — the backend workspace sometimes has
// its own env file with the encryption / JWT vars.
require('dotenv').config({ path: path.resolve(__dirname, '..', 'backend', '.env') });
const crypto = require('crypto');
const { Pool } = require('pg');

// pii module lives in the backend workspace; require from there.
const { seal } = require(path.resolve(__dirname, '..', 'backend', 'src', 'services', 'pii'));

function arg(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const val = process.argv[idx + 1];
  return val && !val.startsWith('--') ? val : true;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set. Configure your .env before running.');
    process.exit(1);
  }
  // Safety net: refuse to run against anything that looks like the prod
  // Azure DB unless the operator explicitly overrides.
  if (/raktify-db\.postgres\.database\.azure\.com/i.test(dbUrl) && !process.env.ALLOW_PROD) {
    console.error(
      'Refusing to seed dev vendor against the PROD DB (raktify-db.postgres.database.azure.com).',
    );
    console.error('If you really mean to do this, re-run with ALLOW_PROD=1.');
    process.exit(2);
  }

  const vendorName = arg('--vendor-name', 'Strides Software');
  const shortname = arg('--institution-shortname');
  const rotate = process.argv.includes('--rotate');

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const c = await pool.connect();

  try {
    // 1. Vendor partner row (idempotent).
    let vendorId;
    const vExisting = await c.query(`SELECT id FROM vendor_partners WHERE name = $1`, [vendorName]);
    if (vExisting.rowCount > 0) {
      vendorId = vExisting.rows[0].id;
      console.log(`[vendor_partners] found existing: ${vendorName} (${vendorId})`);
    } else {
      const vNew = await c.query(
        `INSERT INTO vendor_partners (name, contact_email, notes)
         VALUES ($1, 'contact@stridessoftware.com', 'Auto-seeded by scripts/seed_dev_vendor.js')
         RETURNING id`,
        [vendorName],
      );
      vendorId = vNew.rows[0].id;
      console.log(`[vendor_partners] created: ${vendorName} (${vendorId})`);
    }

    // 2. Pick an institution.
    let inst;
    if (shortname) {
      const r = await c.query(
        `SELECT id, shortname, display_name, kind, onboarding_status
           FROM institutions WHERE shortname = $1`,
        [shortname],
      );
      if (r.rowCount === 0) {
        console.error(`No institution with shortname '${shortname}'. Aborting.`);
        process.exit(3);
      }
      inst = r.rows[0];
    } else {
      const r = await c.query(
        `SELECT id, shortname, display_name, kind, onboarding_status
           FROM institutions
          WHERE kind = 'BB'
          ORDER BY (onboarding_status = 'AC') DESC, created_at DESC
          LIMIT 1`,
      );
      if (r.rowCount === 0) {
        console.error(
          `No blood-bank institution found on this DB. Run scripts/seed_demo.js first, or apply and complete an onboarding via /onboarding/apply.`,
        );
        process.exit(4);
      }
      inst = r.rows[0];
    }
    console.log(
      `[institution] using: ${inst.display_name} (${inst.shortname}) [${inst.onboarding_status}]`,
    );

    // 3. Rotate: revoke existing active keys for this pair.
    if (rotate) {
      const rev = await c.query(
        `UPDATE partner_keys
            SET is_active = FALSE, revoked_at = NOW(), notes = COALESCE(notes,'') || ' [rotated by seed_dev_vendor.js]'
          WHERE vendor_partner_id = $1 AND institution_id = $2 AND is_active = TRUE
        RETURNING partner_key`,
        [vendorId, inst.id],
      );
      if (rev.rowCount > 0) {
        console.log(`[rotate] revoked ${rev.rowCount} existing key(s):`, rev.rows.map((r) => r.partner_key));
      }
    }

    // 4. Generate secret + partner_key.
    const partnerKey = `pk_${crypto.randomBytes(16).toString('base64url')}`;
    const secretPlain = crypto.randomBytes(32).toString('base64url');
    const sealedSecret = seal(secretPlain);

    // Attribute the key creation to an admin user so downstream writes
    // (donation → auto-inventory row) have a non-null actor.
    const adminR = await c.query(
      `SELECT id FROM platform_users WHERE role IN ('super_admin','ngo_admin') ORDER BY created_at ASC LIMIT 1`,
    );
    const createdBy = adminR.rowCount > 0 ? adminR.rows[0].id : null;

    await c.query(
      `INSERT INTO partner_keys
         (partner_key, vendor_partner_id, institution_id, hmac_secret, is_active, created_by, notes)
       VALUES ($1, $2, $3, $4, TRUE, $5, 'Auto-seeded by scripts/seed_dev_vendor.js')`,
      [partnerKey, vendorId, inst.id, sealedSecret, createdBy],
    );

    // 5. Print everything the simulator needs.
    console.log('');
    console.log('=================================================================');
    console.log('  Vendor push webhook — dev credentials');
    console.log('=================================================================');
    console.log('  Vendor          :', vendorName);
    console.log('  Institution     :', inst.display_name, '(' + inst.shortname + ')');
    console.log('  Partner key     :', partnerKey);
    console.log('  HMAC secret     :', secretPlain);
    console.log('  API base URL    :', process.env.RAKTIFY_API_URL || 'http://localhost:3000');
    console.log('=================================================================');
    console.log('  Save the SECRET now — it is not retrievable later.');
    console.log('');
    console.log('Next: run the simulator with these values, e.g.');
    console.log('  node scripts/vendor_push_simulator.js donor \\');
    console.log('    --partner-key', partnerKey, '\\');
    console.log('    --secret', secretPlain);
    console.log('');
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('seed_dev_vendor failed:', err.message);
  process.exit(1);
});
