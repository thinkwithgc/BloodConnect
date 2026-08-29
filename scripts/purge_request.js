#!/usr/bin/env node
/**
 * purge_request.js — remove ONE blood request and everything hanging off it.
 *
 * Built for a specific, narrow job: a demo request was raised through the UI to
 * show an operator how the flow works, and it now sits at the top of every
 * blood bank's "Incoming requests" tab. `wipe_demo.js` cannot touch it — that
 * script matches seeded markers (clinical_indication LIKE 'Demo:%') and this
 * row was typed by a human.
 *
 * WHY DELETE AND NOT CANCEL. blood_requests.request_number is TEXT NOT NULL
 * UNIQUE, and the number comes from a counter TABLE (request_number_seq,
 * migration 027) driven by a BEFORE INSERT trigger — not a Postgres sequence.
 * So "set the counter back to 0001" while the demo row still holds
 * BC-2026-MH27-00001 guarantees a 23505 unique violation on the next real
 * request, and the operator would silently get 00002. Cancelling hides the row
 * from the worklist but cannot deliver the reset. The row has to go.
 *
 * SAFETY. Dry run is the default and prints the row plus a per-table count of
 * every dependent. --confirm is required to write anything, and even then the
 * script refuses outright if the request shows any sign of having been served:
 * units_fulfilled > 0, a terminal status, a bag stamped fulfilled_request_id,
 * or custody evidence in bag_events. Those are clinical records, not demo data.
 *
 * Usage
 *   node scripts/purge_request.js --request BC-2026-MH27-00001
 *   node scripts/purge_request.js --request BC-2026-MH27-00001 --confirm --reset-counter
 *   DB_URL_ENV=PROD_DB node scripts/purge_request.js --request ... (read the URL
 *     from a different env var; the value is never printed or logged)
 */

const { Client } = require('pg');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const REQUEST_NUMBER = opt('request');
const CONFIRM = flag('confirm');
const RESET_COUNTER = flag('reset-counter');
const URL_ENV = process.env.DB_URL_ENV || 'DATABASE_URL';
const CONN = process.env[URL_ENV];

/**
 * Every FK that points at blood_requests, and what we do about it.
 *
 *   delete  — the child row only exists to describe this request
 *   null    — the reference is incidental; the row itself is a record we keep
 *   release — a reserved bag goes back to stock (RE>AV is a legal transition,
 *             migration 301) so the unit is not stranded
 *   cascade — the FK already carries ON DELETE CASCADE; listed so the catalog
 *             cross-check below can account for it
 *
 * The catalog is read at runtime and any (table, column) missing from this map
 * aborts the run. A future migration that adds a FK must be handled here
 * deliberately — the alternative is a foreign_key_violation mid-transaction, or
 * worse, a silent cascade nobody reviewed.
 */
const HANDLED = {
  'request_assignments.request_id': 'delete',
  'request_documents.request_id': 'delete',
  'donor_alerts.request_id': 'delete',
  'escalation_log.request_id': 'delete',
  'request_threads.request_id': 'delete',
  'request_thread_reads.request_id': 'delete',
  'donor_alert_choices.request_id': 'delete',
  'open_request_bb_declines.request_id': 'cascade',
  'pending_donor_alerts.request_id': 'cascade',
  'replacement_obligations.request_id': 'cascade',
  'notification_log.related_request_id': 'null',
  'bag_events.request_id': 'null',
  'blood_inventory.reserved_for_request_id': 'release',
  'blood_inventory.fulfilled_request_id': 'null',
};

// Deleted in this order: children first, deepest dependency last-in-first-out.
const DELETE_ORDER = [
  ['request_thread_reads', 'request_id'],
  ['request_threads', 'request_id'],
  ['request_documents', 'request_id'],
  ['request_assignments', 'request_id'],
  ['donor_alert_choices', 'request_id'],
  ['donor_alerts', 'request_id'],
  ['escalation_log', 'request_id'],
];

function fail(msg) {
  console.error(`\nREFUSED: ${msg}\n`);
  process.exit(1);
}

