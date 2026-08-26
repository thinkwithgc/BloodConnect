#!/usr/bin/env node
/**
 * Phase 6 smoke test — lookback API, webhooks, scheduler.
 *
 *   1.  Bootstrap: a donor with a verified+reactive screening so the
 *       fn_lookback_fire_on_clearance trigger creates a lookback row.
 *   2.  GET /lookback as ngo_admin returns the open case.
 *   3.  POST /lookback/:id/contact-hospital records contact.
 *   4.  Try to close HIV case without DHO notify → 422.
 *   5.  POST /lookback/:id/dho-notify, then close → 200.
 *   6.  POST /webhooks/msg91/delivery flips a notification_log row to DL.
 *   7.  POST /webhooks/whatsapp/incoming with REGISTER from an unknown
 *       mobile drives the bot state machine to NAME.
 *   8.  POST /admin/jobs/run super_admin triggers stale_reservation_release
 *       and planned_request_upgrade and they return ok=true.
 *   9.  POST /admin/jobs/run with bot_session_cleanup wipes expired sessions.
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
  donorMobile: `+919${RUN_TAG}001`,
  bbStaff1Email: `p6-bb1-${RUN_TAG}@example.com`,
  bbStaff2Email: `p6-bb2-${RUN_TAG}@example.com`,
  bbStaffPwd: 'Phase6BB!',
  ngoEmail: `p6-ngo-${RUN_TAG}@example.com`,
  superEmail: `p6-su-${RUN_TAG}@example.com`,
  ngoPwd: 'Phase6NGO!',
  superPwd: 'Phase6SU!',
  bbInst: null,
  donorId: null,
  donor1Token: null,
  bb1Token: null,
  bb2Token: null,
  ngoToken: null,
  superToken: null,
  bb1Totp: null,
  bb2Totp: null,
  donationId: null,
  lookbackId: null,
  notificationId: null,
};

let pass = 0,
  fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
}

const app = createApp();
const PORT = 7010 + ((parseInt(RUN_TAG, 10) || 0) % 1000);
let server;

function fetchJson(method, urlPath, opts = {}) {
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

async function loginInst(email, pwd, secret) {
  const code = secret ? await totp.currentCode(secret) : undefined;
  const r = await fetchJson('POST', '/auth/institutional/login', {
    body: { email, password: pwd, totp_code: code },
  });
  return r.body.token;
}

async function donorOtpLogin(mobile) {
  let r = await fetchJson('POST', '/auth/otp/send', { body: { mobile } });
  r = await fetchJson('POST', '/auth/otp/verify', { body: { mobile, otp: r.body.dev_otp } });
  return r.body.token;
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
    const bb = await c.query(
      `INSERT INTO institutions (kind, shortname, legal_name, display_name, state_id, district_id,
                                 address_line, pincode, primary_contact_name, primary_contact_mobile,
                                 cdsco_licence_number, cdsco_licence_expires, onboarding_status)
       VALUES ('BB', $1, 'P6 BB', 'P6 BB', $2, $3, '12 Rd', '444601', 'C', '+919999000666',
               'CDSCO-P6', (CURRENT_DATE+INTERVAL '1 year')::date, 'AC')
       RETURNING id`,
      [`p6bb${RUN_TAG}`, TEST.state_id, TEST.district_id],
    );
    TEST.bbInst = bb.rows[0].id;

    for (const [emailKey, secretKey] of [
      ['bbStaff1Email', 'bb1Totp'],
      ['bbStaff2Email', 'bb2Totp'],
    ]) {
      const secret = totp.newSecret();
      await c.query(
        `INSERT INTO platform_users (role, email, password_hash, password_set_at, institution_id,
                                     totp_secret, totp_enabled)
         VALUES ('blood_bank', $1, $2, NOW(), $3, $4, TRUE)`,
        [TEST[emailKey], await bcrypt.hash(TEST.bbStaffPwd, 10), TEST.bbInst, encryption.encrypt(secret)],
      );
      TEST[secretKey] = secret;
    }
    await c.query(
      `INSERT INTO platform_users (role, email, password_hash, password_set_at)
       VALUES ('ngo_admin', $1, $2, NOW())`,
      [TEST.ngoEmail, await bcrypt.hash(TEST.ngoPwd, 10)],
    );
    await c.query(
      `INSERT INTO platform_users (role, email, password_hash, password_set_at)
       VALUES ('super_admin', $1, $2, NOW())`,
      [TEST.superEmail, await bcrypt.hash(TEST.superPwd, 10)],
    );
  } finally {
    c.release();
  }
}

async function setupReactiveCase() {
  // Register donor 1, OTP-verify, blood-group-verify, record donation,
  // record reactive screening, four-eyes verify → lookback row created.
  await fetchJson('POST', '/donors/register', {
    body: {
      mobile: TEST.donorMobile,
      full_name: 'P6 Donor',
      date_of_birth: '1985-04-10',
      gender: 'M',
      registration_source: 'WEB',
    },
  });
  TEST.donor1Token = await donorOtpLogin(TEST.donorMobile);

  const c = await db.pool.connect();
  try {
    const r = await c.query(`SELECT id FROM donors WHERE mobile = $1`, [TEST.donorMobile]);
    TEST.donorId = r.rows[0].id;
  } finally {
    c.release();
  }

  await fetchJson('POST', `/donors/${TEST.donorId}/consent`, {
    headers: { Authorization: `Bearer ${TEST.donor1Token}` },
    body: { consent_data_use: true },
  });
  await fetchJson('POST', `/donors/${TEST.donorId}/blood-group/verify`, {
    headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    body: { blood_group_id: 7 },
  });
  let r = await fetchJson('POST', '/donations', {
    headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    body: {
      donor_id: TEST.donorId,
      collection_date: new Date().toISOString().slice(0, 10),
      component_id: 2,
      volume_ml: 280,
      hb_gdl: 14.0,
      hb_method: 'CS',
      isbt_barcode: `P6-${RUN_TAG}-1`,
    },
  });
  TEST.donationId = r.body.donation_id;

  await fetchJson('POST', `/donations/${TEST.donationId}/screening`, {
    headers: { Authorization: `Bearer ${TEST.bb1Token}`, 'X-Access-Reason': 'P6 reactive' },
    body: { hiv_status: 'RR', hbsag_status: 'NR', hcv_status: 'NR',
            syphilis_status: 'NR', malaria_status: 'NR' },
  });
  // Four-eyes: bb2 verifies, fires lookback.
  await fetchJson('POST', `/donations/${TEST.donationId}/screening/verify`, {
    headers: { Authorization: `Bearer ${TEST.bb2Token}`, 'X-Access-Reason': 'P6 4-eyes' },
  });
}

async function main() {
  await bootstrap();
  await new Promise((r) => (server = app.listen(PORT, '127.0.0.1', r)));
  console.log(`── Phase 6 smoke (port ${PORT}, tag ${RUN_TAG}) ─────────────────`);

  try {
    TEST.bb1Token = await loginInst(TEST.bbStaff1Email, TEST.bbStaffPwd, TEST.bb1Totp);
    TEST.bb2Token = await loginInst(TEST.bbStaff2Email, TEST.bbStaffPwd, TEST.bb2Totp);
    TEST.ngoToken = await loginInst(TEST.ngoEmail, TEST.ngoPwd, null);
    TEST.superToken = await loginInst(TEST.superEmail, TEST.superPwd, null);
    assert(TEST.bb1Token && TEST.bb2Token && TEST.ngoToken && TEST.superToken, 'all logins succeeded');

    await setupReactiveCase();
    assert(!!TEST.donorId && !!TEST.donationId, 'reactive case set up');

    console.log('── 1. GET /lookback returns the open case ─────────────────');
    let r = await fetchJson('GET', '/lookback', {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
    });
    assert(r.status === 200 && r.body.lookback_cases.length >= 1,
      `lookback list returned (count=${r.body.lookback_cases?.length})`);
    const ourCase = r.body.lookback_cases.find((c) => c.donor_id === TEST.donorId);
    assert(!!ourCase, `our lookback case present (id=${ourCase?.id?.slice(0, 8)})`);
    TEST.lookbackId = ourCase?.id;
    assert(ourCase?.tti_trigger?.includes('HIV'), 'tti_trigger contains HIV');

    console.log('── 2. POST /lookback/:id/contact-hospital ──────────────────');
    r = await fetchJson('POST', `/lookback/${TEST.lookbackId}/contact-hospital`, {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
      body: { response_summary: 'reached on phone, awaiting recipient list', recipient_verified: false },
    });
    assert(r.status === 200 && r.body.lookback_status === 'CN', `status=CN after contact (got ${r.body.lookback_status})`);

    console.log('── 3. Close without DHO notify (HIV) → 422 ─────────────────');
    r = await fetchJson('POST', `/lookback/${TEST.lookbackId}/close`, {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
      body: { outcome_notes: 'attempted to close without DHO notify' },
    });
    assert(r.status === 422 && r.body.error === 'dho_notification_required_before_close',
      `HIV close blocked w/o DHO notify (got ${r.status} ${r.body.error})`);

    console.log('── 4. DHO notify + close → 200 ─────────────────────────────');
    r = await fetchJson('POST', `/lookback/${TEST.lookbackId}/dho-notify`, {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
      body: { notification_ref: `DHO-AMRA-${RUN_TAG}` },
    });
    assert(r.status === 200 && r.body.dho_notified === true, `DHO notified (got ${r.status})`);
    r = await fetchJson('POST', `/lookback/${TEST.lookbackId}/close`, {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
      body: { outcome_notes: 'all 1 bag still in QA, recalled. No prior recipients.', final_status: 'CL' },
    });
    assert(r.status === 200 && r.body.lookback_status === 'CL', `closed (got ${r.status} ${r.body.lookback_status})`);

    console.log('── 5. MSG91 delivery webhook updates notification_log ──────');
    // The OTP send path created at least one notification_log row for the donor.
    const c = await db.pool.connect();
    try {
      const nr = await c.query(
        `SELECT id FROM notification_log
          WHERE recipient_donor_id = (SELECT id FROM donors WHERE mobile = $1)
       ORDER BY id DESC LIMIT 1`,
        [TEST.donorMobile],
      );
      TEST.notificationId = nr.rows[0]?.id;
    } finally {
      c.release();
    }
    if (TEST.notificationId) {
      r = await fetchJson('POST', '/webhooks/msg91/delivery', {
        body: { notification_id: TEST.notificationId, status: 'DL', occurred_at: new Date().toISOString() },
      });
      assert(r.status === 200 && r.body.notification.delivery_status === 'DL', `webhook flipped status to DL (got ${r.status})`);
    } else {
      assert(false, 'no notification_log row found to test webhook');
    }

    console.log('── 6. WhatsApp incoming bot dispatcher ─────────────────────');
    const newMobile = `+919${RUN_TAG}999`;
    r = await fetchJson('POST', '/webhooks/whatsapp/incoming', {
      body: { from_mobile: newMobile, message_text: 'REGISTER' },
    });
    assert(r.status === 200 && r.body.flow === 'donor_registration', `bot dispatched registration flow (got ${r.status} ${r.body.flow})`);
    assert(r.body.state === 'NAME', `state advanced to NAME (got ${r.body.state})`);

    console.log('── 7. POST /admin/jobs (list) ─────────────────────────────');
    r = await fetchJson('GET', '/admin/jobs', {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
    });
    assert(r.status === 200 && Array.isArray(r.body.jobs) && r.body.jobs.length >= 5,
      `jobs list returned ${r.body.jobs?.length} jobs`);

    console.log('── 8. POST /admin/jobs/run super_admin only ────────────────');
    // ngo_admin denied
    r = await fetchJson('POST', '/admin/jobs/run', {
      headers: { Authorization: `Bearer ${TEST.ngoToken}` },
      body: { name: 'auto_expire' },
    });
    assert(r.status === 403, `ngo_admin denied super-admin endpoint (got ${r.status})`);

    // super_admin runs each job
    for (const jobName of [
      'auto_expire',
      'stale_reservation_release',
      'planned_request_upgrade',
      'eligibility_reminder',
      'bot_session_cleanup',
    ]) {
      r = await fetchJson('POST', '/admin/jobs/run', {
        headers: { Authorization: `Bearer ${TEST.superToken}` },
        body: { name: jobName },
      });
      assert(r.status === 200 && r.body.ok === true, `${jobName}: ok (got ${r.status})`);
    }
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
  console.log(`Phase 6 smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
