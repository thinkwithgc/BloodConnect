#!/usr/bin/env node
/**
 * Phase 4 smoke test — donations + TTI screening + inventory.
 *
 *   1.  POST /donations rejects when donor not lab-verified
 *   2.  Verify donor blood group → POST /donations succeeds, bag in QA
 *   3.  POST /donations/:id/screening with all NR → bag flips to AV via trigger
 *   4.  Four-eyes: same user verifies own entry → 403
 *   5.  Different BB user verifies → bag is AV
 *   6.  Reactive HIV → verification_required, bag stays QA → after verify:
 *       donor.deferral_status='P', bag is_recalled=TRUE, lookback_registry row
 *   7.  GET /inventory shows bags scoped to BB
 *   8.  GET /inventory/availability returns district-scoped counts
 *   9.  POST /inventory/:id/recall (manual)
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createRequire } = require('module');
const backendRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
const bcrypt = backendRequire('bcryptjs');
const totp = require('../backend/src/utils/totp');
const encryption = require('../backend/src/services/encryption');
const createApp = require('../backend/src/app');
const db = require('../backend/src/config/db');

const RUN_TAG = Date.now().toString().slice(-6);
const TEST = {
  state_id: 27,
  district_id: 491,
  donor1Mobile: `+919${RUN_TAG}001`,
  donor2Mobile: `+919${RUN_TAG}002`,
  bbStaff1Email: `p4-bb1-${RUN_TAG}@example.com`,
  bbStaff2Email: `p4-bb2-${RUN_TAG}@example.com`,
  bbStaff1User: `p4bb1-${RUN_TAG}`,
  bbStaff2User: `p4bb2-${RUN_TAG}`,
  bbStaffPwd: 'Phase4BB!2026',
  hospitalEmail: `p4-ho-${RUN_TAG}@example.com`,
  hospitalUser: `p4ho-${RUN_TAG}`,
  hospitalPwd: 'Phase4HO!2026',
  bbInst: null,
  hospitalInst: null,
  donor1Id: null,
  donor2Id: null,
  bb1Token: null,
  bb2Token: null,
  hoToken: null,
  donor1Token: null,
  bb1TotpSecret: null,
  bb2TotpSecret: null,
  hoTotpSecret: null,
  donation1Id: null,
  donation2Id: null,
  bag1Id: null,
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
const PORT = 5010 + ((parseInt(RUN_TAG, 10) || 0) % 1000);
let server;

function fetchJson(method, urlPath, opts = {}) {
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

async function bootstrap() {
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

    // BB institution
    const bb = await c.query(
      `INSERT INTO institutions (kind, shortname, legal_name, display_name, state_id, district_id,
                                 address_line, pincode, primary_contact_name, primary_contact_mobile,
                                 cdsco_licence_number, cdsco_licence_expires, onboarding_status)
       VALUES ('BB', $1, 'P4 BB', 'P4 BB', $2, $3, '12 Smoke', '444601', 'C', '+919999000444',
               'CDSCO-P4', (CURRENT_DATE+INTERVAL '1 year')::date, 'AC')
       RETURNING id`,
      [`p4bb${RUN_TAG}`, TEST.state_id, TEST.district_id],
    );
    TEST.bbInst = bb.rows[0].id;

    // Hospital
    const ho = await c.query(
      `INSERT INTO institutions (kind, shortname, legal_name, display_name, state_id, district_id,
                                 address_line, pincode, primary_contact_name, primary_contact_mobile,
                                 onboarding_status)
       VALUES ('HO', $1, 'P4 HO', 'P4 HO', $2, $3, '13 Smoke', '444602', 'C', '+919999000445', 'AC')
       RETURNING id`,
      [`p4ho${RUN_TAG}`, TEST.state_id, TEST.district_id],
    );
    TEST.hospitalInst = ho.rows[0].id;

    // Two BB staff with TOTP enabled
    // Staff auth is username + password + TOTP as of migration 268, and the
    // auth_path_required CHECK requires the username on every staff row.
    for (const [emailKey, userKey, secretKey] of [
      ['bbStaff1Email', 'bbStaff1User', 'bb1TotpSecret'],
      ['bbStaff2Email', 'bbStaff2User', 'bb2TotpSecret'],
    ]) {
      const secret = totp.newSecret();
      await c.query(
        `INSERT INTO platform_users (role, username, email, password_hash, password_set_at,
                                     institution_id, totp_secret, totp_enabled)
         VALUES ('blood_bank', $1, $2, $3, NOW(), $4, $5, TRUE)`,
        [
          TEST[userKey],
          TEST[emailKey],
          await bcrypt.hash(TEST.bbStaffPwd, 10),
          TEST.bbInst,
          encryption.encrypt(secret),
        ],
      );
      TEST[secretKey] = secret;
    }

    // Hospital staff (TOTP-disabled for brevity)
    const hoSecret = totp.newSecret();
    await c.query(
      `INSERT INTO platform_users (role, username, email, password_hash, password_set_at,
                                   institution_id, totp_secret, totp_enabled)
       VALUES ('hospital', $1, $2, $3, NOW(), $4, $5, TRUE)`,
      [
        TEST.hospitalUser,
        TEST.hospitalEmail,
        await bcrypt.hash(TEST.hospitalPwd, 10),
        TEST.hospitalInst,
        encryption.encrypt(hoSecret),
      ],
    );
    TEST.hoTotpSecret = hoSecret;
  } finally {
    c.release();
  }
}

async function loginInstitutional(username, password, totpSecret) {
  const code = totpSecret ? await totp.currentCode(totpSecret) : undefined;
  const r = await fetchJson('POST', '/auth/institutional/login', {
    body: { username, password, totp_code: code },
  });
  return r;
}

async function main() {
  await bootstrap();
  await new Promise((r) => (server = app.listen(PORT, '127.0.0.1', r)));
  console.log(`── Phase 4 smoke (port ${PORT}, tag ${RUN_TAG}) ─────────────────`);

  try {
    // Logins
    let r = await loginInstitutional(TEST.bbStaff1User, TEST.bbStaffPwd, TEST.bb1TotpSecret);
    TEST.bb1Token = r.body.token;
    r = await loginInstitutional(TEST.bbStaff2User, TEST.bbStaffPwd, TEST.bb2TotpSecret);
    TEST.bb2Token = r.body.token;
    r = await loginInstitutional(TEST.hospitalUser, TEST.hospitalPwd, TEST.hoTotpSecret);
    TEST.hoToken = r.body.token;
    assert(TEST.bb1Token && TEST.bb2Token && TEST.hoToken, 'all institutional logins succeeded');

    // Donor 1 — register, OTP verify, blood group verify
    r = await fetchJson('POST', '/donors/register', {
      body: {
        mobile: TEST.donor1Mobile,
        full_name: 'P4 Donor One',
        date_of_birth: '1990-05-15',
        gender: 'M',
        registration_source: 'WEB',
      },
    });
    assert(r.status === 201, 'donor 1 registered');
    TEST.donor1Id = r.body.donor_id;
    r = await fetchJson('POST', '/auth/otp/send', { body: { mobile: TEST.donor1Mobile } });
    const otp1 = r.body.dev_otp;
    r = await fetchJson('POST', '/auth/otp/verify', { body: { mobile: TEST.donor1Mobile, otp: otp1 } });
    TEST.donor1Token = r.body.token;

    console.log('── 1. POST /donations rejected: blood group not verified ──');
    r = await fetchJson('POST', '/donations', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: {
        donor_id: TEST.donor1Id,
        collection_date: new Date().toISOString().slice(0, 10),
        component_id: 2,
        volume_ml: 280,
        hb_gdl: 14.0,
        hb_method: 'CS',
        isbt_barcode: `P4-${RUN_TAG}-1`,
      },
    });
    assert(
      r.status === 422 && r.body.error === 'donor_blood_group_not_lab_verified',
      `donation rejected pre-verify (got ${r.status} ${r.body.error})`,
    );

    console.log('── 2. Verify blood group → donation succeeds ───────────────');
    r = await fetchJson('POST', `/donors/${TEST.donor1Id}/blood-group/verify`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { blood_group_id: 7 },
    });
    assert(r.status === 200, 'blood group verified');

    r = await fetchJson('POST', '/donations', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: {
        donor_id: TEST.donor1Id,
        collection_date: new Date().toISOString().slice(0, 10),
        component_id: 2,
        volume_ml: 280,
        hb_gdl: 14.0,
        hb_method: 'CS',
        isbt_barcode: `P4-${RUN_TAG}-1`,
      },
    });
    assert(r.status === 201 && r.body.donation_id, `donation recorded (got ${r.status})`);
    TEST.donation1Id = r.body.donation_id;
    TEST.bag1Id = r.body.inventory_bag?.id;
    assert(r.body.inventory_bag?.status === 'QA', `bag created in QA (got ${r.body.inventory_bag?.status})`);

    console.log('── 3. Screening all NR → bag flips QA → AV ─────────────────');
    r = await fetchJson('POST', `/donations/${TEST.donation1Id}/screening`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}`, 'X-Access-Reason': 'smoke screening entry' },
      body: {
        hiv_status: 'NR',
        hbsag_status: 'NR',
        hcv_status: 'NR',
        syphilis_status: 'NR',
        malaria_status: 'NR',
      },
    });
    assert(r.status === 201 && r.body.overall_clearance === 'CL', `overall_clearance=CL (got ${r.body.overall_clearance})`);

    r = await fetchJson('GET', `/donations/${TEST.donation1Id}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(r.body.bag_status === 'AV', `bag flipped to AV (got ${r.body.bag_status})`);

    console.log('── 4-5. Reactive HIV: 4-eyes verify ───────────────────────');
    // Donor 2 setup
    r = await fetchJson('POST', '/donors/register', {
      body: {
        mobile: TEST.donor2Mobile,
        full_name: 'P4 Donor Two',
        date_of_birth: '1992-03-22',
        gender: 'F',
        registration_source: 'WEB',
      },
    });
    TEST.donor2Id = r.body.donor_id;
    r = await fetchJson('POST', '/auth/otp/send', { body: { mobile: TEST.donor2Mobile } });
    await fetchJson('POST', '/auth/otp/verify', {
      body: { mobile: TEST.donor2Mobile, otp: r.body.dev_otp },
    });
    await fetchJson('POST', `/donors/${TEST.donor2Id}/blood-group/verify`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { blood_group_id: 7 },
    });

    r = await fetchJson('POST', '/donations', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: {
        donor_id: TEST.donor2Id,
        collection_date: new Date().toISOString().slice(0, 10),
        component_id: 2,
        volume_ml: 280,
        hb_gdl: 13.5,
        hb_method: 'CS',
        isbt_barcode: `P4-${RUN_TAG}-2`,
      },
    });
    TEST.donation2Id = r.body.donation_id;

    r = await fetchJson('POST', `/donations/${TEST.donation2Id}/screening`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}`, 'X-Access-Reason': 'smoke reactive entry' },
      body: {
        hiv_status: 'RR',
        hbsag_status: 'NR',
        hcv_status: 'NR',
        syphilis_status: 'NR',
        malaria_status: 'NR',
      },
    });
    assert(
      r.status === 201 && r.body.verification_required === true && r.body.overall_clearance === 'PE',
      `reactive: verification_required=true, clearance=PE (got vr=${r.body.verification_required}, cl=${r.body.overall_clearance})`,
    );

    // 4-eyes: same user cannot verify own entry
    r = await fetchJson('POST', `/donations/${TEST.donation2Id}/screening/verify`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}`, 'X-Access-Reason': 'smoke verify by entry author' },
    });
    assert(r.status === 403 && r.body.error === 'four_eyes_violation', `4-eyes blocks self-verify (got ${r.status})`);

    // Different user verifies → triggers lookback
    r = await fetchJson('POST', `/donations/${TEST.donation2Id}/screening/verify`, {
      headers: { Authorization: `Bearer ${TEST.bb2Token}`, 'X-Access-Reason': 'smoke 2nd-eye verify' },
    });
    assert(r.status === 200 && r.body.overall_clearance === 'IN', `2nd-eye verify → IN (got ${r.status} ${r.body.overall_clearance})`);

    // Donor 2 should be permanently deferred
    const c = await db.pool.connect();
    try {
      const dr = await c.query(`SELECT deferral_status FROM donors WHERE id = $1`, [TEST.donor2Id]);
      assert(dr.rows[0].deferral_status === 'P', `donor 2 deferral_status=P (got ${dr.rows[0].deferral_status})`);

      const lb = await c.query(`SELECT count(*)::int AS n FROM lookback_registry WHERE donor_id = $1`, [TEST.donor2Id]);
      assert(lb.rows[0].n >= 1, `lookback row created (n=${lb.rows[0].n})`);
    } finally {
      c.release();
    }

    console.log('── 6. GET /inventory ───────────────────────────────────────');
    r = await fetchJson('GET', '/inventory?status=AV', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(r.status === 200 && Array.isArray(r.body.bags), `inventory list returns bags array (got ${r.status})`);

    console.log('── 7. GET /inventory/availability (hospital) ───────────────');
    r = await fetchJson('GET', `/inventory/availability?district_id=${TEST.district_id}`, {
      headers: { Authorization: `Bearer ${TEST.hoToken}` },
    });
    assert(r.status === 200 && Array.isArray(r.body.available), `availability returns counts (got ${r.status})`);
    assert(
      r.body.available.some((row) => row.blood_group === 'O+' && row.available_units >= 1),
      `O+ PRBC count >= 1 in district availability`,
    );

    console.log('── 8. POST /inventory/:id/recall (manual) ──────────────────');
    r = await fetchJson('POST', `/inventory/${TEST.bag1Id}/recall`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { reason: 'smoke test manual recall' },
    });
    assert(r.status === 200 && r.body.is_recalled === true, `manual recall succeeded (got ${r.status})`);
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
  console.log(`Phase 4 smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
