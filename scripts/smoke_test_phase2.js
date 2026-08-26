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
 *  12.  Institution staff-user management: roster, invite, non-admin +
 *        cross-institution refusals, last-admin protection, deactivate →
 *        403 account_deactivated, reactivate + re-issue a working setup
 *        link, and the cross-institution admin directory
 *  13.  In-house blood bank: the hospital's admin provisions its logins,
 *        and the blood bank's own admin gets no reach back up
 *  14.  Institution details editing: a critical field (licence expiry)
 *        needs a written reason, a routine one does not, and the reason
 *        lands verbatim on the audit row for that field
 *  15.  Reversible lifecycle: suspend blocks sign-in, un-suspend restores
 *        it, archive is super_admin-only and refuses an institution with
 *        live work, and un-archive brings the family back as suspended
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

/** Read a repo file as text, for assertions about the code itself. */
function readSource(rel) {
  return require('fs').readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
}

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

  // Archive / un-archive sit one role above the rest of the admin surface: an
  // ngo_admin may suspend an institution, retiring one outright is super_admin.
  superAdminUsername: `supadm${RUN_TAG}`,
  superAdminMobile: `+919${RUN_TAG}007`,
  superAdminPwd: 'SuperPass!2026',
  superAdminTotpSecret: null,
  superAdminToken: null,

  // A third institution, unrelated to the hospital under test: its admin must be
  // refused on both the hospital and the hospital's in-house blood bank.
  outsiderShortname: `p2out${RUN_TAG}`.slice(0, 23),
  outsiderContactMobile: `+919${RUN_TAG}008`,
  outsiderInstitutionId: null,
  outsiderAdminUsername: `p2out${RUN_TAG}_admin`,
  outsiderAdminMobile: `+919${RUN_TAG}009`,
  outsiderAdminPwd: 'OutsiderPass2026',
  outsiderAdminTotpSecret: null,
  outsiderToken: null,
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

/**
 * A super_admin. Archive / un-archive are deliberately narrower than the rest of
 * the admin surface, so proving that boundary needs an account one rank above the
 * ngo_admin seeded above. Same shape, TOTP pre-enrolled.
 */
async function seedSuperAdmin() {
  const secret = totp.newSecret();
  TEST.superAdminTotpSecret = secret;
  const c = await db.pool.connect();
  try {
    await c.query(
      `INSERT INTO platform_users
         (role, username, mobile, password_hash, password_set_at,
          totp_secret, totp_enabled)
       VALUES ('super_admin', $1, $2, $3, NOW(), $4, TRUE)`,
      [
        TEST.superAdminUsername,
        TEST.superAdminMobile,
        await bcrypt.hash(TEST.superAdminPwd, 10),
        encryption.encrypt(secret),
      ],
    );
  } finally {
    c.release();
  }
}

/**
 * An unrelated active hospital with its own institution admin.
 *
 * Seeded directly rather than driven through apply → verify → activate: that path
 * is what steps 1-5 are for, and walking it twice would double the runtime to
 * prove nothing new. What matters here is only the shape - an AC institution
 * whose admin holds a full-privilege token - so the parent → child widening in
 * resolveInstitutionAdmin can be shown NOT to leak sideways.
 *
 * is_active / onboarded_at are written explicitly because fn_institutions_touch()
 * mirrors them on the UPDATE path only; an INSERT straight to 'AC' would
 * otherwise leave an inactive row and make the 403 below ambiguous.
 */
