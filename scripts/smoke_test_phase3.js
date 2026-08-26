#!/usr/bin/env node
/**
 * Phase 3 smoke test (scaffold) — exercises the donor registration and
 * health passport routes that landed in Phase 3.
 *
 * What's tested here (working today):
 *   1.  GET  /donors/eligibility/questions returns the DRAFT bank
 *   2.  POST /donors/register (web flow) creates donor + platform_user
 *   3.  Duplicate detection: ABHA collision → 409
 *   4.  Duplicate detection: name+DOB collision → 201 with duplicate_flag
 *   5.  POST /donors/:id/consent (donor self only) grants consent
 *   6.  POST /donors/:id/availability toggles is_available
 *   7.  POST /donors/:id/blood-group/verify by blood_bank role works
 *   8.  GET  /donors/:id/passport returns aggregated profile + donations
 *   9.  POST /donors/merge returns 501 (stubbed pending advisor review)
 *
 * Not tested here (defer to fresh-agent Phase 3 wrap-up):
 *   - WhatsApp bot registration flow (needs MSG91 DLT)
 *   - QR-code camp registration end-to-end
 *   - Donor merge implementation
 *   - Pre-screening soft-decline flow against the signed-off question bank
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createRequire } = require('module');
const backendRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
const bcrypt = backendRequire('bcryptjs');
const totp = require('../backend/src/utils/totp');
const createApp = require('../backend/src/app');
const db = require('../backend/src/config/db');

const RUN_TAG = Date.now().toString().slice(-6);
const TEST = {
  state_id: 27,
  district_id: 491,
  donorMobile1: `+919${RUN_TAG}001`,
  donorMobile2: `+919${RUN_TAG}002`,
  donorMobile3: `+919${RUN_TAG}003`,
  ngoAdminEmail: `p3-ngo-${RUN_TAG}@example.com`,
  ngoAdminPwd: 'Phase3Pwd!2026',
  bbStaffEmail: `p3-bb-${RUN_TAG}@example.com`,
  bbStaffPwd: 'Phase3BB!2026',
  bbInst: null,
  donor1Id: null,
  donor2Id: null,
  donor1Token: null,
  bbToken: null,
  bbTotpSecret: null,
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
const PORT = 4010 + ((parseInt(RUN_TAG, 10) || 0) % 1000);
let server;

function fetchJson(method, urlPath, opts = {}) {
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

async function ensureGeoAndStaff() {
  const c = await db.pool.connect();
  try {
    // The dev DB carries imported LGD geography, so INSERTing a synthetic
    // Amravati collides with uq_district_short_per_state. Take whatever active
    // district exists instead (same approach as smoke_test_phase2).
    const geo = await c.query(
      `SELECT d.id AS district_id, d.state_id
         FROM districts d
         JOIN states s ON s.id = d.state_id
        WHERE d.is_active AND s.is_active
        ORDER BY d.id ASC
        LIMIT 1`,
    );
    if (geo.rowCount === 0) {
      throw new Error('no active district in the DB - run the LGD import or seeds first');
    }
    TEST.district_id = geo.rows[0].district_id;
    TEST.state_id = geo.rows[0].state_id;
    // ngo_admin
    await c.query(
      `INSERT INTO platform_users (role, email, password_hash, password_set_at)
       VALUES ('ngo_admin', $1, $2, NOW())`,
      [TEST.ngoAdminEmail, await bcrypt.hash(TEST.ngoAdminPwd, 10)],
    );
    // institution
    const instR = await c.query(
      `INSERT INTO institutions (
         kind, shortname, legal_name, display_name,
         state_id, district_id, address_line, pincode,
         primary_contact_name, primary_contact_mobile,
         cdsco_licence_number, cdsco_licence_expires, onboarding_status)
       VALUES ('BB', $1, 'P3 Smoke BB', 'P3 BB',
         $2, $3, '12 Smoke Road', '444601',
         'Smoke Contact', '+919999000999',
         'CDSCO-P3', (CURRENT_DATE+INTERVAL '1 year')::date, 'AC')
       RETURNING id`,
      [`p3bb${RUN_TAG}`, TEST.state_id, TEST.district_id],
    );
    TEST.bbInst = instR.rows[0].id;
    // BB staff with TOTP enabled
    const totpSecret = totp.newSecret();
    const encryption = require('../backend/src/services/encryption');
    await c.query(
      `INSERT INTO platform_users (role, email, password_hash, password_set_at,
         institution_id, totp_secret, totp_enabled)
       VALUES ('blood_bank', $1, $2, NOW(), $3, $4, TRUE)`,
      [TEST.bbStaffEmail, await bcrypt.hash(TEST.bbStaffPwd, 10), TEST.bbInst, encryption.encrypt(totpSecret)],
    );
    TEST.bbTotpSecret = totpSecret;
  } finally {
    c.release();
  }
}

async function main() {
  await ensureGeoAndStaff();
  await new Promise((r) => (server = app.listen(PORT, '127.0.0.1', r)));
  console.log(`── Phase 3 smoke (port ${PORT}, tag ${RUN_TAG}) ─────────────────`);

  try {
    console.log('── 1. GET /donors/eligibility/questions ────────────────────');
    let r = await fetchJson('GET', '/donors/eligibility/questions');
    assert(r.status === 200, `eligibility questions returns 200 (got ${r.status})`);
    assert(Array.isArray(r.body.permanent) && r.body.permanent.length === 8, `8 permanent exclusion questions returned`);
    assert(r.body.draft === true, 'questions flagged as DRAFT pending review');

    console.log('── 2. POST /donors/register ────────────────────────────────');
    const dob = '1990-05-15';
    r = await fetchJson('POST', '/donors/register', {
      body: {
        mobile: TEST.donorMobile1,
        full_name: 'Smoke Donor One',
        date_of_birth: dob,
        gender: 'M',
        abha_id: `1${RUN_TAG}${'0'.repeat(10)}`.slice(0, 17),
        aadhaar_last4: '1234',
        preferred_language: 'mr',
        pincode: '444601',
        max_travel_km: 15,
        blood_group_self_reported: 7,
        registration_source: 'WEB',
      },
    });
    assert(r.status === 201 && r.body.donor_id, `register returns donor_id (got ${r.status})`);
    TEST.donor1Id = r.body.donor_id;

    console.log('── 3. ABHA collision → 409 ────────────────────────────────');
    r = await fetchJson('POST', '/donors/register', {
      body: {
        mobile: TEST.donorMobile2,
        full_name: 'Different Person',
        date_of_birth: '1985-01-01',
        gender: 'F',
        abha_id: `1${RUN_TAG}${'0'.repeat(10)}`.slice(0, 17),
        registration_source: 'WEB',
      },
    });
    assert(r.status === 409 && r.body.error === 'abha_collision', `ABHA collision returns 409 (got ${r.status} ${r.body.error})`);

    console.log('── 4. Name + DOB collision → 201 + duplicate_flag ─────────');
    r = await fetchJson('POST', '/donors/register', {
      body: {
        mobile: TEST.donorMobile3,
        full_name: 'Smoke Donor One',     // same as donor 1
        date_of_birth: dob,                // same as donor 1
        gender: 'M',
        registration_source: 'WEB',
      },
    });
    assert(r.status === 201 && r.body.duplicate_flag === 'name_dob_collision', `name+DOB collision flagged (got ${r.status} flag=${r.body.duplicate_flag})`);
    TEST.donor2Id = r.body.donor_id;

    console.log('── 5. Donor login + consent ────────────────────────────────');
    // OTP send + verify for donor 1
    r = await fetchJson('POST', '/auth/otp/send', { body: { mobile: TEST.donorMobile1 } });
    assert(r.status === 200 && r.body.dev_otp, `OTP sent for donor (got ${r.status})`);
    const otp1 = r.body.dev_otp;
    r = await fetchJson('POST', '/auth/otp/verify', { body: { mobile: TEST.donorMobile1, otp: otp1 } });
    assert(r.status === 200 && r.body.token, `OTP verify returns donor token`);
    TEST.donor1Token = r.body.token;

    r = await fetchJson('POST', `/donors/${TEST.donor1Id}/consent`, {
      headers: { Authorization: `Bearer ${TEST.donor1Token}` },
      body: { consent_data_use: true },
    });
    assert(r.status === 200 && r.body.consent_data_use === true, `donor self-grants consent (got ${r.status})`);
    assert(r.body.consent_given_at !== null, 'consent_given_at stamped');

    console.log('── 6. Availability toggle ─────────────────────────────────');
    r = await fetchJson('POST', `/donors/${TEST.donor1Id}/availability`, {
      headers: { Authorization: `Bearer ${TEST.donor1Token}` },
      body: { is_available: false, available_hours_start: 8, available_hours_end: 20 },
    });
    assert(r.status === 200 && r.body.is_available === false, `availability toggled (got ${r.status})`);

    console.log('── 7. Blood-bank verifies blood group ─────────────────────');
    const bbCode = await totp.currentCode(TEST.bbTotpSecret);
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { email: TEST.bbStaffEmail, password: TEST.bbStaffPwd, totp_code: bbCode },
    });
    assert(r.status === 200 && r.body.token, `BB staff login (got ${r.status})`);
    TEST.bbToken = r.body.token;

    r = await fetchJson('POST', `/donors/${TEST.donor1Id}/blood-group/verify`, {
      headers: { Authorization: `Bearer ${TEST.bbToken}` },
      body: { blood_group_id: 7, verification_method: 'forward+reverse type' },
    });
    assert(r.status === 200 && r.body.blood_group_verified === 7, `lab-verified blood group set (got ${r.status})`);

    console.log('── 8. Passport returns verified vs self-reported ───────────');
    r = await fetchJson('GET', `/donors/${TEST.donor1Id}/passport`, {
      headers: { Authorization: `Bearer ${TEST.donor1Token}` },
    });
    assert(r.status === 200, `passport fetched (got ${r.status})`);
    assert(r.body.donor.blood_group.verified?.code === 'O+', `passport shows lab-verified blood group as O+`);
    assert(r.body.donor.blood_group.used_in_matching === 'verified', `used_in_matching=verified`);
    assert(Array.isArray(r.body.donations), 'donations array present');

    console.log('── 9. Merge endpoint stubbed ──────────────────────────────');
    // Need an ngo_admin token first
    r = await fetchJson('POST', '/auth/institutional/login', {
      body: { email: TEST.ngoAdminEmail, password: TEST.ngoAdminPwd },
    });
    const ngoToken = r.body.token;
    r = await fetchJson('POST', '/donors/merge', {
      headers: { Authorization: `Bearer ${ngoToken}` },
      body: { primary_donor_id: TEST.donor1Id, secondary_donor_id: TEST.donor2Id },
    });
    assert(r.status === 501 && r.body.error === 'not_implemented', `merge returns 501 stub (got ${r.status})`);
  } catch (err) {
    console.error('FATAL:', err.message);
    console.error(err.stack);
    fail++;
  } finally {
    await new Promise((r) => server.close(r));
    await db.shutdown();
  }

  console.log('');
  console.log('─'.repeat(58));
  console.log(`Phase 3 smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
