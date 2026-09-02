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
 * 14.  the organiser names a blood bank (migration 315): the public picker
 *      leaks no PII and offers only ACTIVE onboarded BBs in the district, a
 *      cross-district ask is refused, the request NEVER auto-partners, and
 *      the admin's verify click is what promotes or overrides it
 * 15.  the BB publishes capacity (316) and answers (317): settings + a
 *      suggested max_camps, a capacity write scoped to the caller, max_camps=0
 *      blocks an apply with alternatives and files NO camp row, a PE camp
 *      counts as pending and never blocks, publish-month spares a hand-set
 *      holiday, the public availability strip leaks only counts, PE → AC /
 *      DC-with-reason, the partner-less CHECK, a decline keeps status +
 *      partner + collectability, auto-accept, and the masked results worklist
 * 16.  organiser branding (319): the logo is a data: URI, an edit resets the
 *      status to PE, and only an APPROVED pair reaches the public page
 * 17.  hard delete (ngo_admin only): the four refusals that keep a camp with a
 *      human attached, the CASCADE, and the audit_log row that makes a
 *      permanent removal recoverable
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

// fetchJson cannot carry an image. Its body line is unconditional -
// JSON.stringify(opts.body) - so a Buffer would arrive at the server as JSON
// text, and the ...opts.headers spread can override the content type but not
// that. So POST /camps/access/:token/logo-raw, which is
// express.raw({ type: ['image/jpeg', 'image/png'] }), gets its own sibling here,
// exactly as tokenUpload sits beside tokenFetch on the organiser dashboard.
// Node's fetch takes a Buffer directly (a Buffer IS a Uint8Array).
function fetchRaw(method, urlPath, buf, contentType) {
  return fetch(`http://127.0.0.1:${PORT}${urlPath}`, {
    method,
    headers: { 'Content-Type': contentType },
    body: buf,
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

// Minimal valid /camps/apply body. Section 14 files four applications that
// differ only in the blood-bank field, so the rest is factored out here.
function applyBody(name, dateIso) {
  return {
    name,
    organiser_type: 'CO',
    organiser_name: 'Camp Smoke Organisers',
    state_id: TEST.state_id,
    district_id: TEST.district_id,
    venue: 'Community Hall',
    address_line: '4 Hall Road, Camp Ward',
    scheduled_date: dateIso,
    start_time: '09:00',
    end_time: '13:00',
    submitted_by_name: 'Camp Host',
    submitted_by_mobile: HOST_MOBILE,
  };
}

// Section 14's institution fixtures. is_active is passed explicitly because it
// defaults to FALSE, and an accidentally-inactive BB would fail the picker
// assertions for the wrong reason.
async function makeInst(tag, kind, status, active, districtId) {
  const r = await sql(
    `INSERT INTO institutions (kind, shortname, legal_name, display_name, state_id,
                               district_id, address_line, pincode, primary_contact_name,
                               primary_contact_mobile, cdsco_licence_number,
                               cdsco_licence_expires, onboarding_status, is_active)
     VALUES ($1, $2, $3, $3, $4, $5, '9 Camp Road', '444601', 'Contact',
             $6, $7, (CURRENT_DATE + INTERVAL '1 year')::date, $8, $9)
     RETURNING id`,
    [
      kind,
      `cm${tag}${RUN_TAG}`,
      `Camp Smoke ${tag.toUpperCase()} ${RUN_TAG}`,
      TEST.state_id,
      districtId,
      `+9198${RUN_TAG}${tag.length}`,
      `CDSCO-${tag}-${RUN_TAG}`,
      status,
      active,
    ],
    `fixture institution ${tag}`,
  );
  return r.rows[0].id;
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

    console.log('── 14. the organiser asks for a blood bank; the NGO rules ───');
    // institutions.is_active defaults to FALSE, so every fixture meant to be
    // pickable says so explicitly — and the two that must not be pickable are
    // the negative controls.
    await sql(`UPDATE institutions SET is_active = TRUE WHERE id = $1`, [TEST.bbInst], 'bb active');

    const otherDistrict = await sql(
      `SELECT d.id FROM districts d JOIN states s ON s.id = d.state_id
        WHERE d.is_active AND s.is_active AND d.id <> $1 ORDER BY d.id ASC LIMIT 1`,
      [TEST.district_id],
      'second district',
    );
    const OTHER_DISTRICT = otherDistrict.rows[0]?.id || null;

    const bbSecond = await makeInst('bb2', 'BB', 'AC', true, TEST.district_id);
    const bbPending = await makeInst('bbpe', 'BB', 'PE', true, TEST.district_id);
    const bbInactive = await makeInst('bboff', 'BB', 'AC', false, TEST.district_id);
    const hoSame = await makeInst('ho', 'HO', 'AC', true, TEST.district_id);
    const bbElsewhere = OTHER_DISTRICT
      ? await makeInst('bbfar', 'BB', 'AC', true, OTHER_DISTRICT)
      : null;

    // The picker is PUBLIC on purpose — camp hosting has no sign-in wall — so
    // it is called here with no Authorization header at all.
    r = await fetchJson('GET', `/camps/blood-bank-options?district_id=${TEST.district_id}`);
    const optionIds = (r.body.blood_banks || []).map((b) => b.id);
    assert(
      r.status === 200 && optionIds.includes(TEST.bbInst) && optionIds.includes(bbSecond),
      `the public picker needs NO token and lists active onboarded BBs (${r.status}, ${optionIds.length} rows)`,
    );
    assert(
      !optionIds.includes(bbPending) &&
        !optionIds.includes(bbInactive) &&
        !optionIds.includes(hoSame),
      'a pending BB, a deactivated BB and a hospital are never offered',
    );
    // A public read over the institutions table is exactly where PII leaks, so
    // the response shape is asserted key-by-key rather than eyeballed.
    const LEAK_KEYS = [
      'primary_contact_mobile',
      'primary_contact_email',
      'address_line',
      'cdsco_licence_number',
    ];
    const leaked = (r.body.blood_banks || []).flatMap((b) => LEAK_KEYS.filter((k) => k in b));
    assert(
      leaked.length === 0 && (r.body.blood_banks || []).every((b) => b.display_name),
      `the public picker returns name + district and no PII (leaked: ${leaked.join(',') || 'none'})`,
    );

    if (OTHER_DISTRICT) {
      r = await fetchJson('GET', `/camps/blood-bank-options?district_id=${OTHER_DISTRICT}`);
      const farIds = (r.body.blood_banks || []).map((b) => b.id);
      assert(
        !farIds.includes(TEST.bbInst) && farIds.includes(bbElsewhere),
        'the district filter is a real filter, not a sort',
      );

      r = await fetchJson('POST', '/camps/apply', {
        body: {
          ...applyBody(`Camp Smoke Cross ${RUN_TAG}`, isoDay(24)),
          requested_blood_bank_id: bbElsewhere,
        },
      });
      const crossRow = await sql(
        `SELECT id FROM donation_camps WHERE name = $1`,
        [`Camp Smoke Cross ${RUN_TAG}`],
        'cross-district camp',
      );
      assert(
        r.status === 400 &&
          r.body.error === 'blood_bank_not_in_district' &&
          crossRow.rowCount === 0,
        `a BB from another district is refused and no camp is filed (${r.status} ${r.body.error || ''})`,
      );
    }

    // THE ASSERTION THE WHOLE DESIGN RESTS ON: the organiser's ask lands in
    // requested_blood_bank_id and partnered_blood_bank_id stays NULL. Writing
    // it straight to partnered_ would put the camp in a blood bank's
    // collectable list before anyone agreed to staff it.
    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke Ask ${RUN_TAG}`, isoDay(1)),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    const campAsk = r.body.camp_id;
    let bbRow = await sql(
      `SELECT requested_blood_bank_id, partnered_blood_bank_id FROM donation_camps WHERE id = $1`,
      [campAsk],
      'ask row',
    );
    assert(
      r.status === 201 &&
        bbRow.rows[0]?.requested_blood_bank_id === TEST.bbInst &&
        bbRow.rows[0]?.partnered_blood_bank_id === null,
      `the ask is filed as a REQUEST and partners nothing (${r.status})`,
    );
    assert(
      typeof r.body.requested_blood_bank_name === 'string' &&
        r.body.requested_blood_bank_name.length > 0,
      `the success screen is told who was asked for, by name (${r.body.requested_blood_bank_name})`,
    );

    // Verify sends no blood bank at all — an older client, or an admin who
    // never touched the dropdown. The COALESCE must promote the request rather
    // than silently drop it.
    r = await fetchJson('POST', `/camps/${campAsk}/verify`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: { review_notes: 'verified without touching the blood-bank field' },
    });
    bbRow = await sql(
      `SELECT partnered_blood_bank_id FROM donation_camps WHERE id = $1`,
      [campAsk],
      'promoted row',
    );
    assert(
      r.status === 200 && bbRow.rows[0]?.partnered_blood_bank_id === TEST.bbInst,
      `verify with no field promotes the organiser's request (${r.status})`,
    );

    // Now the override: the admin knows the requested BB cannot staff that
    // date. Their choice wins, and requested_ survives as the record of the ask.
    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke Override ${RUN_TAG}`, isoDay(26)),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    r = await fetchJson('POST', `/camps/${r.body.camp_id}/verify`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: { partnered_blood_bank_id: bbSecond },
    });
    bbRow = await sql(
      `SELECT requested_blood_bank_id, partnered_blood_bank_id FROM donation_camps WHERE name = $1`,
      [`Camp Smoke Override ${RUN_TAG}`],
      'override row',
    );
    assert(
      r.status === 200 &&
        bbRow.rows[0]?.partnered_blood_bank_id === bbSecond &&
        bbRow.rows[0]?.requested_blood_bank_id === TEST.bbInst,
      `the admin overrides and the original ask is still on the record (${r.status})`,
    );

    // "I do not know" is a first-class answer: it must not block the
    // application, and it must not block approval either.
    r = await fetchJson('POST', '/camps/apply', {
      body: applyBody(`Camp Smoke Dunno ${RUN_TAG}`, isoDay(27)),
    });
    const campDunno = r.body.camp_id;
    assert(
      r.status === 201 && !r.body.requested_blood_bank_name,
      `"I do not know" files a camp and names nobody (${r.status})`,
    );
    r = await fetchJson('POST', `/camps/${campDunno}/verify`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: {},
    });
    bbRow = await sql(
      `SELECT partnered_blood_bank_id, status FROM donation_camps WHERE id = $1`,
      [campDunno],
      'dunno row',
    );
    assert(
      r.status === 200 &&
        bbRow.rows[0]?.status === 'PL' &&
        bbRow.rows[0]?.partnered_blood_bank_id === null,
      `no blood bank anywhere still goes PE → PL (${r.status}, ${bbRow.rows[0]?.status})`,
    );

    // End-to-end sanity that the promoted column is usable: the partnered BB
    // sees the camp. (collectable also falls back to district, so this is a
    // smoke check on the write, not a proof of ownership.)
    r = await fetchJson('GET', '/camps/collectable', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 200 && (r.body.camps || []).some((c) => c.id === campAsk),
      `the partnered blood bank sees the camp in its collectable list (${r.status})`,
    );
    console.log('── 15. the blood bank publishes capacity and answers ────────');

    // A staff user on the SECOND blood bank. Every boundary assertion below
    // needs a token belonging to a DIFFERENT institution than TEST.bbInst.
    // seedCoordinatorOnHostMobile()'s sql() shape is the one that works here —
    // bootstrap() holds a raw pool client that is long released by now.
    const bb3User = `cmbb3-${RUN_TAG}`;
    const bb3Secret = totp.newSecret();
    await sql(
      `INSERT INTO platform_users (role, username, email, password_hash, password_set_at,
                                   institution_id, totp_secret, totp_enabled)
       VALUES ('blood_bank', $1, $2, $3, NOW(), $4, $5, TRUE)`,
      [
        bb3User,
        `${bb3User}@example.com`,
        await bcrypt.hash(TEST.bbStaffPwd, 10),
        bbSecond,
        encryption.encrypt(bb3Secret),
      ],
      'camp smoke: staff on the second blood bank',
    );
    r = await loginInstitutional(bb3User, TEST.bbStaffPwd, bb3Secret);
    const bb3Token = r.body.token;
    assert(!!bb3Token, `a second blood bank's staff can sign in (${r.status})`);

    // Section 14 already occupies isoDay(1) / 24 / 26 / 27, so capacity dates
    // start at 41. CAP_MONTH is DERIVED from CAP_FULL rather than guessed, and
    // CAP_UNPUB is day 15 of the FOLLOWING month — publish-month generates one
    // month, so that is the one date it can never reach.
    const CAP_FULL = isoDay(41); // max_camps = 0 → the holiday
    const CAP_OPEN = isoDay(42); // max_camps = 2 → the bookable day
    const CAP_XBB = isoDay(43); // used only for the cross-institution write
    const CAP_AUTO = isoDay(44); // max_camps = 2 → auto-accept lands here
    const CAP_MONTH = CAP_FULL.slice(0, 7);
    const CAP_UNPUB = (() => {
      const [y, m] = CAP_MONTH.split('-').map(Number);
      const y2 = m === 12 ? y + 1 : y;
      const m2 = m === 12 ? 1 : m + 1;
      return `${y2}-${String(m2).padStart(2, '0')}-15`;
    })();

    // ── settings: no row is a state, not a 404 ──────────────────────────────
    r = await fetchJson('GET', '/camps/bb/settings', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 200 && r.body.settings === null && r.body.suggested_max_camps === null,
      `a blood bank that never published anything reads as null, not 404 (${r.status})`,
    );

    // The founder's own arithmetic: 50 staff, 8 per camp, so 6 camps a day.
    r = await fetchJson('PUT', '/camps/bb/settings', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: {
        staff_total: 50,
        staff_per_camp: 8,
        default_max_camps: 6,
        weekly_closed_days: [0],
      },
    });
    assert(
      r.status === 200 &&
        r.body.suggested_max_camps === 6 &&
        r.body.settings?.auto_accept_within_capacity === false,
      `50 staff ÷ 8 per camp suggests 6 a day, and auto-accept stays off (${r.status}, ${r.body.suggested_max_camps})`,
    );

    // Every field is optional and the upsert COALESCEs, so a one-field PUT must
    // not blank the rest. This is the difference between "edit the headcount"
    // and "wipe the month template".
    r = await fetchJson('PUT', '/camps/bb/settings', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { staff_per_camp: 10 },
    });
    assert(
      r.status === 200 &&
        r.body.settings?.staff_total === 50 &&
        r.body.settings?.default_max_camps === 6 &&
        (r.body.settings?.weekly_closed_days || []).includes(0) &&
        r.body.suggested_max_camps === 5,
      `a partial settings PUT keeps the other fields (total ${r.body.settings?.staff_total}, suggested ${r.body.suggested_max_camps})`,
    );

    // ── the capacity write is scoped to the caller's own institution ────────
    // resolveBbTarget IGNORES a blood_bank caller's blood_bank_id rather than
    // rejecting it, so the assertion is about WHERE THE ROW LANDED, not a 403.
    r = await fetchJson('PUT', '/camps/bb/capacity', {
      headers: { Authorization: `Bearer ${bb3Token}` },
      body: {
        blood_bank_id: TEST.bbInst,
        days: [{ date: CAP_XBB, max_camps: 4 }],
      },
    });
    // Scoped to THIS run's two blood banks. capacity_date is an absolute date,
    // so a second run of this file on the same day writes the same isoDay(43)
    // under a fresh pair of institutions — an unscoped count would read those
    // leftovers as a boundary breach.
    const xbbRows = await sql(
      `SELECT blood_bank_id FROM bb_camp_capacity
        WHERE capacity_date = $1::date
          AND blood_bank_id IN ($2::uuid, $3::uuid)`,
      [CAP_XBB, bbSecond, TEST.bbInst],
      'cross-institution capacity write',
    );
    assert(
      r.status === 200 &&
        xbbRows.rowCount === 1 &&
        xbbRows.rows[0].blood_bank_id === bbSecond &&
        xbbRows.rows[0].blood_bank_id !== TEST.bbInst,
      `a blood bank writing capacity can only ever write its OWN (${r.status}, ${xbbRows.rowCount} row)`,
    );

    // ── an unpublished day is unconstrained, not closed ─────────────────────
    r = await fetchJson(
      'GET',
      `/camps/bb/capacity?from=${CAP_UNPUB}&to=${CAP_UNPUB}`,
      { headers: { Authorization: `Bearer ${TEST.bb1Token}` } },
    );
    const unpubDay = (r.body.days || [])[0];
    assert(
      r.status === 200 &&
        unpubDay?.published === false &&
        unpubDay?.slots_left === null &&
        unpubDay?.ok === true,
      `a date with no row reads published:false / slots_left:null / ok:true (${r.status})`,
    );

    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke Unpub ${RUN_TAG}`, CAP_UNPUB),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    assert(
      r.status === 201 && r.body.bb_response === null,
      `an unpublished day does NOT block an application (${r.status}, response ${String(r.body.bb_response)})`,
    );

    // ── publish three days: a holiday, a bookable day, an auto-accept day ───
    r = await fetchJson('PUT', '/camps/bb/capacity', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: {
        days: [
          { date: CAP_FULL, max_camps: 0, note: 'Diwali' },
          { date: CAP_OPEN, max_camps: 2, staff_committed: 16 },
          { date: CAP_AUTO, max_camps: 2 },
        ],
      },
    });
    assert(r.status === 200 && r.body.written === 3, `three days publish in one call (${r.status})`);

    r = await fetchJson('GET', `/camps/bb/capacity?from=${CAP_FULL}&to=${CAP_AUTO}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    const fullDay = (r.body.days || []).find((d) => d.date === CAP_FULL);
    assert(
      r.status === 200 &&
        fullDay?.published === true &&
        fullDay?.max_camps === 0 &&
        fullDay?.note === 'Diwali' &&
        fullDay?.ok === false,
      `max_camps=0 IS the holiday — published, closed, and carrying its note (${r.status})`,
    );

    // The duplicate scan runs before any write, so CAP_OPEN must be untouched.
    r = await fetchJson('PUT', '/camps/bb/capacity', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: {
        days: [
          { date: CAP_OPEN, max_camps: 9 },
          { date: CAP_OPEN, max_camps: 1 },
        ],
      },
    });
    const openRow = await sql(
      `SELECT max_camps FROM bb_camp_capacity WHERE blood_bank_id = $1 AND capacity_date = $2::date`,
      [TEST.bbInst, CAP_OPEN],
      'duplicate-date guard',
    );
    assert(
      r.status === 400 && r.body.error === 'duplicate_date' && openRow.rows[0]?.max_camps === 2,
      `one date twice in one payload is refused before anything is written (${r.status}, still ${openRow.rows[0]?.max_camps})`,
    );

    // ── a closed day blocks the application AND offers alternatives ─────────
    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke Full ${RUN_TAG}`, CAP_FULL),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    const fullFiled = await sql(
      `SELECT id FROM donation_camps WHERE name = $1`,
      [`Camp Smoke Full ${RUN_TAG}`],
      'camp on a closed day',
    );
    assert(
      r.status === 409 &&
        r.body.error === 'blood_bank_day_full' &&
        r.body.max_camps === 0 &&
        r.body.confirmed === 0 &&
        (r.body.next_open_dates || []).includes(CAP_OPEN),
      `a closed day returns 409 blood_bank_day_full with open alternatives (${r.status}, next: ${(r.body.next_open_dates || []).join(',')})`,
    );
    assert(
      fullFiled.rowCount === 0,
      'a blocked application files NO camp row — the organiser is not half-registered',
    );

    // ── a pending application is surfaced and never blocks ──────────────────
    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke Cap ${RUN_TAG}`, CAP_OPEN),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    const campCap = r.body.camp_id;
    assert(
      r.status === 201 && r.body.bb_response === null,
      `an application on an open day is filed with no BB response yet (${r.status}, ${String(r.body.bb_response)})`,
    );

    r = await fetchJson('GET', `/camps/bb/capacity?from=${CAP_OPEN}&to=${CAP_OPEN}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    let capDay = (r.body.days || [])[0];
    assert(
      capDay?.pending === 1 &&
        capDay?.confirmed === 0 &&
        capDay?.slots_left === 2 &&
        capDay?.ok === true &&
        capDay?.staff_committed === 16,
      `a PE camp counts as pending, never as occupancy (pending ${capDay?.pending}, confirmed ${capDay?.confirmed}, left ${capDay?.slots_left})`,
    );

    // ── the NGO's verify is what turns pending into confirmed ───────────────
    r = await fetchJson('POST', `/camps/${campCap}/verify`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: {},
    });
    bbRow = await sql(
      `SELECT status, bb_response, partnered_blood_bank_id FROM donation_camps WHERE id = $1`,
      [campCap],
      'verified capacity camp',
    );
    assert(
      r.status === 200 &&
        bbRow.rows[0]?.status === 'PL' &&
        bbRow.rows[0]?.bb_response === 'PE' &&
        bbRow.rows[0]?.partnered_blood_bank_id === TEST.bbInst,
      `verify promotes requested → partnered and stamps bb_response='PE' (${r.status}, ${bbRow.rows[0]?.bb_response})`,
    );

    r = await fetchJson('GET', `/camps/bb/capacity?from=${CAP_OPEN}&to=${CAP_OPEN}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    capDay = (r.body.days || [])[0];
    assert(
      capDay?.confirmed === 1 && capDay?.pending === 0 && capDay?.slots_left === 1,
      `once verified the same camp moves pending → confirmed (confirmed ${capDay?.confirmed}, left ${capDay?.slots_left})`,
    );

    // ── publish-month never overwrites a hand-set day ───────────────────────
    r = await fetchJson('POST', '/camps/bb/capacity/publish-month', {
      headers: { Authorization: `Bearer ${bb3Token}` },
      body: { month: CAP_MONTH },
    });
    assert(
      r.status === 409 && r.body.error === 'settings_not_set',
      `publish-month without settings is a clean 409, not a crash (${r.status}, ${r.body.error})`,
    );

    r = await fetchJson('POST', '/camps/bb/capacity/publish-month', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { month: CAP_MONTH },
    });
    const holiday = await sql(
      `SELECT max_camps, note FROM bb_camp_capacity
        WHERE blood_bank_id = $1 AND capacity_date = $2::date`,
      [TEST.bbInst, CAP_FULL],
      'holiday survives publish-month',
    );
    assert(
      r.status === 200 && r.body.created > 0 && r.body.default_max_camps === 6,
      `publish-month generates the rest of the month from the template (${r.status}, created ${r.body.created})`,
    );
    assert(
      holiday.rows[0]?.max_camps === 0 && holiday.rows[0]?.note === 'Diwali',
      `a hand-set holiday SURVIVES a re-publish (${holiday.rows[0]?.max_camps}, ${holiday.rows[0]?.note})`,
    );

    // ── the public availability strip: counts, and nothing else ─────────────
    const AVAIL_KEYS = [
      'date',
      'published',
      'max_camps',
      'confirmed',
      'pending',
      'slots_left',
      'ok',
    ];
    r = await fetchJson(
      'GET',
      `/camps/bb-availability?blood_bank_id=${TEST.bbInst}&from=${CAP_FULL}&to=${CAP_AUTO}`,
    );
    const availDays = r.body.days || [];
    const availExtra = availDays.flatMap((d) => Object.keys(d).filter((k) => !AVAIL_KEYS.includes(k)));
    const availMissing = availDays.flatMap((d) => AVAIL_KEYS.filter((k) => !(k in d)));
    assert(
      r.status === 200 && availDays.length === 4,
      `the availability strip needs NO token and covers every day in the range (${r.status}, ${availDays.length} days)`,
    );
    assert(
      availExtra.length === 0 && availMissing.length === 0,
      `every row carries exactly the seven public keys — no note, no staff, no camp (extra: ${availExtra.join(',') || 'none'}; missing: ${availMissing.join(',') || 'none'})`,
    );
    assert(
      availDays.find((d) => d.date === CAP_FULL)?.ok === false &&
        availDays.find((d) => d.date === CAP_OPEN)?.ok === true,
      'the organiser can see the closed day is closed and the open day is open',
    );

    r = await fetchJson('GET', `/camps/bb-availability?blood_bank_id=${hoSame}`);
    assert(
      r.status === 404 && r.body.error === 'blood_bank_not_found',
      `a hospital has no camp availability to publish (${r.status})`,
    );
    r = await fetchJson('GET', '/camps/bb-availability?blood_bank_id=not-a-uuid');
    assert(
      r.status === 400 && r.body.error === 'invalid_blood_bank_id',
      `a garbage blood_bank_id is a 400, never a 500 (${r.status})`,
    );

    // ── the response: accept, decline, and who may make it ──────────────────
    r = await fetchJson('POST', `/camps/${campAsk}/bb-response`, {
      headers: { Authorization: `Bearer ${bb3Token}` },
      body: { response: 'AC' },
    });
    assert(
      r.status === 409 && r.body.error === 'not_your_camp',
      `a blood bank cannot answer for another blood bank's camp (${r.status}, ${r.body.error})`,
    );

    r = await fetchJson('POST', `/camps/${campAsk}/bb-response`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { response: 'DC' },
    });
    assert(r.status === 400, `a decline with no reason is refused (${r.status})`);

    r = await fetchJson('POST', `/camps/${campAsk}/bb-response`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { response: 'AC' },
    });
    assert(
      r.status === 200 && r.body.bb_response === 'AC' && !!r.body.submitted_by_mobile,
      `accepting reveals the organiser's number to THAT blood bank (${r.status}, mobile ${r.body.submitted_by_mobile ? 'present' : 'absent'})`,
    );

    r = await fetchJson('POST', `/camps/${campDunno}/bb-response`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { response: 'AC' },
    });
    assert(
      r.status === 409 && r.body.error === 'not_your_camp',
      `a camp with no partner has nobody to answer for it (${r.status})`,
    );

    let ckErr = null;
    try {
      await sql(
        `UPDATE donation_camps SET bb_response = 'AC' WHERE id = $1`,
        [campDunno],
        'response without a partner',
      );
    } catch (e) {
      ckErr = e;
    }
    assert(
      ckErr?.code === '23514',
      `bb_response_needs_partner is enforced by the DB, not just the handler (${ckErr?.code})`,
    );

    // ── organiser contact is revealed on accept, and only to that BB ────────
    r = await fetchJson('GET', `/camps/${campCap}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 200 && !('submitted_by_mobile' in r.body) && !('submitted_by_name' in r.body),
      `while bb_response='PE' the organiser's contact is redacted (${r.status})`,
    );
    r = await fetchJson('GET', `/camps/${campAsk}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 200 && !!r.body.submitted_by_mobile && !r.body.review_notes,
      `after 'AC' the same BB reads the contact — and still never the NGO's notes (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/bb/camps?from=${isoDay(0)}&to=${CAP_AUTO}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    const mineAsk = (r.body.camps || []).find((c) => c.id === campAsk);
    const mineCap = (r.body.camps || []).find((c) => c.id === campCap);
    assert(
      r.status === 200 && !!mineAsk && !!mineCap && r.body.awaiting_response >= 1,
      `the BB's own camp list spans every status and counts what is awaiting an answer (${r.status}, awaiting ${r.body.awaiting_response})`,
    );
    assert(
      !!mineAsk.submitted_by_mobile && !mineCap.submitted_by_mobile,
      'the same split holds on the list: accepted camp reveals, pending camp redacts',
    );

    // ── a decline changes nothing except the answer ─────────────────────────
    r = await fetchJson('POST', `/camps/${campCap}/bb-response`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { response: 'DC', decline_reason: 'NC', note: 'both vans out that day' },
    });
    bbRow = await sql(
      `SELECT status, partnered_blood_bank_id, bb_response, bb_decline_reason
         FROM donation_camps WHERE id = $1`,
      [campCap],
      'declined camp',
    );
    assert(
      r.status === 200 &&
        bbRow.rows[0]?.status === 'PL' &&
        bbRow.rows[0]?.partnered_blood_bank_id === TEST.bbInst &&
        bbRow.rows[0]?.bb_response === 'DC' &&
        bbRow.rows[0]?.bb_decline_reason === 'NC',
      `a decline keeps status PL and keeps the record of WHO declined (${r.status}, ${bbRow.rows[0]?.status}/${bbRow.rows[0]?.bb_response})`,
    );

    // The BB that declined on Monday must still be able to collect on Saturday.
    // DATE_TOLERANCE_DAYS is 2, so this has to ask for the camp's own date.
    r = await fetchJson('GET', `/camps/collectable?date=${CAP_OPEN}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 200 && (r.body.camps || []).some((c) => c.id === campCap),
      `a declined camp is STILL collectable — the decline is not a cancellation (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/bb/capacity?from=${CAP_OPEN}&to=${CAP_OPEN}`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    capDay = (r.body.days || [])[0];
    assert(
      capDay?.confirmed === 1,
      `a decline does not free the slot either — status still drives occupancy (confirmed ${capDay?.confirmed})`,
    );

    // ── re-partnering the declined camp ─────────────────────────────────────
    // Nothing else in the file can do this: verify is bound to status 'PE' and
    // PATCH lists partnered_blood_bank_id as not editable. Without this route a
    // declined camp is a red row with no button.
    r = await fetchJson('POST', `/camps/${campCap}/repartner`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: { partnered_blood_bank_id: bbSecond, reason: 'first BB had no vans' },
    });
    bbRow = await sql(
      `SELECT status, partnered_blood_bank_id, bb_response, bb_response_at,
              bb_response_by, bb_decline_reason, bb_decline_note, review_notes
         FROM donation_camps WHERE id = $1`,
      [campCap],
      're-partnered camp',
    );
    assert(
      r.status === 200 &&
        bbRow.rows[0]?.partnered_blood_bank_id === bbSecond &&
        bbRow.rows[0]?.bb_response === 'PE' &&
        bbRow.rows[0]?.status === 'PL',
      `the declined camp moves to a new blood bank and asks it fresh (${r.status}, ${bbRow.rows[0]?.bb_response})`,
    );
    // 317's bb_decline_reason_needs_decline would have rejected the UPDATE
    // outright if the reason had been left behind — but the NULL note and NULL
    // timestamp matter too: a stale bb_response_at would date the new BB's
    // silence to the old BB's refusal.
    assert(
      bbRow.rows[0]?.bb_decline_reason === null &&
        bbRow.rows[0]?.bb_decline_note === null &&
        bbRow.rows[0]?.bb_response_at === null &&
        bbRow.rows[0]?.bb_response_by === null,
      'no trace of the previous decline is left flagged against the new blood bank',
    );
    assert(
      (bbRow.rows[0]?.review_notes || '').includes('first BB had no vans'),
      'why the camp was moved is on the record, NGO-internal',
    );

    // The BB that declined no longer owns the camp; the new one does.
    r = await fetchJson('POST', `/camps/${campCap}/bb-response`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { response: 'AC' },
    });
    assert(
      r.status === 409 && r.body.error === 'not_your_camp',
      `the blood bank that declined can no longer answer for the camp (${r.status})`,
    );
    r = await fetchJson('POST', `/camps/${campCap}/bb-response`, {
      headers: { Authorization: `Bearer ${bb3Token}` },
      body: { response: 'AC' },
    });
    assert(r.status === 200, `the new blood bank accepts the reassigned camp (${r.status})`);

    // A hospital's UUID satisfies the FK and fails the picker's own predicate.
    r = await fetchJson('POST', `/camps/${campCap}/repartner`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: { partnered_blood_bank_id: hoSame },
    });
    assert(
      r.status === 400 && r.body.error === 'blood_bank_not_available',
      `a camp cannot be partnered to something that is not an active blood bank (${r.status})`,
    );

    // A blood bank cannot reassign a camp to itself. Collection responsibility
    // is the NGO's call, which is the whole reason this is not part of PATCH.
    r = await fetchJson('POST', `/camps/${campCap}/repartner`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { partnered_blood_bank_id: TEST.bbInst },
    });
    assert(r.status === 403, `a blood bank cannot re-partner a camp to itself (${r.status})`);

    // ── auto-accept, opt-in, and only inside published capacity ─────────────
    r = await fetchJson('PUT', '/camps/bb/settings', {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
      body: { auto_accept_within_capacity: true },
    });
    assert(
      r.status === 200 && r.body.settings?.auto_accept_within_capacity === true,
      `auto-accept is opt-in and can be turned on (${r.status})`,
    );

    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke Auto ${RUN_TAG}`, CAP_AUTO),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    const campAuto = r.body.camp_id;
    bbRow = await sql(
      `SELECT status, bb_response, bb_response_by, partnered_blood_bank_id
         FROM donation_camps WHERE id = $1`,
      [campAuto],
      'auto-accepted camp',
    );
    assert(
      r.status === 201 &&
        r.body.bb_response === 'AC' &&
        bbRow.rows[0]?.status === 'PE' &&
        bbRow.rows[0]?.bb_response_by === null &&
        bbRow.rows[0]?.partnered_blood_bank_id === TEST.bbInst,
      `inside published capacity the apply is auto-accepted, with no human attributed (${r.status}, ${String(r.body.bb_response)})`,
    );

    r = await fetchJson('POST', '/camps/apply', {
      body: {
        ...applyBody(`Camp Smoke AutoUnpub ${RUN_TAG}`, CAP_UNPUB),
        requested_blood_bank_id: TEST.bbInst,
      },
    });
    assert(
      r.status === 201 && r.body.bb_response === null,
      `auto-accept never fires on a day the BB has not published (${r.status}, ${String(r.body.bb_response)})`,
    );

    // ── the post-camp worklist: reachable without ever seeing a UUID ────────
    r = await fetchJson('GET', `/camps/${TEST.camp1}/donations`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    const work = r.body.donations || [];
    assert(
      r.status === 200 && work.length >= 2 && work.every((d) => d.donation_id && d.full_name),
      `the partnered BB reads its camp's donations with names decrypted (${r.status}, ${work.length} rows)`,
    );
    assert(
      work.every((d) => !d.mobile) && work.every((d) => /^\+91XXXXX\d{4}$/.test(d.mobile_masked)),
      'the tech matches a paper sheet on the last four digits — the raw mobile never leaves the DB',
    );

    r = await fetchJson('GET', `/camps/${TEST.camp1}/donations?pending=true`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    const pendingIds = (r.body.donations || []).map((d) => d.donor_id);
    assert(
      r.status === 200 && pendingIds.includes(DONORS.A.id) && !pendingIds.includes(DONORS.B.id),
      `?pending=true is the worklist: unscreened donor stays, verified donor drops off (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/${TEST.camp1}/donations`, {
      headers: { Authorization: `Bearer ${bb3Token}` },
    });
    assert(
      r.status === 403 && r.body.error === 'not_your_camp',
      `a blood bank with no stake in the camp reads none of its donations (${r.status})`,
    );

    // ── the PII regression 315 left open ───────────────────────────────────
    r = await fetchJson('GET', `/camps/${TEST.camp1}/registrations`, {
      headers: { Authorization: `Bearer ${bb3Token}` },
    });
    assert(
      r.status === 403 && r.body.error === 'not_your_camp',
      `an unrelated blood bank can no longer read ANY camp's donor roster (${r.status})`,
    );
    r = await fetchJson('GET', `/camps/${TEST.camp1}/registrations`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 200 && Array.isArray(r.body.registrations),
      `the camp's own blood bank still reads the roster it needs (${r.status})`,
    );

    console.log('── 16. organiser branding, and the gate in front of it ─────');

    // Migration 319. The organiser uploads a logo and one line of their own
    // words through their magic link; NOTHING reaches the public camp page
    // until an NGO admin approves it.
    //
    // Two fixture facts, both load-bearing:
    //
    //  1. camp1 is created 'PL' at line 415 but is shifted, PATCHed and closed
    //     by sections 3-13, so its status here is not knowable from reading
    //     section 1. GET /camps/public/:slug filters
    //     AND c.status IN ('PL','LV') and answers 404 camp_not_found otherwise -
    //     and a 404 body has no logo_data_uri, so an "absent" assertion would
    //     pass for entirely the wrong reason. Hence the UPDATE below, and hence
    //     every public assertion also asserts status 200.
    //
    //  2. Nothing else in this file exercises the organiser magic-link surface,
    //     so there is no token to borrow. loadToken() checks only revoked_at and
    //     expires_at - nothing about the camp - so a minted row is enough.
    await sql(
      `UPDATE donation_camps SET status = 'PL' WHERE id = $1`,
      [TEST.camp1],
      'camp smoke: publish camp1 for the branding gate',
    );
    const brandToken = `cmbrand${RUN_TAG}tokenaaaaaaaa`;
    await sql(
      `INSERT INTO camp_access_tokens (camp_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [TEST.camp1, brandToken],
      'camp smoke: mint an organiser magic token',
    );
    const brandSlug = (await sql(`SELECT slug FROM donation_camps WHERE id = $1`, [TEST.camp1]))
      .rows[0].slug;

    r = await fetchJson('GET', `/camps/access/${brandToken}`);
    assert(
      r.status === 200 && r.body.camp && r.body.camp.id === TEST.camp1,
      `the minted magic token opens the organiser dashboard (${r.status})`,
    );
    assert(
      !r.body.camp.branding_status && !r.body.camp.logo_data_uri,
      'a camp nobody has branded carries no branding_status and no logo',
    );

    // The four ways the upload route says no, and the ORDER they fire in:
    // content-type, then empty, then SIZE, then magic bytes. The size check
    // comes first, so the over-budget buffer below does not need to be a real
    // JPEG for 413 to be the reason it is refused - the two cases cannot mask
    // each other.
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const goodPng = Buffer.concat([PNG_SIG, Buffer.alloc(64, 0x20)]);

    r = await fetchRaw(
      'POST',
      `/camps/access/${brandToken}/logo-raw`,
      Buffer.from('GIF89a'),
      'image/gif',
    );
    assert(
      r.status === 415 && r.body.error === 'unsupported_media_type',
      `a type the route does not accept is 415, not a mismatch (${r.status})`,
    );

    r = await fetchRaw(
      'POST',
      `/camps/access/${brandToken}/logo-raw`,
      Buffer.alloc(0),
      'image/png',
    );
    assert(
      r.status === 400 && r.body.error === 'empty_body',
      `a zero-length body is refused before anything else (${r.status})`,
    );

    r = await fetchRaw(
      'POST',
      `/camps/access/${brandToken}/logo-raw`,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(60000)]),
      'image/jpeg',
    );
    assert(
      r.status === 413 && r.body.error === 'logo_too_large' && r.body.max_bytes === 50000,
      `60 KB is over the 50 KB decoded ceiling (${r.status} ${r.body.error})`,
    );

    // A .txt renamed .jpg. The raw body never passes through sanitizeInput
    // (that only walks strings), so this magic-byte test IS the validation.
    r = await fetchRaw(
      'POST',
      `/camps/access/${brandToken}/logo-raw`,
      Buffer.from('this is not a jpeg, it is a text file with a new name'),
      'image/jpeg',
    );
    assert(
      r.status === 400 && r.body.error === 'content_type_mismatch',
      `a text file declared image/jpeg is refused on its bytes (${r.status})`,
    );

    r = await fetchRaw('POST', `/camps/access/${brandToken}/logo-raw`, goodPng, 'image/png');
    assert(
      r.status === 200 &&
        r.body.bytes === goodPng.length &&
        r.body.content_type === 'image/png' &&
        r.body.branding_status === 'PE',
      `a real PNG lands and goes straight to PE (${r.status} ${r.body.branding_status})`,
    );
    // The caller already holds the bytes; echoing ~67 KB of base64 back would be
    // pure waste, and the dashboard re-reads GET /camps/access/:token anyway.
    assert(
      r.body.logo_data_uri === undefined,
      'the upload response never echoes the data URI back',
    );

    r = await fetchJson('GET', `/camps/public/${brandSlug}`);
    assert(
      r.status === 200 && !r.body.logo_data_uri,
      `a PE logo is invisible on the public camp page (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/access/${brandToken}`);
    assert(
      r.status === 200 && (r.body.camp.logo_data_uri || '').startsWith('data:image/png;base64,'),
      `the organiser sees their own PE upload (${r.status})`,
    );

    r = await fetchJson('PATCH', `/camps/access/${brandToken}/branding`, { body: {} });
    assert(
      r.status === 400 && r.body.error === 'nothing_to_update',
      `a branding PATCH with no tagline key changes nothing (${r.status})`,
    );

    r = await fetchJson('PATCH', `/camps/access/${brandToken}/branding`, {
      body: { tagline: 'Serving Amravati since 1985.' },
    });
    assert(
      r.status === 200 &&
        r.body.organiser_tagline === 'Serving Amravati since 1985.' &&
        r.body.branding_status === 'PE',
      `the organiser line saves and stays PE (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/public/${brandSlug}`);
    assert(
      r.status === 200 && !r.body.organiser_tagline,
      `the tagline rides the same gate as the logo (${r.status})`,
    );

    r = await fetchJson('POST', `/camps/${TEST.camp1}/branding/approve`, {
      headers: { Authorization: `Bearer ${TEST.bb1Token}` },
    });
    assert(
      r.status === 403 && r.body.error === 'forbidden',
      `a blood bank cannot approve what an organiser uploaded (${r.status})`,
    );

    r = await fetchJson('POST', `/camps/${TEST.camp1}/branding/approve`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
    });
    assert(
      r.status === 200 && r.body.camp.branding_status === 'AP',
      `the NGO side approves it (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/public/${brandSlug}`);
    assert(
      r.status === 200 &&
        (r.body.logo_data_uri || '').startsWith('data:image/png;base64,') &&
        r.body.organiser_tagline === 'Serving Amravati since 1985.',
      `approved branding is what the donor finally sees (${r.status})`,
    );

    r = await fetchJson('POST', `/camps/${TEST.camp1}/branding/approve`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
    });
    assert(
      r.status === 409 && r.body.error === 'no_branding_pending',
      `approving twice is a 409, not a silent no-op (${r.status})`,
    );

    // The invariant the whole gate rests on: an approved logo cannot be swapped
    // for something else behind the admin.
    r = await fetchJson('PATCH', `/camps/access/${brandToken}/branding`, {
      body: { tagline: 'Serving Amravati since 1985. Rotary Club.' },
    });
    assert(
      r.status === 200 && r.body.branding_status === 'PE',
      `an edit after approval goes straight back to PE (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/public/${brandSlug}`);
    assert(
      r.status === 200 && !r.body.logo_data_uri && !r.body.organiser_tagline,
      `and the already-approved LOGO leaves the public page with it (${r.status})`,
    );

    r = await fetchJson('POST', `/camps/${TEST.camp1}/branding/reject`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: {},
    });
    assert(
      r.status === 400 && r.body.error === 'invalid_input',
      `a rejection with no note is refused - migration 319 requires one (${r.status})`,
    );

    r = await fetchJson('POST', `/camps/${TEST.camp1}/branding/reject`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { note: 'Please upload the society logo, not a photo of a person.' },
    });
    assert(
      r.status === 200 && r.body.camp.branding_status === 'RJ',
      `a rejection with a note lands (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/access/${brandToken}`);
    assert(
      r.status === 200 &&
        r.body.camp.branding_status === 'RJ' &&
        r.body.camp.branding_review_note ===
          'Please upload the society logo, not a photo of a person.',
      `the organiser reads exactly why, word for word (${r.status})`,
    );

    r = await fetchJson('GET', `/camps/public/${brandSlug}`);
    assert(
      r.status === 200 && !r.body.logo_data_uri && !r.body.organiser_tagline,
      `rejected branding stays off the public page (${r.status})`,
    );

    // ── 17. a hard delete, and the four things that refuse it ────────────────
    console.log('');
    console.log('── 17. hard delete, guarded, and recorded in audit_log ─────');

    // The role gate. `coordinator` owns /cancel but is deliberately NOT granted
    // this one - the register is the NGO admin's. This file mints no ngo_admin
    // login, so saToken stands in for it (super_admin supersets ngo_admin
    // everywhere in this codebase) and coordToken proves the other side.
    r = await fetchJson('DELETE', `/camps/${TEST.camp3}`, {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: { reason: 'a coordinator must not be able to do this' },
    });
    assert(r.status === 403, `a coordinator cannot delete a camp (${r.status})`);

    r = await fetchJson('DELETE', `/camps/${TEST.camp3}`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { reason: 'no' },
    });
    assert(
      r.status === 400 && r.body.error === 'invalid_input',
      `a permanent removal cannot be unexplained - reason is mandatory (${r.status} ${r.body.error})`,
    );

    // 'CO' is asserted FIRST because the handler checks it first, and it has to:
    // camp2 is both completed AND carries a roster row, so a registrations-first
    // order would leave camp_is_completed unreachable from this fixture set.
    r = await fetchJson('DELETE', `/camps/${TEST.camp2}`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { reason: 'trying to erase an event that actually happened' },
    });
    assert(
      r.status === 409 && r.body.error === 'camp_is_completed',
      `a completed camp is a permanent record (${r.status} ${r.body.error})`,
    );

    r = await fetchJson('DELETE', `/camps/${TEST.camp1}`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { reason: 'trying to erase a camp donors signed up for' },
    });
    assert(
      r.status === 409 && r.body.error === 'camp_has_registrations' && r.body.count > 0,
      `donor RSVPs block the delete, and the count comes back so the modal can say how many (${r.status} ${r.body.error}/${r.body.count})`,
    );

    // A camp far enough out that no bb_camp_capacity row covers it - absence is
    // "not published", which never blocks - so this seeds cleanly whatever the
    // capacity sections above left behind.
    r = await fetchJson('POST', '/camps', {
      headers: { Authorization: `Bearer ${TEST.coordToken}` },
      body: campBody(`Camp Smoke Delete ${RUN_TAG}`, isoDay(90)),
    });
    if (r.status !== 201) throw new Error(`delete-target camp seed failed: ${r.status}`);
    const delCampId = r.body.id;
    const delCampName = r.body.name;
    const delToken = `cmdel${RUN_TAG}tokenaaaaaaaaaa`;
    await sql(
      `INSERT INTO camp_access_tokens (camp_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [delCampId, delToken],
      'camp smoke: magic token that must cascade away with the camp',
    );

    // donors.registration_camp_id is NO ACTION (033:80), so without this guard
    // the DELETE would surface a raw 23503 as a 500. Point a donor at the camp,
    // then unpoint them - which also proves the guard was the ONLY thing
    // standing in the way.
    await sql(`UPDATE donors SET registration_camp_id = $1 WHERE id = $2`, [
      delCampId,
      DONORS.E.id,
    ]);
    r = await fetchJson('DELETE', `/camps/${delCampId}`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { reason: 'trying to erase the camp that recruited someone' },
    });
    assert(
      r.status === 409 && r.body.error === 'camp_recruited_donors' && r.body.count === 1,
      `a camp that recruited a donor keeps its record (${r.status} ${r.body.error}/${r.body.count})`,
    );
    await sql(`UPDATE donors SET registration_camp_id = NULL WHERE id = $1`, [DONORS.E.id]);

    const delReason = 'duplicate test camp created twice by the same organiser';
    r = await fetchJson('DELETE', `/camps/${delCampId}`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { reason: delReason },
    });
    assert(
      r.status === 200 && r.body.deleted === true && r.body.name === delCampName,
      `a camp with nobody attached deletes, and names what went (${r.status} ${r.body.error || ''})`,
    );

    const goneRow = await sql(`SELECT id FROM donation_camps WHERE id = $1`, [delCampId]);
    assert(goneRow.rowCount === 0, 'the camp row is really gone, not just flagged');

    const goneTok = await sql(`SELECT camp_id FROM camp_access_tokens WHERE camp_id = $1`, [
      delCampId,
    ]);
    assert(
      goneTok.rowCount === 0,
      'the organiser magic link cascaded away with it (262:22 ON DELETE CASCADE)',
    );

    // This is the assertion the whole feature rests on: a hard DELETE on an
    // audited table is recoverable, because fn_audit_row() writes ONE row whose
    // old_value is the entire camp as JSON, attributed and explained. If this
    // ever fails, the delete button is no longer safe to ship.
    const auditRow = await sql(
      `SELECT change_reason, old_value, actor_role
         FROM audit_log
        WHERE table_name = 'donation_camps' AND record_id = $1 AND event_type = 'DELETE'`,
      [delCampId],
    );
    assert(
      auditRow.rowCount === 1 && (auditRow.rows[0].change_reason || '').includes(delReason),
      `audit_log holds one DELETE row carrying the admin's typed reason (${auditRow.rowCount} rows)`,
    );
    assert(
      (auditRow.rows[0]?.old_value || '').includes(delCampName),
      'that row carries the WHOLE deleted camp as JSON, so it can be reconstructed',
    );

    r = await fetchJson('DELETE', `/camps/${delCampId}`, {
      headers: { Authorization: `Bearer ${TEST.saToken}` },
      body: { reason: 'deleting the same camp twice' },
    });
    assert(
      r.status === 404 && r.body.error === 'not_found',
      `deleting it again is a clean 404, not a crash (${r.status} ${r.body.error})`,
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