async function seedOutsiderInstitution() {
  const secret = totp.newSecret();
  TEST.outsiderAdminTotpSecret = secret;
  const c = await db.pool.connect();
  try {
    const inst = await c.query(
      `INSERT INTO institutions
         (kind, shortname, legal_name, display_name, state_id, district_id,
          address_line, pincode, primary_contact_name, primary_contact_mobile,
          onboarding_status, is_active, onboarded_at)
       VALUES ('HO', $1, $2, $3, $4, $5, $6, '444601',
               'P2 Outsider Contact', $7, 'AC', TRUE, NOW())
       RETURNING id`,
      [
        TEST.outsiderShortname,
        'Phase 2 Smoke Outsider Hospital',
        'P2 Outsider Hospital',
        TEST.state_id,
        TEST.district_id,
        '9 Unrelated Road, Amravati',
        TEST.outsiderContactMobile,
      ],
    );
    TEST.outsiderInstitutionId = inst.rows[0].id;
    await c.query(
      `INSERT INTO platform_users
         (role, username, mobile, password_hash, password_set_at,
          totp_secret, totp_enabled, institution_id, is_institution_admin)
       VALUES ('hospital', $1, $2, $3, NOW(), $4, TRUE, $5, TRUE)`,
      [
        TEST.outsiderAdminUsername,
        TEST.outsiderAdminMobile,
        await bcrypt.hash(TEST.outsiderAdminPwd, 10),
        encryption.encrypt(secret),
        TEST.outsiderInstitutionId,
      ],
    );
  } finally {
    c.release();
  }
}

/**
 * Username + password + current TOTP in one call, for accounts whose
 * authenticator a seed enrolled. Returns the bearer token, or null so the
 * caller's assert reports the failure rather than this throwing.
 */