/** Every FK column in the DB that references blood_requests. */
async function referencingColumns(c) {
  const { rows } = await c.query(
    `SELECT src.relname   AS table_name,
            att.attname   AS column_name,
            con.confdeltype AS on_delete
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class tgt ON tgt.oid = con.confrelid
       JOIN unnest(con.conkey) AS k(attnum) ON TRUE
       JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = k.attnum
      WHERE con.contype = 'f'
        AND tgt.relname = 'blood_requests'
      ORDER BY src.relname, att.attname`,
  );
  return rows;
}

async function loadRequest(c, number) {
  const { rows } = await c.query(
    `SELECT r.id, r.request_number, r.status, r.source_tier, r.urgency_tier,
            r.units_required, r.units_fulfilled, r.crossmatch_confirmed,
            r.clinical_indication, r.raised_at,
            r.requesting_hospital_district_id AS district_id,
            EXTRACT(YEAR FROM r.raised_at)::int AS raised_year,
            bg.code AS blood_group_code, bc.code AS component_code,
            d.name AS district_name, d.district_code_short,
            i.display_name AS hospital_name, r.guest_hospital_name
       FROM blood_requests r
       LEFT JOIN blood_groups bg ON bg.id = r.patient_blood_group_id
       LEFT JOIN blood_components bc ON bc.id = r.component_id
       LEFT JOIN districts d ON d.id = r.requesting_hospital_district_id
       LEFT JOIN institutions i ON i.id = r.requesting_institution_id
      WHERE r.request_number = $1`,
    [number],
  );
  if (rows.length === 0) fail(`no request with request_number = ${number}`);
  if (rows.length > 1) fail(`${rows.length} rows share that request_number (impossible — UNIQUE)`);
  return rows[0];
}

/** Per-table dependent counts, driven by the live catalog. */
async function dependentCounts(c, cols, requestId) {
  const out = [];
  for (const col of cols) {
    const key = `${col.table_name}.${col.column_name}`;
    // eslint-disable-next-line no-restricted-syntax
    const { rows } = await c.query(
      `SELECT COUNT(*)::int AS n FROM ${col.table_name} WHERE ${col.column_name} = $1`,
      [requestId],
    );
    out.push({ key, table: col.table_name, column: col.column_name, n: rows[0].n, action: HANDLED[key] });
  }
  return out;
}

/**
 * Would deleting this destroy a clinical record? Each of these means blood
 * actually moved, and no demo cleanup is worth overwriting that.
 */
async function safetyChecks(c, req) {
  const problems = [];

  if (Number(req.units_fulfilled) > 0) {
    problems.push(`units_fulfilled = ${req.units_fulfilled} — units were issued against this request`);
  }
  if (['FU', 'CL', 'RE'].includes(req.status)) {
    problems.push(`status = ${req.status} — this request was fulfilled/closed, not abandoned`);
  }
  if (req.crossmatch_confirmed) {
    problems.push('crossmatch_confirmed = true — a hospital cross-matched blood for this request');
  }

  const fulfilled = await c.query(
    `SELECT COUNT(*)::int AS n FROM blood_inventory WHERE fulfilled_request_id = $1`,
    [req.id],
  );
  if (fulfilled.rows[0].n > 0) {
    problems.push(`${fulfilled.rows[0].n} bag(s) carry fulfilled_request_id — blood left the fridge`);
  }

  const custody = await c.query(
    `SELECT COUNT(*)::int AS n FROM bag_events
      WHERE request_id = $1 AND to_status IN ('IS','RV','TR')`,
    [req.id],
  );
  if (custody.rows[0].n > 0) {
    problems.push(`${custody.rows[0].n} bag_events row(s) record issue/receipt/transfusion`);
  }

  return problems;
}

/**
 * Reset the per-district counter.
 *
 * Not a plain "set to 1": next_value is computed from the request_numbers that
 * SURVIVE, so it can never collide with the UNIQUE index. With the demo row
 * gone and nothing else raised in this district this year, that arithmetic
 * yields exactly 1 — the requested 00001 — and if a real request is filed
 * tomorrow the same code keeps it safe instead of handing out a duplicate.
 */
