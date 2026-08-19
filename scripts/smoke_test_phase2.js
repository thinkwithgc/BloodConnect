#!/usr/bin/env node
/**
 * Phase 2 smoke test — auth + institution onboarding.
 *
 * Boots the Express app in-process and exercises the complete flow:
 *   1.  Public POST /onboarding/apply creates a hospital + paired in-house
 *       blood bank in PE
 *   2.  Activating a PE institution is refused (must verify licence first)
 *   3.  ngo_admin POST /onboarding/verify/:id moves both rows to VE
 *   4.  ngo_admin POST /onboarding/:id/mou-scan files a scan of the paper MoU
 *   5.  ngo_admin POST /onboarding/activate/:id records the PAPER MoU and
 *       activates parent + child, provisioning both admin logins
 *   6.  DB assertions on the mou_versions archive + institution mirrors
 *   7.  Re-activating is refused (already_active)
 *   8.  HO admin sets their password via the magic setup link, logs in,
 *       enrols TOTP, and re-login then requires the code
 *   9.  Donor OTP flow: send → verify → JWT
 *  10.  Donor JWT cannot reach an ngo_admin-only endpoint
 *  11.  Bogus OTP → invalid; 5 in a row → account locked
 *
 * The MoU is signed OFFLINE ON PAPER — there is no eSign round-trip. Steps 4-5
 * replaced the old `generate-mou` + `mou-signed` webhook pair; see
 * backend/src/services/onboarding/activate.js.
 *
 * Note: this test uses unique-per-run identifiers so it is idempotent
 * across runs (audit_log permanence guarantee — see CLAUDE.md).
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// otplib + bcryptjs may be hoisted to root or live in backend/node_modules.
// Use createRequire scoped to backend so it follows backend's resolution tree.
const { createRequire } = require('module');
const backendRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));

const bcrypt = backendRequire('bcryptjs');
const totp = require('../backend/src/utils/totp');
const encryption = require('../backend/src/services/encryption');
const createApp = require('../backend/src/app');
const db = require('../backend/src/config/db');

const RUN_TAG = Date.now().toString().slice(-6);
const TEST = {
  // Max 23 chars for a hospital with an in-house BB — the child's
  // `<short>-bb_admin` username has to fit platform_users.username_format.
  shortname: `p2ho${RUN_TAG}`.slice(0, 23),
  // mobile must match +91[6-9]\d{9} (Indian operator range). Force a 9 prefix.
  contactMobile: `+919${RUN_TAG}001`, // 13 chars
  donorMobile: `+919${RUN_TAG}002`,
  ngoAdminMobile: `+919${RUN_TAG}003`,
  ngoAdminUsername: `ngoadm${RUN_TAG}`,
  ngoAdminPwd: 'AdminPass!2026',
  ngoAdminTotpSecret: null,
  state_id: null,
  district_id: null,
  institutionId: null,
  childInstitutionId: null,
  ngoAdminToken: null,
  hoAdminUsername: null,
  hoSetupToken: null,
  hoAdminPwd: 'HospitalPass2026',
  hoAdminToken: null,
  hoTotpSecret: null,
  scanKey: null,
  scanSha256: null,
  signedOn: null,
};

let pass = 0,
  fail = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    pass++;
  } else {
    console.error(`  ✗ ${msg}`);
    fail++;
  }
}

const app = createApp();
const PORT = 3010 + ((parseInt(RUN_TAG, 10) || 0) % 1000);

let server;
function fetchJson(method, urlPath, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

// Raw-body POST for the MoU scan upload. The route uses express.raw() because
// base64-in-JSON would be truncated by sanitizeInput at 8000 chars.
function fetchRaw(urlPath, buffer, contentType, token) {
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` },
    body: buffer,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

// Smallest thing that is genuinely a PDF as far as the route's magic-byte
// check is concerned — we're testing the upload path, not a PDF parser.
function fakePdf() {
  return Buffer.from(`%PDF-1.4\n% Raktify phase-2 smoke MoU scan ${RUN_TAG}\n%%EOF\n`, 'latin1');
}

// Resolve a real geography to hang the test institution off. The dev DB now
// carries imported LGD data, so INSERTing a synthetic Amravati collides with
// uq_district_short_per_state — take whatever active district exists instead.
async function resolveGeo() {
  const c = await db.pool.connect();
  try {
    const r = await c.query(
      `SELECT d.id AS district_id, d.state_id
         FROM districts d
         JOIN states s ON s.id = d.state_id
        WHERE d.is_active AND s.is_active
        ORDER BY d.id ASC
        LIMIT 1`,
    );
    if (r.rowCount === 0) {
      throw new Error('no active district in the DB — run the LGD import or seeds first');
    }
    TEST.district_id = r.rows[0].district_id;
    TEST.state_id = r.rows[0].state_id;
  } finally {
    c.release();
  }
}

// Seed an ngo_admin with TOTP already enrolled. 2FA is mandatory for staff
// (migration 296), and enrolling it over HTTP is exercised separately in step
// 8 — doing it here too would just be the same three calls twice.
async function seedNgoAdmin() {
  const secret = totp.newSecret();
  TEST.ngoAdminTotpSecret = secret;
  const c = await db.pool.connect();
  try {
    const r = await c.query(
      `INSERT INTO platform_users
         (role, username, mobile, password_hash, password_set_at,
          totp_secret, totp_enabled)
       VALUES ('ngo_admin', $1, $2, $3, NOW(), $4, TRUE)
       RETURNING id`,
      [
        TEST.ngoAdminUsername,
        TEST.ngoAdminMobile,
        await bcrypt.hash(TEST.ngoAdminPwd, 10),
        encryption.encrypt(secret),
      ],
    );
    return r.rows[0].id;
  } finally {
    c.release();
  }
}

async function dbRow(sql, params) {
  const c = await db.pool.connect();
  try {
    const r = await c.query(sql, params);
    return r.rows[0] || null;
  } finally {
    c.release();
  }
}

async function main() {
  await resolveGeo();
  await seedNgoAdmin();

  await new Promise((resolve) => {
    server = app.listen(PORT, '127.0.0.1', () => resolve());
  });
  console.log(`── Phase 2 smoke (port ${PORT}, tag ${RUN_TAG}) ─────────────────`);

  try {
    console.log('── 1. Public apply → PE (hospital + in-house blood bank) ────');
    let r = await fetchJson('POST', '/onboarding/apply', {
      body: {
        kind: 'HO',
        shortname: TEST.shortname,
        legal_name: 'Phase 2 Smoke Hospital',
        display_name: 'P2 Smoke Hospital',
        state_id: TEST.state_id,
        district_id: TEST.district_id,
        address_line: '12 Phase 2 Smoke Lane, Amravati',
        pincode: '444601',
        hospital_registration_no: `HOSPREG-P2-${RUN_TAG}`,
        cdsco_licence_number: `CDSCO-P2-${RUN_TAG}`,
        cdsco_licence_expires: new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10),
        primary_contact_name: 'P2 Smoke Contact',
        primary_contact_designation: 'Medical Superintendent',
        primary_contact_mobile: TEST.contactMobile,
        has_inhouse_blood_bank: true,
      },
    });
    assert(r.status === 201, `apply returns 201 (got ${r.status} ${JSON.stringify(r.body)})`);
    assert(r.body.onboarding_status === 'PE', 'institution created in PE state');
    assert(!!r.body.child_institution_id, 'paired in-house blood bank row created');
    TEST.institutionId = r.body.institution_id;
    TEST.childInstitutionId = r.body.child_institution_id;

    console.log('── 2. ngo_admin login (username + password + TOTP) ──────────');
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: {
        username: TEST.ngoAdminUsername,
        password: TEST.ngoAdminPwd,
        totp_code: await totp.currentCode(TEST.ngoAdminTotpSecret),
      },
    });
    assert(
      r.status === 200 && r.body.token,
      `ngo_admin login returns token (got ${r.status} ${JSON.stringify(r.body)})`,
    );
    TEST.ngoAdminToken = r.body.token;
    const auth = { Authorization: `Bearer ${TEST.ngoAdminToken}` };

    console.log('── 3. Activate before verify is refused ─────────────────────');
    TEST.signedOn = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    r = await fetchJson('POST', `/onboarding/activate/${TEST.institutionId}`, {
      headers: auth,
      body: { mou_signed_on: TEST.signedOn, signatory_name: 'P2 Smoke Contact' },
    });
    assert(
      r.status === 409 && r.body.error === 'must_verify_license_first',
      `activate on PE → 409 must_verify_license_first (got ${r.status} ${r.body.error})`,
    );

    console.log('── 4. Verify licences → VE ──────────────────────────────────');
    r = await fetchJson('POST', `/onboarding/verify/${TEST.institutionId}`, { headers: auth });
    assert(
      r.status === 200 && r.body.onboarding_status === 'VE',
      `verify → VE (got ${r.status} ${r.body.onboarding_status})`,
    );

    console.log('── 5. Upload the paper-MoU scan ─────────────────────────────');
    const pdf = fakePdf();
    r = await fetchRaw(
      `/onboarding/${TEST.institutionId}/mou-scan`,
      pdf,
      'application/pdf',
      TEST.ngoAdminToken,
    );
    assert(
      r.status === 200 && r.body.storage_key && /^[0-9a-f]{64}$/.test(r.body.sha256 || ''),
      `mou-scan returns key + sha256 (got ${r.status} ${JSON.stringify(r.body)})`,
    );
    assert(r.body.bytes === pdf.length, `stored byte count matches upload (${r.body.bytes})`);
    TEST.scanKey = r.body.storage_key;
    TEST.scanSha256 = r.body.sha256;

    // A mislabelled upload must not be filed as the legal original.
    r = await fetchRaw(
      `/onboarding/${TEST.institutionId}/mou-scan`,
      Buffer.from('not a pdf at all'),
      'application/pdf',
      TEST.ngoAdminToken,
    );
    assert(
      r.status === 400 && r.body.error === 'content_type_mismatch',
      `non-PDF bytes declared as PDF → 400 (got ${r.status} ${r.body.error})`,
    );

    console.log('── 6. Activate against the paper MoU ────────────────────────');
    r = await fetchJson('POST', `/onboarding/activate/${TEST.institutionId}`, {
      headers: auth,
      body: {
        mou_signed_on: TEST.signedOn,
        signatory_name: 'P2 Smoke Contact',
        signatory_designation: 'Medical Superintendent',
        mou_scan_key: TEST.scanKey,
        mou_scan_sha256: TEST.scanSha256,
      },
    });
    assert(
      r.status === 200 && r.body.status === 'activated',
      `activate → activated (got ${r.status} ${JSON.stringify(r.body)})`,
    );
    assert(r.body.onboarding_status === 'AC', 'response reports AC');
    assert(r.body.mou_signing_mode === 'PA', 'response reports paper signing mode');
    assert(!!r.body.dev_ho_setup_url, 'HO admin setup URL echoed in development');
    assert(!!r.body.dev_bb_setup_url, 'paired BB admin setup URL echoed in development');
    TEST.hoAdminUsername = r.body.ho_admin_username;
    TEST.hoSetupToken = String(r.body.dev_ho_setup_url).split('/setup/')[1];
    const bbSetupToken = String(r.body.dev_bb_setup_url).split('/setup/')[1];

    console.log('── 7. DB archive assertions ─────────────────────────────────');
    const mou = await dbRow(
      `SELECT signing_mode, version_number, signatory_name, signatory_designation,
              leegally_doc_id, pdf_storage_key, pdf_sha256,
              effective_from::text AS effective_from, effective_until::text AS effective_until
         FROM mou_versions WHERE institution_id = $1 ORDER BY version_number DESC LIMIT 1`,
      [TEST.institutionId],
    );
    assert(!!mou, 'mou_versions row filed');
    assert(mou && mou.signing_mode === 'PA', `signing_mode = PA (got ${mou && mou.signing_mode})`);
    assert(mou && mou.version_number === 1, 'first version is v1');
    assert(mou && mou.leegally_doc_id === null, 'no Leegality doc id on a paper MoU');
    assert(mou && mou.pdf_storage_key === TEST.scanKey, 'scan storage key recorded');
    assert(mou && mou.pdf_sha256 === TEST.scanSha256, 'scan sha256 recorded');
    assert(
      mou && mou.effective_from === TEST.signedOn,
      `effective_from is the signing date (got ${mou && mou.effective_from})`,
    );
    const expectedUntil = new Date(`${TEST.signedOn}T00:00:00Z`);
    expectedUntil.setUTCFullYear(expectedUntil.getUTCFullYear() + 1);
    assert(
      mou && mou.effective_until === expectedUntil.toISOString().slice(0, 10),
      `effective_until is signed + 1 year (got ${mou && mou.effective_until})`,
    );

    const parentRow = await dbRow(
      `SELECT onboarding_status, mou_signing_mode, mou_signatory_name,
              mou_expires_at::text AS mou_expires_at, onboarded_at,
              bb_admin_pending_setup_token
         FROM institutions WHERE id = $1`,
      [TEST.institutionId],
    );
    assert(parentRow.onboarding_status === 'AC', 'parent hospital is AC');
    assert(parentRow.mou_signing_mode === 'PA', 'parent mirrors mou_signing_mode = PA');
    assert(!!parentRow.onboarded_at, 'onboarded_at stamped by the DB trigger');
    assert(
      parentRow.mou_expires_at === expectedUntil.toISOString().slice(0, 10),
      `mou_expires_at is signed + 1 year (got ${parentRow.mou_expires_at})`,
    );
    assert(
      !!parentRow.bb_admin_pending_setup_token,
      'child BB admin setup token stashed on the parent row',
    );

    const childRow = await dbRow(`SELECT onboarding_status FROM institutions WHERE id = $1`, [
      TEST.childInstitutionId,
    ]);
    assert(childRow.onboarding_status === 'AC', 'paired blood bank flipped to AC with its parent');

    console.log('── 8. Re-activating is refused ──────────────────────────────');
    r = await fetchJson('POST', `/onboarding/activate/${TEST.institutionId}`, {
      headers: auth,
      body: { mou_signed_on: TEST.signedOn, signatory_name: 'P2 Smoke Contact' },
    });
    assert(
      r.status === 409 && r.body.error === 'already_active',
      `second activate → 409 already_active (got ${r.status} ${r.body.error})`,
    );

    console.log('── 9. HO admin sets password via the magic setup link ───────');
    r = await fetchJson('GET', `/auth/setup/${TEST.hoSetupToken}`);
    assert(
      r.status === 200 && r.body.username === TEST.hoAdminUsername,
      `setup token resolves to ${TEST.hoAdminUsername} (got ${r.status} ${r.body.username})`,
    );
    r = await fetchJson('POST', `/auth/setup/${TEST.hoSetupToken}`, {
      body: { password: TEST.hoAdminPwd, confirm_password: TEST.hoAdminPwd },
    });
    assert(r.status === 200 && r.body.status === 'set', `password set (got ${r.status})`);

    console.log('── 10. HO admin login → TOTP enrolment → re-login ───────────');
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { username: TEST.hoAdminUsername, password: TEST.hoAdminPwd },
    });
    assert(r.status === 200 && r.body.token, `HO admin login returns token (got ${r.status})`);
    assert(r.body.totp_setup_required === true, 'HO admin must enrol TOTP before anything else');
    TEST.hoAdminToken = r.body.token;

    r = await fetchJson('POST', '/auth/institutional/setup-totp', {
      headers: { Authorization: `Bearer ${TEST.hoAdminToken}` },
    });
    assert(r.status === 200 && r.body.otpauth_url, 'setup-totp returns otpauth URL');
    const m = (r.body.otpauth_url || '').match(/secret=([^&]+)/);
    TEST.hoTotpSecret = m && m[1];
    assert(!!TEST.hoTotpSecret, 'extracted TOTP secret from otpauth URL');

    r = await fetchJson('POST', '/auth/institutional/confirm-totp', {
      headers: { Authorization: `Bearer ${TEST.hoAdminToken}` },
      body: { totp_code: await totp.currentCode(TEST.hoTotpSecret) },
    });
    assert(r.status === 200 && r.body.status === 'totp_enabled', 'TOTP enabled');

    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { username: TEST.hoAdminUsername, password: TEST.hoAdminPwd },
    });
    assert(
      r.status === 401 && r.body.error === 'totp_required',
      `re-login without TOTP rejected (got ${r.status} ${r.body.error})`,
    );

    r = await fetchJson('POST', '/auth/institutional/login', {
      body: {
        username: TEST.hoAdminUsername,
        password: TEST.hoAdminPwd,
        totp_code: await totp.currentCode(TEST.hoTotpSecret),
      },
    });
    assert(r.status === 200 && r.body.token, 'login with TOTP succeeds');

    console.log('── 11. Consuming the BB token clears the parent pointer ─────');
    r = await fetchJson('POST', `/auth/setup/${bbSetupToken}`, {
      body: { password: 'BloodBankPass2026', confirm_password: 'BloodBankPass2026' },
    });
    assert(r.status === 200 && r.body.status === 'set', `BB admin password set (got ${r.status})`);
    const cleared = await dbRow(
      `SELECT bb_admin_pending_setup_token FROM institutions WHERE id = $1`,
      [TEST.institutionId],
    );
    assert(
      cleared.bb_admin_pending_setup_token === null,
      'trg_clear_bb_admin_pending_token wiped the parent pointer',
    );

    console.log('── 12. Donor OTP send + verify ──────────────────────────────');
    r = await fetchJson('POST', '/auth/otp/send', { body: { mobile: TEST.donorMobile } });
    assert(r.status === 200 && r.body.dev_otp, `OTP send returns dev_otp (got ${r.status})`);
    const sentOtp = r.body.dev_otp;

    r = await fetchJson('POST', '/auth/otp/verify', {
      body: { mobile: TEST.donorMobile, otp: sentOtp },
    });
    assert(
      r.status === 200 && r.body.token && r.body.role === 'donor',
      `OTP verify returns donor JWT (got ${r.status})`,
    );
    const donorToken = r.body.token;

    console.log('── 13. Donor cannot reach ngo_admin endpoint ────────────────');
    r = await fetchJson('GET', '/onboarding/applications', {
      headers: { Authorization: `Bearer ${donorToken}` },
    });
    assert(r.status === 403, `donor → /onboarding/applications returns 403 (got ${r.status})`);

    console.log('── 14. Wrong OTP attempts → eventual lock ───────────────────');
    // Get a fresh OTP issued so the user has otp_hash set, then try wrong codes.
    r = await fetchJson('POST', '/auth/otp/send', { body: { mobile: TEST.donorMobile } });
    assert(r.status === 200, 'fresh OTP sent for lock test');
    let lockedAtAttempt = null;
    for (let i = 1; i <= 5; i++) {
      const wrong = await fetchJson('POST', '/auth/otp/verify', {
        body: { mobile: TEST.donorMobile, otp: '000000' },
      });
      if (wrong.body.error === 'account_locked_too_many_attempts') {
        lockedAtAttempt = i;
        break;
      }
    }
    assert(lockedAtAttempt === 5, `account locks at attempt 5 (got ${lockedAtAttempt})`);

    console.log('── 15. Removed eSign routes are gone ────────────────────────');
    r = await fetchJson('POST', `/onboarding/generate-mou/${TEST.institutionId}`, {
      headers: auth,
    });
    assert(r.status === 404, `POST /onboarding/generate-mou/:id → 404 (got ${r.status})`);
    r = await fetchJson('POST', '/onboarding/mou-signed', { body: { doc_id: 'x' } });
    assert(r.status === 404, `POST /onboarding/mou-signed → 404 (got ${r.status})`);
  } catch (err) {
    console.error('FATAL during smoke:', err.message);
    console.error(err.stack);
    fail++;
  } finally {
    await new Promise((r) => server.close(r));
    await db.shutdown();
  }

  console.log('');
  console.log('─'.repeat(58));
  console.log(`Phase 2 smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