async function staffToken(username, password, secret) {
  const r = await fetchJson('POST', '/auth/institutional/login', {
    body: { username, password, totp_code: await totp.currentCode(secret) },
  });
  return r.status === 200 ? r.body.token || null : null;
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
  await seedSuperAdmin();
  await seedOutsiderInstitution();

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
    // The regression guard for the bug this batch fixes: the setup URLs used to
    // be echoed only when NODE_ENV=development, and only SHA-256(token) is
    // stored — so in production a failed WhatsApp send left the link
    // unrecoverable. Asserted at the source level rather than by flipping
    // NODE_ENV for the run, because env.js snapshots process.env at require
    // time and 'development' is load-bearing elsewhere in this very test (it is
    // what makes /auth/otp/send echo the donor OTP, and what keeps the cron
    // scheduler from registering a parallel tick).
    assert(
      !readSource('backend/src/routes/onboarding.js').includes('nodeEnv'),
      'the onboarding router gates nothing on NODE_ENV',
    );
    assert(!!r.body.ho_admin_setup_url, 'HO admin setup URL returned regardless of NODE_ENV');
    assert(!!r.body.bb_admin_setup_url, 'paired BB admin setup URL returned regardless of NODE_ENV');
    assert(!!r.body.ho_setup_expires_at, 'HO setup expiry returned so the admin can see the deadline');
    assert(
      typeof r.body.whatsapp_sent === 'boolean',
      'activate reports whether the WhatsApp actually sent',
    );
    assert(
      typeof r.body.next_step === 'string' && r.body.next_step.length > 0,
      'activate returns operator guidance for the delivery outcome',
    );
    TEST.hoAdminUsername = r.body.ho_admin_username;
    TEST.hoSetupToken = String(r.body.ho_admin_setup_url).split('/setup/')[1];
    const bbSetupToken = String(r.body.bb_admin_setup_url).split('/setup/')[1];
    const bbAdminUsername = r.body.bb_admin_username;

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
    TEST.hoAdminToken = r.body.token; // full-privilege token (TOTP satisfied)

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

    console.log('── 16. Institution staff-user management ────────────────────');
    // The whole point of this section: an institution must be able to see and
    // repair its own logins, and an undelivered setup link must be recoverable.

    // 16a. Roster — NGO admin can finally SEE who exists.
    r = await fetchJson('GET', `/institutions/${TEST.institutionId}/users`, { headers: auth });
    assert(r.status === 200 && Array.isArray(r.body.users), `roster → 200 (got ${r.status})`);
    const hoRow = (r.body.users || []).find((u) => u.username === TEST.hoAdminUsername);
    assert(!!hoRow, `roster lists ${TEST.hoAdminUsername}`);
    assert(
      hoRow && hoRow.is_institution_admin === true,
      'HO admin backfilled as institution admin',
    );
    assert(
      hoRow && hoRow.credential_state === 'active',
      `HO admin state is active after signing in (got ${hoRow && hoRow.credential_state})`,
    );
    // The roster is a directory, not a credential store.
    assert(
      hoRow &&
        !('password_hash' in hoRow) &&
        !('setup_token_hash' in hoRow) &&
        !('mobile' in hoRow),
      'roster never exposes password_hash, setup_token_hash or a full mobile',
    );
    assert(
      hoRow && typeof hoRow.mobile_masked === 'string' && hoRow.mobile_masked.includes('•'),
      'roster masks the mobile',
    );
    const hoUserId = hoRow && hoRow.id;

    // 16b. The institution admin invites a colleague.
    const techMobile = `+919${RUN_TAG}004`;
    const hoAuth = { Authorization: `Bearer ${TEST.hoAdminToken}` };
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/users`, {
      headers: hoAuth,
      body: { mobile: techMobile, username_suffix: 'tech' },
    });
    assert(
      r.status === 201 && r.body.status === 'invited',
      `invite → 201 (got ${r.status} ${JSON.stringify(r.body)})`,
    );
    assert(!!r.body.setup_url, 'invite returns the setup URL (the only copy of the token)');
    assert(
      r.body.role === 'hospital',
      `invited staff inherit the institution role (got ${r.body.role})`,
    );
    assert(
      r.body.is_institution_admin === false,
      'invited colleague is not an institution admin by default',
    );
    const techUsername = r.body.username;
    const techUserId = r.body.user_id;
    const techSetupToken = String(r.body.setup_url).split('/setup/')[1];

    // 16c. The invite produces a genuinely usable login.
    r = await fetchJson('POST', `/auth/setup/${techSetupToken}`, {
      body: { password: 'TechPass!2026', confirm_password: 'TechPass!2026' },
    });
    assert(
      r.status === 200 && r.body.status === 'set',
      `invited colleague sets password (got ${r.status})`,
    );
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { username: techUsername, password: 'TechPass!2026' },
    });
    assert(r.status === 200 && r.body.token, `invited colleague can log in (got ${r.status})`);
    const techPendingToken = r.body.token;

    // Enrol TOTP so the technician holds a full-privilege token — a TOTP-pending
    // token can only reach setup-totp/confirm-totp, so without this the 403 in
    // 16d would prove nothing about the invite guard.
    r = await fetchJson('POST', '/auth/institutional/setup-totp', {
      headers: { Authorization: `Bearer ${techPendingToken}` },
    });
    const techSecret = ((r.body.otpauth_url || '').match(/secret=([^&]+)/) || [])[1];
    assert(!!techSecret, 'technician TOTP secret issued');
    r = await fetchJson('POST', '/auth/institutional/confirm-totp', {
      headers: { Authorization: `Bearer ${techPendingToken}` },
      body: { totp_code: await totp.currentCode(techSecret) },
    });
    assert(r.status === 200, 'technician TOTP enabled');
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: {
        username: techUsername,
        password: 'TechPass!2026',
        totp_code: await totp.currentCode(techSecret),
      },
    });
    assert(r.status === 200 && r.body.token, 'technician full login succeeds');
    const techAuth = { Authorization: `Bearer ${r.body.token}` };

    // 16d. A non-admin colleague cannot provision logins.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/users`, {
      headers: techAuth,
      body: { mobile: `+919${RUN_TAG}005`, username_suffix: 'sneak' },
    });
    assert(
      r.status === 403 && r.body.error === 'not_institution_admin',
      `non-admin invite → 403 not_institution_admin (got ${r.status} ${r.body.error})`,
    );
    // ...nor reach into an unrelated institution, even holding a full-privilege
    // admin token of its own. resolveInstitutionAdmin tests the parent link before
    // it tests is_institution_admin, so an outsider comes back 'forbidden' rather
    // than 'not_institution_admin': the refusal is about which institution, not
    // about what rank.
    TEST.outsiderToken = await staffToken(
      TEST.outsiderAdminUsername,
      TEST.outsiderAdminPwd,
      TEST.outsiderAdminTotpSecret,
    );
    assert(!!TEST.outsiderToken, 'unrelated institution admin can sign in');
    const outsiderAuth = { Authorization: `Bearer ${TEST.outsiderToken}` };
    for (const [label, target] of [
      ['the hospital', TEST.institutionId],
      ['its in-house blood bank', TEST.childInstitutionId],
    ]) {
      r = await fetchJson('POST', `/institutions/${target}/users`, {
        headers: outsiderAuth,
        body: { mobile: `+919${RUN_TAG}006`, username_suffix: 'crossinst' },
      });
      assert(
        r.status === 403 && r.body.error === 'forbidden',
        `unrelated admin inviting into ${label} → 403 forbidden (got ${r.status} ${r.body.error})`,
      );
    }

    // 16e. An institution can never be left with no admin.
    r = await fetchJson(
      'POST',
      `/institutions/${TEST.institutionId}/users/${hoUserId}/deactivate`,
      { headers: auth, body: { reason: 'smoke: attempt to strand the institution' } },
    );
    assert(
      r.status === 409 && r.body.error === 'cannot_deactivate_last_institution_admin',
      `deactivating the last admin → 409 (got ${r.status} ${r.body.error})`,
    );

    // 16f. Deactivation actually blocks sign-in — otherwise it is cosmetic.
    r = await fetchJson(
      'POST',
      `/institutions/${TEST.institutionId}/users/${techUserId}/deactivate`,
      { headers: auth, body: { reason: 'smoke: left the hospital' } },
    );
    assert(
      r.status === 200 && r.body.status === 'deactivated',
      `deactivate → 200 (got ${r.status})`,
    );
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: {
        username: techUsername,
        password: 'TechPass!2026',
        totp_code: await totp.currentCode(techSecret),
      },
    });
    assert(
      r.status === 403 && r.body.error === 'account_deactivated',
      `deactivated login → 403 account_deactivated (got ${r.status} ${r.body.error})`,
    );

    // 16g. Recovery: reactivate, then re-issue a link that actually works —
    // this is the two-click fix for the hospital that never got its credentials.
    r = await fetchJson(
      'POST',
      `/institutions/${TEST.institutionId}/users/${techUserId}/reactivate`,
      { headers: auth },
    );
    assert(
      r.status === 200 && r.body.status === 'reactivated',
      `reactivate → 200 (got ${r.status})`,
    );
    r = await fetchJson(
      'POST',
      `/institutions/${TEST.institutionId}/users/${techUserId}/reissue-setup`,
      { headers: auth },
    );
    assert(!!r.body.setup_url, `re-issue returns a setup URL (got ${r.status})`);
    const reissuedToken = String(r.body.setup_url).split('/setup/')[1];
    assert(reissuedToken !== techSetupToken, 're-issued token is a new token');
    r = await fetchJson('GET', `/auth/setup/${reissuedToken}`);
    assert(
      r.status === 200 && r.body.username === techUsername,
      `re-issued token resolves to ${techUsername} (got ${r.status} ${r.body.username})`,
    );
    // Re-issuing must invalidate whatever went missing.
    r = await fetchJson('GET', `/auth/setup/${techSetupToken}`);
    assert(r.status >= 400, `the superseded token no longer resolves (got ${r.status})`);

    // 16h. Cross-institution directory — the screen that surfaces stuck accounts.
    r = await fetchJson('GET', `/admin/institution-users?institution_id=${TEST.institutionId}`, {
      headers: auth,
    });
    assert(
      r.status === 200 && Array.isArray(r.body.users),
      `admin directory → 200 (got ${r.status})`,
    );
    assert(
      (r.body.users || []).some(
        (u) => u.username === techUsername && u.credential_state === 'setup_pending',
      ),
      'admin directory reports the re-issued account as setup_pending',
    );
    assert(
      r.body.state_counts && typeof r.body.state_counts.setup_expired === 'number',
      'admin directory returns state counts for the attention banner',
    );
    r = await fetchJson('GET', '/admin/institution-users?state=setup_pending&limit=200', {
      headers: auth,
    });
    assert(
      r.status === 200 && (r.body.users || []).every((u) => u.credential_state === 'setup_pending'),
      'admin directory state filter returns only that state',
    );

    console.log('── 17. In-house blood bank: authority runs downward ────────');
    // The founder's rule for a paired hospital + in-house blood bank: the
    // hospital administers both, and the blood bank never reaches back up. Both
    // halves are asserted, because widening resolveInstitutionAdmin in one
    // direction reads as correct until somebody checks the other.

    // 17a. The hospital's admin provisions a login inside its in-house BB, and
    // the role is minted from the CHILD's kind rather than the inviter's.
    r = await fetchJson('POST', `/institutions/${TEST.childInstitutionId}/users`, {
      headers: hoAuth,
      body: { mobile: `+919${RUN_TAG}010`, username_suffix: 'lab' },
    });
    assert(
      r.status === 201 && r.body.institution_id === TEST.childInstitutionId,
      `HO admin inviting into its in-house BB → 201 (got ${r.status} ${r.body.error || ''})`,
    );
    assert(
      r.body.role === 'blood_bank',
      `the invited login is minted blood_bank from the child's kind (got ${r.body.role})`,
    );

    // 17b. The BB admin's own credentials, so the refusal below is a real token
    // being turned away rather than an absent one. Same password → TOTP → re-login
    // dance as step 10.
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { username: bbAdminUsername, password: 'BloodBankPass2026' },
    });
    assert(
      r.status === 200 && r.body.token && r.body.totp_setup_required === true,
      `BB admin first sign-in → 200 + enrolment pending (got ${r.status} ${r.body.error || ''})`,
    );
    const bbPendingToken = r.body.token;
    r = await fetchJson('POST', '/auth/institutional/setup-totp', {
      headers: { Authorization: `Bearer ${bbPendingToken}` },
    });
    const bbSecret = ((r.body.otpauth_url || '').match(/secret=([^&]+)/) || [])[1];
    assert(!!bbSecret, 'BB admin is issued an otpauth secret');
    r = await fetchJson('POST', '/auth/institutional/confirm-totp', {
      headers: { Authorization: `Bearer ${bbPendingToken}` },
      body: { totp_code: await totp.currentCode(bbSecret) },
    });
    assert(
      r.status === 200 && r.body.status === 'totp_enabled',
      `BB admin enrols its authenticator (got ${r.status} ${r.body.error || ''})`,
    );
    const bbToken = await staffToken(bbAdminUsername, 'BloodBankPass2026', bbSecret);
    assert(!!bbToken, 'BB admin signs in with username + password + code');

    // 17c. ...and gets nowhere near the parent hospital's roster.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/users`, {
      headers: { Authorization: `Bearer ${bbToken}` },
      body: { mobile: `+919${RUN_TAG}011`, username_suffix: 'upward' },
    });
    assert(
      r.status === 403 && r.body.error === 'forbidden',
      `BB admin inviting into its parent hospital → 403 forbidden (got ${r.status} ${r.body.error})`,
    );

    console.log('── 18. Institution details: reason-gated edits ─────────────');
    // Editing an institution is why this surface exists at all - a renewed CDSCO
    // licence had nowhere to be recorded, so the register quietly went stale. The
    // tier split is what keeps it usable: a wrong phone number is a correction, a
    // licence expiry is a legal fact somebody has to answer for later, so only the
    // second demands a sentence.

    const newExpiry = new Date(Date.now() + 730 * 86400000).toISOString().slice(0, 10);
    const licenceReason =
      'CDSCO licence renewed; certificate received by email from the hospital administrator';

    // 18a. A critical field with no justification is refused, and the refusal
    // names which fields demanded one so the form can say why.
    r = await fetchJson('PUT', `/institutions/${TEST.institutionId}`, {
      headers: auth,
      body: { cdsco_licence_expires: newExpiry },
    });
    assert(
      r.status === 400 && r.body.error === 'reason_required',
      `licence expiry with no reason → 400 reason_required (got ${r.status} ${r.body.error})`,
    );
    assert(
      Array.isArray(r.body.critical_fields) &&
        r.body.critical_fields.includes('cdsco_licence_expires'),
      'the refusal names the critical field that demanded a reason',
    );

    // 18b. "typo" is not a justification.
    r = await fetchJson('PUT', `/institutions/${TEST.institutionId}`, {
      headers: auth,
      body: { cdsco_licence_expires: newExpiry, reason: 'typo' },
    });
    assert(
      r.status === 400 && r.body.error === 'reason_too_short',
      `a four-character reason → 400 reason_too_short (got ${r.status} ${r.body.error})`,
    );

    // 18c. With a real one it goes through.
    r = await fetchJson('PUT', `/institutions/${TEST.institutionId}`, {
      headers: auth,
      body: { cdsco_licence_expires: newExpiry, reason: licenceReason },
    });
    assert(
      r.status === 200 && r.body.status === 'updated',
      `licence renewal with a reason → 200 (got ${r.status} ${r.body.error || ''})`,
    );
    assert(
      (r.body.fields_updated || []).includes('cdsco_licence_expires') &&
        r.body.reason_recorded === true,
      'the response confirms the field written and that a reason was recorded',
    );

    // 18d. The operator's words land on the audit row for that field.
    // fn_audit_generic writes one row per changed column, so the sentence sits
    // against the licence expiry specifically rather than against "the row".
    const licenceAudit = await dbRow(
      `SELECT change_reason, new_value, actor_role
         FROM audit_log
        WHERE table_name = 'institutions'
          AND record_id = $1
          AND field_name = 'cdsco_licence_expires'
        ORDER BY event_time DESC, id DESC
        LIMIT 1`,
      [TEST.institutionId],
    );
    assert(!!licenceAudit, 'the licence change produced an audit row for that field');
    assert(
      licenceAudit && licenceAudit.change_reason === `update institution: ${licenceReason}`,
      'the audit row carries the operator reason verbatim',
    );
    assert(
      licenceAudit && licenceAudit.new_value === newExpiry,
      `the audit row records the new expiry as a plain date (got ${
        licenceAudit && licenceAudit.new_value
      })`,
    );
    assert(
      licenceAudit && licenceAudit.actor_role === 'ngo_admin',
      `the audit row attributes it to the operator's role (got ${
        licenceAudit && licenceAudit.actor_role
      })`,
    );

    // 18e. A routine correction needs no ceremony - demanding a paragraph for a
    // mistyped phone number is how a reason field turns into "asdf".
    r = await fetchJson('PUT', `/institutions/${TEST.institutionId}`, {
      headers: auth,
      body: { primary_contact_mobile: `+919${RUN_TAG}111` },
    });
    assert(
      r.status === 200 && r.body.reason_recorded === false,
      `a phone-number correction saves with no reason (got ${r.status} ${r.body.error || ''})`,
    );

    // 18f. A back-dated expiry is the licence_not_expired CHECK, translated into
    // something the operator can act on instead of a constraint name.
    r = await fetchJson('PUT', `/institutions/${TEST.institutionId}`, {
      headers: auth,
      body: {
        cdsco_licence_expires: '2019-01-01',
        reason: 'back-dating the expiry to before this record existed',
      },
    });
    assert(
      r.status === 409 && r.body.error === 'licence_expiry_before_institution_created',
      `a lapsed expiry → 409, not a raw 23514 (got ${r.status} ${r.body.error})`,
    );

    // 18g. Nothing to do is said plainly rather than run as an empty UPDATE.
    r = await fetchJson('PUT', `/institutions/${TEST.institutionId}`, {
      headers: auth,
      body: {},
    });
    assert(
      r.status === 400 && r.body.error === 'no_fields_to_update',
      `an empty body → 400 no_fields_to_update (got ${r.status} ${r.body.error})`,
    );

    // 18h. A blood bank may not be stripped of the licence it operates under.
    r = await fetchJson('PUT', `/institutions/${TEST.childInstitutionId}`, {
      headers: auth,
      body: {
        cdsco_licence_number: null,
        reason: 'attempting to clear the in-house blood bank licence number',
      },
    });
    assert(
      r.status === 409 && r.body.error === 'blood_bank_requires_licence',
      `clearing a BB licence number → 409 blood_bank_requires_licence (got ${r.status} ${r.body.error})`,
    );

    // 18i. The per-institution history is what an inspection actually reads.
    r = await fetchJson('GET', `/institutions/${TEST.institutionId}/audit`, { headers: auth });
    assert(
      r.status === 200 && Array.isArray(r.body.events),
      `institution history → 200 (got ${r.status} ${r.body.error || ''})`,
    );
    const licenceEvent = (r.body.events || []).find(
      (e) => e.field_name === 'cdsco_licence_expires',
    );
    assert(
      licenceEvent && licenceEvent.change_reason === `update institution: ${licenceReason}`,
      'the history surfaces the licence change with its reason',
    );
    assert(
      licenceEvent && licenceEvent.actor_username === TEST.ngoAdminUsername,
      `the history names who did it (got ${licenceEvent && licenceEvent.actor_username})`,
    );

    console.log('── 19. Reversible lifecycle: suspend / archive ─────────────');
    // Suspend used to be a one-way door and 'AR' was unreachable. What this
    // section pins down is that every step back out exists, that retiring an
    // institution sits one rank above pausing one, and that an institution with
    // somebody waiting on blood cannot be retired out from under them.

    // 19a. Suspend closes the door on sign-in...
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/suspend`, {
      headers: auth,
      body: { reason: 'suspected licence lapse pending district inspection' },
    });
    assert(
      r.status === 200 && r.body.status === 'suspended',
      `suspend → 200 (got ${r.status} ${r.body.error || ''})`,
    );
    // Deliberately NOT the child: a hospital pausing does not close its blood
    // bank, which may still be supplying every other hospital in the district.
    let childStatus = await dbRow(`SELECT onboarding_status FROM institutions WHERE id = $1`, [
      TEST.childInstitutionId,
    ]);
    assert(
      childStatus && childStatus.onboarding_status === 'AC',
      `suspending the hospital leaves its blood bank active (got ${
        childStatus && childStatus.onboarding_status
      })`,
    );
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { username: TEST.hoAdminUsername, password: TEST.hoAdminPwd },
    });
    assert(
      r.status === 403 && r.body.error === 'institution_not_active',
      `a suspended institution's admin cannot sign in (got ${r.status} ${r.body.error})`,
    );

    // 19b. ...and lifting it opens the door again. The account itself was never
    // touched, so the next thing refused is the authenticator, not the
    // institution - which is how we know suspend gated the org, not the login.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/unsuspend`, {
      headers: auth,
      body: { reason: 'district inspection cleared; licence confirmed current' },
    });
    assert(
      r.status === 200 && r.body.status === 'active',
      `unsuspend → 200 active (got ${r.status} ${r.body.error || ''})`,
    );
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { username: TEST.hoAdminUsername, password: TEST.hoAdminPwd },
    });
    assert(
      r.status === 401 && r.body.error === 'totp_required',
      `after un-suspending, sign-in is back to asking for the code (got ${r.status} ${r.body.error})`,
    );

    // 19c. Archive is one rank up: an ngo_admin may pause an institution,
    // retiring one is a super_admin act.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/archive`, {
      headers: auth,
      body: { reason: 'closing this hospital permanently at the trust board request' },
    });
    assert(
      r.status === 403,
      `ngo_admin archiving an institution → 403 (got ${r.status} ${r.body.error})`,
    );

    TEST.superAdminToken = await staffToken(
      TEST.superAdminUsername,
      TEST.superAdminPwd,
      TEST.superAdminTotpSecret,
    );
    assert(!!TEST.superAdminToken, 'super_admin can sign in');
    const superAuth = { Authorization: `Bearer ${TEST.superAdminToken}` };

    // 19d. Live work blocks it. This is the assertion that matters clinically:
    // an open request means somebody is waiting on blood, and the archive has to
    // refuse rather than orphan them behind an inactive institution.
    const ref = await dbRow(
      `SELECT (SELECT id FROM blood_groups ORDER BY id LIMIT 1) AS bg,
              (SELECT id FROM blood_components ORDER BY id LIMIT 1) AS comp`,
      [],
    );
    const openReq = await dbRow(
      `INSERT INTO blood_requests
         (source_tier, requesting_institution_id, requesting_user_id,
          patient_initials, patient_age, patient_gender, patient_blood_group_id,
          component_id, units_required, urgency_tier, needed_by,
          requesting_hospital_district_id)
       VALUES ('OH', $1, $2, 'P.S.', 42, 'M', $3, $4, 1, 'UR',
               NOW() + INTERVAL '12 hours', $5)
       RETURNING id`,
      [TEST.institutionId, hoUserId, ref.bg, ref.comp, TEST.district_id],
    );
    assert(!!openReq, 'seeded an open blood request against the hospital');
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/archive`, {
      headers: superAuth,
      body: { reason: 'closing this hospital permanently at the trust board request' },
    });
    assert(
      r.status === 409 && r.body.error === 'institution_has_live_work' && r.body.open_requests >= 1,
      `archiving over an open request → 409 institution_has_live_work (got ${r.status} ${r.body.error})`,
    );

    // Close the request and it proceeds, taking the in-house blood bank with it:
    // the pair was activated together and retires together.
    await dbRow(`UPDATE blood_requests SET status = 'CA' WHERE id = $1 RETURNING id`, [openReq.id]);
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/archive`, {
      headers: superAuth,
      body: {
        reason: 'trust board resolution 2026-08: hospital closed, patients transferred to district',
      },
    });
    assert(
      r.status === 200 && r.body.status === 'archived',
      `archive with the queue clear → 200 (got ${r.status} ${r.body.error || ''})`,
    );
    assert(
      Array.isArray(r.body.cascaded_to_children) && r.body.cascaded_to_children.length >= 1,
      'the response names the in-house blood bank the archive took with it',
    );
    childStatus = await dbRow(`SELECT onboarding_status FROM institutions WHERE id = $1`, [
      TEST.childInstitutionId,
    ]);
    assert(
      childStatus && childStatus.onboarding_status === 'AR',
      `the in-house blood bank archived with its hospital (got ${
        childStatus && childStatus.onboarding_status
      })`,
    );

    // 19e. Doing it twice is said out loud rather than silently swallowed.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/archive`, {
      headers: superAuth,
      body: { reason: 'attempting to archive an institution that is already archived' },
    });
    assert(
      r.status === 409 && r.body.error === 'already_archived',
      `re-archiving → 409 already_archived (got ${r.status} ${r.body.error})`,
    );

    // 19f. Coming back is deliberate. Un-archive returns the family to SUSPENDED
    // rather than straight to live, so somebody has to re-check the licence
    // before the hospital can raise a request again.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/unarchive`, {
      headers: superAuth,
      body: { reason: 'archived in error; the board resolution applied to a different unit' },
    });
    assert(
      r.status === 200 && r.body.status === 'suspended' && Array.isArray(r.body.restored),
      `un-archive → 200 suspended (got ${r.status} ${r.body.error || ''})`,
    );
    childStatus = await dbRow(`SELECT onboarding_status FROM institutions WHERE id = $1`, [
      TEST.childInstitutionId,
    ]);
    assert(
      childStatus && childStatus.onboarding_status === 'SU',
      `un-archive brings the blood bank back suspended, not live (got ${
        childStatus && childStatus.onboarding_status
      })`,
    );

    // 19g. The last step back to live is the ordinary un-suspend - un-archiving
    // is the privileged act, re-opening a suspended institution is not. It stays
    // per-institution, so the blood bank is still suspended afterwards and has to
    // be lifted on its own.
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/unsuspend`, {
      headers: auth,
      body: { reason: 'licence re-verified after the erroneous archive was reversed' },
    });
    assert(
      r.status === 200 && r.body.status === 'active',
      `un-suspend after un-archive → 200 active (got ${r.status} ${r.body.error || ''})`,
    );
    childStatus = await dbRow(`SELECT onboarding_status FROM institutions WHERE id = $1`, [
      TEST.childInstitutionId,
    ]);
    assert(
      childStatus && childStatus.onboarding_status === 'SU',
      `lifting the hospital does not silently re-open its blood bank (got ${
        childStatus && childStatus.onboarding_status
      })`,
    );
    r = await fetchJson('POST', `/institutions/${TEST.institutionId}/unsuspend`, {
      headers: auth,
      body: { reason: 'lifting a suspension that is no longer there' },
    });
    assert(
      r.status === 409 && r.body.error === 'not_found_or_not_suspended',
      `un-suspending an active institution → 409 (got ${r.status} ${r.body.error})`,
    );
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