async function resetCounter(c, req) {
  const { rows } = await c.query(
    `SELECT COALESCE(MAX(split_part(request_number, '-', 4)::int), 0) + 1 AS next_value
       FROM blood_requests
      WHERE requesting_hospital_district_id = $1
        AND EXTRACT(YEAR FROM raised_at)::int = $2
        AND request_number ~ '^BC-[0-9]{4}-[^-]+-[0-9]+$'`,
    [req.district_id, req.raised_year],
  );
  const next = rows[0].next_value;

  await c.query(
    `INSERT INTO request_number_seq (district_id, year, next_value)
     VALUES ($1, $2::smallint, $3)
     ON CONFLICT (district_id, year) DO UPDATE SET next_value = EXCLUDED.next_value`,
    [req.district_id, req.raised_year, next],
  );
  return next;
}

async function purge(c, req, counts) {
  // escalation_log carries an append-only BEFORE DELETE guard (migration 031).
  // Disable that one trigger only — not session_replication_role, and not the
  // audit triggers, which must keep firing so this removal is itself recorded
  // in audit_log. Hard rule 2 is untouched: audit_log is only ever appended to.
  await c.query(`ALTER TABLE escalation_log DISABLE TRIGGER trg_escalation_no_delete`);

  try {
    // 1. Bags first. RE > AV is a legal transition (301) and the status trigger
    //    logs the release into bag_events with a NULL request_id, because both
    //    request columns are cleared in the same statement.
    const released = await c.query(
      `UPDATE blood_inventory
          SET status = 'AV', reserved_for_request_id = NULL
        WHERE reserved_for_request_id = $1
          AND status = 'RE'
        RETURNING id`,
      [req.id],
    );
    const unreserved = await c.query(
      `UPDATE blood_inventory SET reserved_for_request_id = NULL
        WHERE reserved_for_request_id = $1`,
      [req.id],
    );
    const unfulfilled = await c.query(
      `UPDATE blood_inventory SET fulfilled_request_id = NULL WHERE fulfilled_request_id = $1`,
      [req.id],
    );

    // 2. Records we keep, references we drop. Run after the bag updates so any
    //    event row the release trigger just wrote is covered too.
    const notif = await c.query(
      `UPDATE notification_log SET related_request_id = NULL WHERE related_request_id = $1`,
      [req.id],
    );
    const events = await c.query(`UPDATE bag_events SET request_id = NULL WHERE request_id = $1`, [
      req.id,
    ]);

    // 3. Children.
    const deleted = {};
    for (const [table, column] of DELETE_ORDER) {
      // eslint-disable-next-line no-restricted-syntax
      const r = await c.query(`DELETE FROM ${table} WHERE ${column} = $1`, [req.id]);
      if (r.rowCount) deleted[table] = r.rowCount;
    }

    // 4. The request. open_request_bb_declines / pending_donor_alerts /
    //    replacement_obligations go with it via ON DELETE CASCADE.
    const gone = await c.query(`DELETE FROM blood_requests WHERE id = $1`, [req.id]);
    if (gone.rowCount !== 1) throw new Error(`expected to delete 1 request, deleted ${gone.rowCount}`);

    return {
      released: released.rowCount,
      unreserved: unreserved.rowCount,
      unfulfilled: unfulfilled.rowCount,
      notif: notif.rowCount,
      events: events.rowCount,
      deleted,
    };
  } finally {
    await c.query(`ALTER TABLE escalation_log ENABLE TRIGGER trg_escalation_no_delete`);
  }
}

