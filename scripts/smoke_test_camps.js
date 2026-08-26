#!/usr/bin/env node
/**
 * Camp module smoke test — derived attendance, RSVP lifecycle, one camp home
 * per person, and camp editing. Migrations 312 / 313 / 314.
 *
 * THE DERIVATION IS THE ASSERTION THAT MATTERS. Nobody ticks a roster any
 * more: 'AT' comes from a donation recorded against the camp (migration 314's
 * trigger on donation_history) and 'NS' from the camp-close-roster job after
 * its 48-hour entry grace. Everything below exists to prove that holds, and
 * that the clinical boundary around it holds too — a roster mark must never
 * reach donors.deferral_until.
 *
 *  1.  logins + fixtures (3 camps, 7 donors, 4 staff)
 *  2.  GET /camps/mine inherits a coordinator-created camp AND an anonymous
 *      /camps/apply, on MOBILE match alone (no auth-cluster bridging)
 *  3.  RSVP gating: closed camp, re-register after AT, cancel → CN not DELETE
 *  4.  donation with donation_camp_id → roster row 'AT' with NO roster call
 *  5.  off-roster donor → row appears with source='WI'
 *  6.  trust_level='S' self-report → NO roster row
 *  7.  TTI-reactive + is_invalidated=TRUE → registration is STILL 'AT'
 *  8.  roster endpoint rejects 'AT'/'NS' with 409 attendance_is_derived
 *  9.  'DF' → deferred_donor_count=1, donors.deferral_until UNCHANGED
 * 10.  camp_close_roster: camp 3 days ago → NS; camp yesterday → untouched
 * 11.  a late donation flips NS back to AT (self-healing)
 * 12.  PATCH /camps/:id — non-owner 403, terminal 409, date move keeps PL,
 *      diff appended to review_notes, one notification per notified donor
 * 13.  a QR signup off the camp poster records QRC + registration_camp_id
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { createRequire } = require('module');
const backendRequire = createRequire(path.resolve(__dirname, '../backend/package.json'));
const bcrypt = backendRequire('bcryptjs');
const totp = require('../backend/src/utils/totp');
const encryption = require('../backend/src/services/encryption');
const { withRlsContextRaw } = require('../backend/src/middleware/rlsContext');
const createApp = require('../backend/src/app');
const db = require('../backend/src/config/db');

const RUN_TAG = Date.now().toString().slice(-6);

// One mobile, two platform_users rows. Migration 282's staff-cluster unique
// index is deliberately scoped so "a coordinator can also be a donor with the
// same mobile" — that shared number is the whole mechanism behind
// GET /camps/mine, so the fixture leans on it rather than working around it.
const HOST_MOBILE = `+919${RUN_TAG}001`;

const TEST = {
  state_id: null,
  district_id: null,
  bbInst: null,
  bbStaffPwd: 'CampSmokeBB!2026',
  staffPwd: 'CampSmokeST!2026',
  bb1User: `cmbb1-${RUN_TAG}`,
  bb2User: `cmbb2-${RUN_TAG}`,
  coordUser: `cmco-${RUN_TAG}`,
  saUser: `cmsa-${RUN_TAG}`,
  bb1Token: null,
  bb2Token: null,
  coordToken: null,
  saToken: null,
  bb1TotpSecret: null,
  bb2TotpSecret: null,
  coordTotpSecret: null,
  saTotpSecret: null,
  coordUserId: null,
  camp1: null, // coordinator-created, dated today, later shifted 3 days back
  camp2: null, // status CO dated yesterday — isolates the 48h grace
  camp3: null, // anonymous /camps/apply carrying the host's mobile
};

// H hosts. A donates on-roster. B donates off-roster. C is deferred at the
// desk. D self-reports. E is the no-show who later turns out to have donated.
// F sits on the yesterday camp and must not be touched. G walks up to the desk.
//
// Everyone who donates carries a verified mobile: validateDonation() rejects an
// unverified donor with donor_mobile_not_verified before it ever looks at the
// camp. Only D (inserted directly) and F (a roster row and nothing else) skip
// the OTP round-trip.
const DONORS = {
  H: { mobile: HOST_MOBILE, name: 'Camp Host', token: null, id: null },
  A: { mobile: `+919${RUN_TAG}002`, name: 'Camp Donor A', token: null, id: null },
  B: { mobile: `+919${RUN_TAG}003`, name: 'Camp Donor B', token: null, id: null },
  C: { mobile: `+919${RUN_TAG}004`, name: 'Camp Donor C', token: null, id: null },
  D: { mobile: `+919${RUN_TAG}005`, name: 'Camp Donor D', token: null, id: null },
  E: { mobile: `+919${RUN_TAG}006`, name: 'Camp Donor E', token: null, id: null },
  F: { mobile: `+919${RUN_TAG}007`, name: 'Camp Donor F', token: null, id: null },
  G: { mobile: `+919${RUN_TAG}008`, name: 'Camp Donor G', token: null, id: null },
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
const PORT = 5310 + ((parseInt(RUN_TAG, 10) || 0) % 600);
let server;

function fetchJson(method, urlPath, opts = {}) {
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}

const DAY_MS = 86400000;
function isoDay(offset = 0) {
  return new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
}

// Direct SQL under the app's own elevated context, so audit triggers get the
// GUCs they expect instead of a bare pool connection.
function sql(text, params, reason = 'camp smoke fixture') {
  return withRlsContextRaw({ actor_role: 'system', change_reason: reason }, (c) =>
    c.query(text, params),
  );
}

async function regStatus(campId, donorId) {
  const r = await sql(
    `SELECT status, source FROM camp_registrations WHERE camp_id = $1 AND donor_id = $2`,
    [campId, donorId],
  );
  return r.rows[0] || null;
}

async function campCounts(campId) {
  const r = await sql(
    `SELECT registered_donor_count, attended_donor_count, deferred_donor_count
       FROM donation_camps WHERE id = $1`,
    [campId],
  );
  return r.rows[0];
}

async function bootstrap() {
  const c = await db.pool.connect();
  try {
    // The dev DB carries imported LGD geography, so INSERTing a synthetic
    // district collides with uq_district_short_per_state. Take whatever active
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
       VALUES ('BB', $1, 'Camp Smoke BB', 'Camp Smoke BB', $2, $3, '9 Camp Road', '444601',
               'C', '+919999000901', 'CDSCO-CMP', (CURRENT_DATE+INTERVAL '1 year')::date, 'AC')
       RETURNING id`,
      [`cmbb${RUN_TAG}`, TEST.state_id, TEST.district_id],
    );
    TEST.bbInst = bb.rows[0].id;

    // Two BB staff: 4-eyes screening verification needs two distinct users.
    // Staff auth is username + password + TOTP as of migration 268, and
    // auth_path_required (migration 282) requires the username on every staff
    // row — including coordinator, which is why none of these are mobile-only.
    for (const [userKey, secretKey] of [
      ['bb1User', 'bb1TotpSecret'],
      ['bb2User', 'bb2TotpSecret'],
    ]) {
      const secret = totp.newSecret();
      await c.query(
        `INSERT INTO platform_users (role, username, email, password_hash, password_set_at,
                                     institution_id, totp_secret, totp_enabled)
         VALUES ('blood_bank', $1, $2, $3, NOW(), $4, $5, TRUE)`,
        [
          TEST[userKey],
          `${TEST[userKey]}@example.com`,
          await bcrypt.hash(TEST.bbStaffPwd, 10),
          TEST.bbInst,
          encryption.encrypt(secret),
        ],
      );
      TEST[secretKey] = secret;
    }

    // super_admin is the only role POST /admin/jobs/run accepts. No institution
    // (staff_requires_institution, migration 273, puts it in the free branch).
    const saSecret = totp.newSecret();
    await c.query(
      `INSERT INTO platform_users (role, username, email, password_hash, password_set_at,
                                   totp_secret, totp_enabled)
       VALUES ('super_admin', $1, $2, $3, NOW(), $4, TRUE)`,
      [
        TEST.saUser,
        `${TEST.saUser}@example.com`,
        await bcrypt.hash(TEST.staffPwd, 10),
        encryption.encrypt(saSecret),
      ],
    );
    TEST.saTotpSecret = saSecret;
  } finally {
    c.release();
  }
}

// Seeded AFTER donor H registers, so nothing in /donors/register has to reason
// about a pre-existing staff row on the same number.
async function seedCoordinatorOnHostMobile() {
  const secret = totp.newSecret();
  const r = await sql(
    `INSERT INTO platform_users (role, username, email, mobile, password_hash, password_set_at,
                                 totp_secret, totp_enabled)
     VALUES ('coordinator', $1, $2, $3, $4, NOW(), $5, TRUE)
     RETURNING id`,
    [
      TEST.coordUser,
      `${TEST.coordUser}@example.com`,
      HOST_MOBILE,
      await bcrypt.hash(TEST.staffPwd, 10),
      encryption.encrypt(secret),
    ],
    'camp smoke: coordinator sharing the host mobile',
  );
  TEST.coordUserId = r.rows[0].id;
  TEST.coordTotpSecret = secret;
}

async function loginInstitutional(username, password, totpSecret) {
  const code = totpSecret ? await totp.currentCode(totpSecret) : undefined;
  return fetchJson('POST', '/auth/institutional/login', {
    body: { username, password, totp_code: code },
  });
}

async function registerDonor(key, withToken) {
  const d = DONORS[key];
  let r = await fetchJson('POST', '/donors/register', {
    body: {
      mobile: d.mobile,
      full_name: d.name,
      date_of_birth: '1991-04-12',
      gender: 'M',
      registration_source: 'WEB',
    },
  });
  if (r.status !== 201) throw new Error(`donor ${key} register failed: ${r.status} ${r.body.error}`);
  d.id = r.body.donor_id;
  if (withToken) {
    r = await fetchJson('POST', '/auth/otp/send', { body: { mobile: d.mobile } });
    r = await fetchJson('POST', '/auth/otp/verify', {
      body: { mobile: d.mobile, otp: r.body.dev_otp },
    });
    d.token = r.body.token;
    if (!d.token) throw new Error(`donor ${key} OTP login failed`);
  }
  return d;
}

function campBody(name, dateIso) {
  return {
    name,
    state_id: TEST.state_id,
    district_id: TEST.district_id,
    venue: 'Community Hall',
    address_line: '14 Station Road, Camp Ward',
    pincode: '444601',
    scheduled_date: dateIso,
    start_time: '09:00',
    end_time: '15:00',
    organiser_type: 'CO',
    organiser_name: 'Camp Smoke Trust',
    organiser_contact_name: 'Camp Host',
    partnered_blood_bank_id: TEST.bbInst,
    target_donor_count: 50,
  };
}

function donationBody(donorId, dateIso, campId, barcodeSuffix) {
  return {
    donor_id: donorId,
    collection_date: dateIso,
    component_id: 2,
    volume_ml: 280,
    hb_gdl: 14.0,
    hb_method: 'CS',
    isbt_barcode: `CMP-${RUN_TAG}-${barcodeSuffix}`,
    donation_camp_id: campId,
  };
}

async function main() {
  await bootstrap();
  await new Promise((r) => (server = app.listen(PORT, '127.0.0.1', r)));
  console.log(`── Camp module smoke (port ${PORT}, tag ${RUN_TAG}) ──────────────`);

  try {
    let r;

    console.log('── 1. Fixtures: staff, donors, camps ───────────────────────');
    r = await loginInstitutional(TEST.bb1User, TEST.bbStaffPwd, TEST.bb1TotpSecret);
    TEST.bb1Token = r.body.token;
    r = await loginInstitutional(TEST.bb2User, TEST.bbStaffPwd, TEST.bb2TotpSecret);
    TEST.bb2Token = r.body.token;
    r = await loginInstitutional(TEST.saUser, TEST.staffPwd, TEST.saTotpSecret);
    TEST.saToken = r.body.token;
    assert(TEST.bb1Token && TEST.bb2Token && TEST.saToken, 'BB + super_admin logins succeeded');

    for (const k of ['H', 'A', 'B', 'C', 'E']) await registerDonor(k, true);
    for (const k of ['D', 'F']) await registerDonor(k, false);
    assert(
      ['H', 'A', 'B', 'C', 'D', 'E', 'F'].every((k) => DONORS[k].id) &&
        ['H', 'A', 'B', 'C', 'E'].every((k) => DONORS[k].token),
      'seven donors registered; five hold OTP sessions',
    );

    await seedCoordinatorOnHostMobile();
    r = await loginInstitutional(TEST.coordUser, TEST.staffPwd, TEST.coordTotpSecret);
    TEST.coordToken = r.body.token;
    assert(
      TEST.coordToken && DONORS.H.token,
      'a coordinator and a donor share one mobile, and BOTH log in',
    );

    // Blood group verification is the gate on POST /donations. C never donates
    // (a donation would write next_eligible_date and destroy the clinical
    // assertion in step 9) and D goes in via direct SQL, so neither needs it.
    for (const k of ['A', 'B', 'E']) {
      r = await fetchJson('POST', `/donors/${DONORS[k].id}/blood-group/verify`, {
        headers: { Authorization: `Bearer ${TEST.bb1Token}` },
        body: { blood_group_id: 7 },
      });
      if (r.status !== 200) throw new Error(`blood group verify ${k} failed: ${r.status}`);
    }

    // camp1 is dated TODAY so the donations land inside resolveCampForCollection's
    // +/-2 day window and RSVP's scheduled_date >= CURRENT_DATE gate passes. It
    // gets shifted back three days in step 10, once that work is done.
    r = await fetchJson('POST', '/camps', {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: campBody(`Camp Smoke One ${RUN_TAG}`, isoDay(0)),
    });
    assert(r.status === 201 && r.body.status === 'PL', `coordinator created camp1 as PL (${r.status})`);
    TEST.camp1 = r.body.id;
    const camp1Slug = r.body.slug;

    r = await fetchJson('POST', '/camps', {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: campBody(`Camp Smoke Two ${RUN_TAG}`, isoDay(0)),
    });
    TEST.camp2 = r.body.id;
    // Completed, held yesterday: satisfies camp-close-roster's evidence guard
    // through the status='CO' branch, so the ONLY thing protecting its roster is
    // the 48-hour grace. That isolates the assertion in step 10.
    await sql(`UPDATE donation_camps SET status = 'CO', scheduled_date = CURRENT_DATE - 1 WHERE id = $1`, [
      TEST.camp2,
    ]);
    assert(Boolean(TEST.camp2), 'camp2 created, then set CO dated yesterday');

    r = await fetchJson('POST', '/camps/apply', {
      body: {
        name: `Camp Smoke Three ${RUN_TAG}`,
        organiser_type: 'CC',
        organiser_name: 'Gram Panchayat',
        state_id: TEST.state_id,
        district_id: TEST.district_id,
        venue: 'Zilla Parishad School',
        address_line: '2 School Lane, Camp Ward',
        scheduled_date: isoDay(21),
        start_time: '10:00',
        end_time: '14:00',
        submitted_by_name: 'Camp Host',
        submitted_by_mobile: HOST_MOBILE,
      },
    });
    assert(
      r.status === 201 && r.body.status === 'PE' && r.body.tracked_in_profile === false,
      `anonymous /camps/apply → PE, tracked_in_profile=false (${r.status})`,
    );
    TEST.camp3 = r.body.camp_id;

    console.log('── 2. GET /camps/mine — one home, keyed on the mobile ──────');
    r = await fetchJson('GET', '/camps/mine', {
      headers: { Authorization: `Bearer ${DONORS.H.token}` },
    });
    assert(r.status === 200 && Array.isArray(r.body.camps), `GET /camps/mine 200 (${r.status})`);
    const mineIds = (r.body.camps || []).map((x) => x.id);
    assert(
      mineIds.includes(TEST.camp1),
      'a COORDINATOR-created camp appears in that person’s DONOR session',
    );
    assert(
      mineIds.includes(TEST.camp3),
      'an ANONYMOUS /camps/apply is inherited on mobile match alone',
    );
    const mineCamp1 = r.body.camps.find((x) => x.id === TEST.camp1);
    assert(mineCamp1?.can_edit === true, 'a PL camp I own reports can_edit=true');

    r = await fetchJson('GET', '/camps/mine', {
      headers: { Authorization: `Bearer ${DONORS.A.token}` },
    });
    assert(
      r.status === 200 && !(r.body.camps || []).some((x) => x.id === TEST.camp1),
      'an unrelated donor sees none of the host’s camps',
    );

    console.log('── 3. RSVP lifecycle ───────────────────────────────────────');
    for (const k of ['A', 'C', 'E']) {
      r = await fetchJson('POST', `/camps/${TEST.camp1}/register`, {
        headers: { Authorization: `Bearer ${DONORS[k].token}` },
        body: { channel: 'web' },
      });
      if (r.status !== 201) throw new Error(`RSVP ${k} failed: ${r.status} ${r.body.error}`);
    }
    assert((await regStatus(TEST.camp1, DONORS.A.id))?.status === 'RG', 'RSVP creates an RG row');

    r = await fetchJson('POST', `/camps/${TEST.camp1}/register`, {
      headers: { Authorization: `Bearer ${DONORS.H.token}` },
      body: { channel: 'web' },
    });
    const hostRsvpOk = r.status === 201;
    r = await fetchJson('DELETE', `/camps/${TEST.camp1}/register`, {
      headers: { Authorization: `Bearer ${DONORS.H.token}` },
    });
    const hostCancelled = await regStatus(TEST.camp1, DONORS.H.id);
    assert(
      hostRsvpOk && r.status === 200 && r.body.cancelled === true && hostCancelled?.status === 'CN',
      'cancelling an RG RSVP sets CN — the row is kept, not deleted',
    );

    // F sits on the CO camp so step 10 has something that must NOT move.
    await sql(
      `INSERT INTO camp_registrations (camp_id, donor_id, status, source) VALUES ($1, $2, 'RG', 'WB')`,
      [TEST.camp2, DONORS.F.id],
    );

    r = await fetchJson('POST', `/camps/${TEST.camp2}/register`, {
      headers: { Authorization: `Bearer ${DONORS.A.token}` },
      body: { channel: 'web' },
    });
    assert(
      r.status === 409 && r.body.error === 'camp_not_open_for_registration',
      `RSVP to a completed camp → 409 camp_not_open_for_registration (${r.status} ${r.body.error})`,
    );

    let counts = await campCounts(TEST.camp1);
    assert(
      counts.registered_donor_count === 3,
      `registered_donor_count excludes the cancellation (got ${counts.registered_donor_count}, want 3)`,
    );

    console.log('── 4. Donation with donation_camp_id → derived AT ──────────');
    r = await fetchJson('POST', '/donations', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: donationBody(DONORS.A.id, isoDay(0), TEST.camp1, 'A'),
    });
    assert(r.status === 201 && r.body.donation_id, `camp donation recorded (${r.status} ${r.body.error || ''})`);
    const donationA = r.body.donation_id;

    const rowA = await regStatus(TEST.camp1, DONORS.A.id);
    assert(rowA?.status === 'AT', `RG → AT with NO roster call (got ${rowA?.status})`);
    counts = await campCounts(TEST.camp1);
    assert(
      counts.attended_donor_count === 1,
      `attended_donor_count = 1 via trigger (got ${counts.attended_donor_count})`,
    );
    const srcA = await sql(`SELECT source FROM donation_history WHERE id = $1`, [donationA]);
    assert(srcA.rows[0].source === 'CA', `donation source stamped 'CA' (got ${srcA.rows[0].source})`);

    r = await fetchJson('POST', `/camps/${TEST.camp1}/register`, {
      headers: { Authorization: `Bearer ${DONORS.A.token}` },
      body: { channel: 'web' },
    });
    const stillAt = await regStatus(TEST.camp1, DONORS.A.id);
    assert(
      r.status === 409 && r.body.error === 'already_recorded' && stillAt?.status === 'AT',
      `re-registering after AT → 409 already_recorded, row still AT (${r.status} ${r.body.error})`,
    );

    r = await fetchJson('DELETE', `/camps/${TEST.camp1}/register`, {
      headers: { Authorization: `Bearer ${DONORS.A.token}` },
    });
    assert(
      r.status === 409 && r.body.error === 'cannot_cancel_after_attendance',
      `a donor cannot erase their own AT (${r.status} ${r.body.error})`,
    );

    console.log('── 5. Off-roster donor → source=WI ─────────────────────────');
    r = await fetchJson('POST', '/donations', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: donationBody(DONORS.B.id, isoDay(0), TEST.camp1, 'B'),
    });
    assert(r.status === 201, `never-registered donor's camp donation recorded (${r.status})`);
    const donationB = r.body.donation_id;
    const rowB = await regStatus(TEST.camp1, DONORS.B.id);
    assert(
      rowB?.status === 'AT' && rowB?.source === 'WI',
      `a roster row appears with status=AT source=WI (got ${rowB?.status}/${rowB?.source})`,
    );
    counts = await campCounts(TEST.camp1);
    assert(counts.attended_donor_count === 2, `attended_donor_count = 2 (got ${counts.attended_donor_count})`);

    console.log('── 6. trust_level=S self-report → no attendance ────────────');
    // Direct INSERT: POST /donations hardcodes trust_level='V'. Migration 020's
    // verified_needs_blood_bank / verified_needs_barcode CHECKs do not bind for
    // 'S', and fn_donation_creates_inventory returns early, so this is a clean
    // minimal row.
    await sql(
      `INSERT INTO donation_history (donor_id, trust_level, source, collection_date,
                                     component_id, volume_ml, donation_camp_id)
       VALUES ($1, 'S', 'SR', CURRENT_DATE, 2, 350, $2)`,
      [DONORS.D.id, TEST.camp1],
      'camp smoke: self-reported donation attributed to a camp',
    );
    assert(
      (await regStatus(TEST.camp1, DONORS.D.id)) === null,
      'a self-reported donation creates NO roster row',
    );

    console.log('── 7. TTI-reactive + invalidation do NOT undo attendance ───');
    r = await fetchJson('POST', `/donations/${donationB}/screening`, {
      headers: {
        Authorization: `Bearer ${TEST.bb1Token}`,
        'X-Access-Reason': 'camp smoke reactive entry',
      },
      body: {
        hiv_status: 'RR',
        hbsag_status: 'NR',
        hcv_status: 'NR',
        syphilis_status: 'NR',
        malaria_status: 'NR',
      },
    });
    assert(r.status === 201 && r.body.verification_required === true, 'reactive panel needs 4-eyes');
    r = await fetchJson('POST', `/donations/${donationB}/screening/verify`, {
      headers: {
        Authorization: `Bearer ${TEST.bb1Token}`,
        'X-Access-Reason': 'camp smoke self-verify attempt',
      },
    });
    assert(r.status === 403 && r.body.error === 'four_eyes_violation', '4-eyes blocks self-verify');
    r = await fetchJson('POST', `/donations/${donationB}/screening/verify`, {
      headers: {
        Authorization: `Bearer ${TEST.bb2Token}`,
        'X-Access-Reason': 'camp smoke 2nd-eye verify',
      },
    });
    assert(
      r.status === 200 && r.body.overall_clearance === 'IN',
      `2nd eye → clearance IN (${r.status} ${r.body.overall_clearance})`,
    );
    assert(
      (await regStatus(TEST.camp1, DONORS.B.id))?.status === 'AT',
      'the reactive cascade leaves the registration AT — the person still came',
    );

    await sql(
      `UPDATE donation_history SET is_invalidated = TRUE, invalidation_reason = $2 WHERE id = $1`,
      [donationB, 'camp smoke: TTI reactive, bag discarded'],
      'camp smoke: invalidate a camp donation',
    );
    assert(
      (await regStatus(TEST.camp1, DONORS.B.id))?.status === 'AT',
      'is_invalidated=TRUE still leaves the registration AT (no reverse trigger)',
    );

    console.log('── 8. The roster endpoint refuses to set derived states ────');
    const regC = await sql(
      `SELECT id FROM camp_registrations WHERE camp_id = $1 AND donor_id = $2`,
      [TEST.camp1, DONORS.C.id],
    );
    const regCId = regC.rows[0].id;
    for (const bad of ['AT', 'NS']) {
      r = await fetchJson('POST', `/camps/${TEST.camp1}/registrations/${regCId}/status`, {
        headers: { Authorization: `Bearer ${TEST.coordToken}` },
        body: { status: bad },
      });
      assert(
        r.status === 409 && r.body.error === 'attendance_is_derived' && Boolean(r.body.derived_from),
        `setting '${bad}' by hand → 409 attendance_is_derived (${r.status} ${r.body.error})`,
      );
    }

    console.log('── 9. DF is an attendance fact, never a clinical one ───────');
    const beforeC = await sql(
      `SELECT deferral_status, deferral_until, next_eligible_date FROM donors WHERE id = $1`,
      [DONORS.C.id],
    );
    r = await fetchJson('POST', `/camps/${TEST.camp1}/registrations/${regCId}/status`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: { status: 'DF' },
    });
    assert(
      r.status === 200 && r.body.registration?.status === 'DF',
      `'DF' is settable at the desk (${r.status} ${r.body.registration?.status})`,
    );
    counts = await campCounts(TEST.camp1);
    assert(
      counts.deferred_donor_count === 1,
      `deferred_donor_count = 1 (got ${counts.deferred_donor_count})`,
    );
    const afterC = await sql(
      `SELECT deferral_status, deferral_until, next_eligible_date FROM donors WHERE id = $1`,
      [DONORS.C.id],
    );
    assert(
      String(beforeC.rows[0].deferral_until) === String(afterC.rows[0].deferral_until) &&
        String(beforeC.rows[0].next_eligible_date) === String(afterC.rows[0].next_eligible_date) &&
        beforeC.rows[0].deferral_status === afterC.rows[0].deferral_status,
      'a roster DF leaves donors.deferral_until / next_eligible_date UNTOUCHED (hard rule 1)',
    );

    console.log('── 10. camp_close_roster: the 48-hour grace, both ways ─────');
    await sql(`UPDATE donation_camps SET scheduled_date = CURRENT_DATE - 3 WHERE id = $1`, [
      TEST.camp1,
    ]);
    r = await fetchJson('POST', '/admin/jobs/run', {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { name: 'camp_close_roster' },
    });
    assert(r.status === 200, `camp_close_roster ran (${r.status} ${r.body.error || ''})`);
    assert(
      (await regStatus(TEST.camp1, DONORS.E.id))?.status === 'NS',
      'a camp 3 days past with attendance evidence closes its roster: RG → NS',
    );
    assert(
      (await regStatus(TEST.camp2, DONORS.F.id))?.status === 'RG',
      'a camp held YESTERDAY is untouched — the blood bank batch-enters tomorrow',
    );
    assert(
      (await regStatus(TEST.camp1, DONORS.C.id))?.status === 'DF' &&
        (await regStatus(TEST.camp1, DONORS.H.id))?.status === 'CN',
      'closing a roster touches only RG rows — DF and CN survive',
    );

    console.log('── 11. A late donation self-heals the no-show ──────────────');
    r = await fetchJson('POST', '/donations', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: donationBody(DONORS.E.id, isoDay(-1), TEST.camp1, 'E'),
    });
    assert(r.status === 201, `late camp donation accepted (${r.status} ${r.body.error || ''})`);
    assert(
      (await regStatus(TEST.camp1, DONORS.E.id))?.status === 'AT',
      'the derivation overwrites NS with AT — a week-late entry still corrects the record',
    );

    console.log('── 12. PATCH /camps/:id ────────────────────────────────────');
    r = await fetchJson('PATCH', `/camps/${TEST.camp3}`, {
      headers: { Authorization: `Bearer ${DONORS.A.token}` },
      body: { venue: 'Somewhere Else Entirely' },
    });
    assert(
      r.status === 403 && r.body.error === 'not_camp_owner',
      `a non-owner cannot edit (${r.status} ${r.body.error})`,
    );

    r = await fetchJson('PATCH', `/camps/${TEST.camp2}`, {
      headers: { Authorization: `Bearer ${DONORS.H.token}` },
      body: { venue: 'Too Late Hall' },
    });
    assert(
      r.status === 409 && r.body.error === 'camp_not_editable' && r.body.current_status === 'CO',
      `a completed camp cannot be edited (${r.status} ${r.body.error})`,
    );

    const notifBefore = await sql(
      `SELECT COUNT(*)::int AS n FROM notification_log
        WHERE template_type = 'CAMP_ANNC' AND recipient_donor_id = ANY($1::uuid[])`,
      [[DONORS.A.id, DONORS.B.id, DONORS.C.id, DONORS.E.id]],
    );

    r = await fetchJson('PATCH', `/camps/${TEST.camp1}`, {
      headers: { Authorization: `Bearer ${DONORS.H.token}` },
      body: { scheduled_date: isoDay(7), venue: 'Municipal Hall 2' },
    });
    assert(r.status === 200, `owner edits a PL camp from their donor session (${r.status} ${r.body.error || ''})`);
    assert(r.body.camp?.status === 'PL', `the status is left alone (got ${r.body.camp?.status})`);
    assert(
      (r.body.changed_fields || []).includes('scheduled_date') &&
        r.body.changed_fields.includes('venue'),
      `changed_fields reports both edits (got ${JSON.stringify(r.body.changed_fields)})`,
    );
    // A(AT) B(AT) C(DF) E(AT) are told; H(CN) is not.
    assert(r.body.notified === 4, `4 registered donors notified, cancellations skipped (got ${r.body.notified})`);

    const notesR = await sql(`SELECT review_notes FROM donation_camps WHERE id = $1`, [TEST.camp1]);
    assert(
      /\[edited /.test(notesR.rows[0].review_notes || '') &&
        /venue/.test(notesR.rows[0].review_notes || ''),
      'the diff is appended to review_notes',
    );

    const notifAfter = await sql(
      `SELECT COUNT(*)::int AS n FROM notification_log
        WHERE template_type = 'CAMP_ANNC' AND recipient_donor_id = ANY($1::uuid[])`,
      [[DONORS.A.id, DONORS.B.id, DONORS.C.id, DONORS.E.id]],
    );
    assert(
      notifAfter.rows[0].n - notifBefore.rows[0].n === 4,
      `one notification_log row per notified donor (delta ${notifAfter.rows[0].n - notifBefore.rows[0].n})`,
    );

    r = await fetchJson('PATCH', `/camps/${TEST.camp1}`, {
      headers: { Authorization: `Bearer ${DONORS.H.token}` },
      body: { venue: 'Municipal Hall 2' },
    });
    assert(
      r.status === 200 && r.body.unchanged === true && r.body.notified === 0,
      `re-saving the same value notifies nobody (${r.status} unchanged=${r.body.unchanged})`,
    );

    console.log('── 13. QR walk-in attribution (Phase 3 TODO #2) ────────────');
    // The desk poster sends someone to /c/<slug>, which sends them to
    // /register?camp=<slug>. DonorRegister resolves the slug through the public
    // camp page and then registers as QRC — for two years the wizard sent a flat
    // 'WEB' and threw the camp away, so assert the whole hop, slug included.
    r = await fetchJson('GET', `/camps/public/${encodeURIComponent(camp1Slug)}`);
    assert(
      r.status === 200 && r.body.id === TEST.camp1,
      `the public poster page resolves the slug to the camp (${r.status})`,
    );
    r = await fetchJson('POST', '/donors/register', {
      body: {
        mobile: DONORS.G.mobile,
        full_name: DONORS.G.name,
        date_of_birth: '1993-08-02',
        gender: 'F',
        registration_source: 'QRC',
        registration_camp_id: r.body.id,
      },
    });
    assert(r.status === 201, `a QR signup registers (${r.status} ${r.body.error || ''})`);
    const qrRow = await sql(
      `SELECT registration_source, registration_camp_id FROM donors WHERE id = $1`,
      [r.body.donor_id],
    );
    assert(
      qrRow.rows[0]?.registration_source === 'QRC' &&
        qrRow.rows[0]?.registration_camp_id === TEST.camp1,
      `the camp that recruited this donor is recorded (got ${qrRow.rows[0]?.registration_source}/${
        qrRow.rows[0]?.registration_camp_id === TEST.camp1 ? 'camp1' : 'null'
      })`,
    );
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
  console.log(`Camp module smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