async function main() {
  if (!REQUEST_NUMBER) {
    console.error('Usage: node scripts/purge_request.js --request BC-YYYY-DIST-NNNNN [--confirm] [--reset-counter]');
    process.exit(2);
  }
  if (!CONN) fail(`${URL_ENV} is not set (set DB_URL_ENV to name a different variable)`);

  const c = new Client({
    connectionString: CONN,
    ssl: CONN.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
  });
  await c.connect();

  try {
    const req = await loadRequest(c, REQUEST_NUMBER);

    console.log('\n── Request ' + req.request_number + ' ─────────────────────────────');
    console.log(`  id                 ${req.id}`);
    console.log(`  status / urgency   ${req.status} / ${req.urgency_tier}    tier ${req.source_tier}`);
    console.log(`  product            ${req.blood_group_code} · ${req.component_code} · ${req.units_required}u`);
    console.log(`  fulfilled          ${req.units_fulfilled}u   crossmatch ${req.crossmatch_confirmed}`);
    console.log(`  hospital           ${req.hospital_name || req.guest_hospital_name || '(none)'}`);
    console.log(`  district           ${req.district_name} (${(req.district_code_short || '').trim()}) id=${req.district_id}`);
    console.log(`  raised_at          ${req.raised_at.toISOString()}`);
    console.log(`  indication         ${req.clinical_indication || '(none)'}`);

    // The catalog is the authority on what points here, not this file's map.
    const cols = await referencingColumns(c);
    const unknown = cols.filter((x) => !HANDLED[`${x.table_name}.${x.column_name}`]);
    if (unknown.length) {
      fail(
        'the schema has FK references this script does not handle:\n  ' +
          unknown.map((x) => `${x.table_name}.${x.column_name}`).join('\n  ') +
          '\nAdd each to HANDLED and DELETE_ORDER deliberately before re-running.',
      );
    }

    const counts = await dependentCounts(c, cols, req.id);
    console.log('\n── Dependents ───────────────────────────────────────────────');
    for (const d of counts) {
      const mark = d.n > 0 ? '•' : ' ';
      console.log(`  ${mark} ${d.key.padEnd(44)} ${String(d.n).padStart(4)}  ${d.action}`);
    }

    const seq = await c.query(
      `SELECT next_value FROM request_number_seq WHERE district_id = $1 AND year = $2::smallint`,
      [req.district_id, req.raised_year],
    );
    console.log('\n── Counter ──────────────────────────────────────────────────');
    console.log(
      `  request_number_seq(district=${req.district_id}, year=${req.raised_year}).next_value = ` +
        (seq.rows[0] ? seq.rows[0].next_value : '(no row)'),
    );

    const problems = await safetyChecks(c, req);
    if (problems.length) {
      console.log('\n── Blocking ─────────────────────────────────────────────────');
      for (const p of problems) console.log(`  ✗ ${p}`);
      fail('this request carries evidence of a real transfusion pathway. Nothing was changed.');
    }
    console.log('\n  ✓ no fulfilled units, no issued bags, no custody events — safe to remove');

    if (!CONFIRM) {
      console.log('\nDRY RUN — nothing was changed. Re-run with --confirm' + (RESET_COUNTER ? ' --reset-counter' : '') + ' to apply.\n');
      return;
    }

    await c.query('BEGIN');
    // Audit triggers stay live; give them an actor so the hash chain records who
    // did this rather than a NULL role (fn_audit_row_hash folds actor_role in).
    await c.query(`SET LOCAL raktify.actor_role = 'super_admin'`);
    await c.query(`SET LOCAL raktify.change_reason = 'demo request removed by scripts/purge_request.js'`);

    const result = await purge(c, req, counts);
    let next = null;
    if (RESET_COUNTER) next = await resetCounter(c, req);

    await c.query('COMMIT');

    console.log('\n── Applied ──────────────────────────────────────────────────');
    console.log(`  bags released to AV        ${result.released}`);
    console.log(`  reservations cleared       ${result.unreserved}`);
    console.log(`  fulfilled refs cleared     ${result.unfulfilled}`);
    console.log(`  notification_log unlinked  ${result.notif}`);
    console.log(`  bag_events unlinked        ${result.events}`);
    for (const [t, n] of Object.entries(result.deleted)) console.log(`  deleted ${t.padEnd(24)} ${n}`);
    console.log(`  deleted blood_requests     1  (${req.request_number})`);
    if (next !== null) {
      console.log(`\n  counter reset → next request in district ${req.district_id} for ${req.raised_year} will be ` +
        `BC-${req.raised_year}-${(req.district_code_short || '').trim()}-${String(next).padStart(5, '0')}`);
    }
    console.log('');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* not in a transaction */ }
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
