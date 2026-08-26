/**
 * camp_close_roster — daily at 02:10 IST. Closes the roster of camps that are
 * safely past, turning whoever is still 'RG' into 'NS'.
 *
 * Nobody marks a no-show by hand any more. Attendance derives from the donation
 * the blood bank records against the camp (migration 314), so "did not come" is
 * simply what is left over once the camp is far enough behind us that no more
 * donations are going to arrive for it.
 *
 * THE 48-HOUR GRACE IS THE WHOLE DESIGN. Blood banks routinely batch-enter a
 * camp's donations the next morning, so the predicate is
 * `scheduled_date < CURRENT_DATE - 1` — a camp held yesterday is untouched, one
 * held two days ago is closed. A same-night flip would mark an entire roster
 * absent hours before the data arrived. Even then this is self-healing rather
 * than load-bearing: migration 314's upsert overwrites 'NS' with 'AT', so a
 * donation entered a week late still corrects the record. The grace only avoids
 * a day or two of wrong reports.
 *
 * WHICH CAMPS. Not 'CA' or 'DC' (they never happened) and not 'PE' (an
 * unreviewed public application). That leaves PL / LV / CO — deliberately the
 * same set as COLLECTABLE_STATUSES in services/donations/camp.js: while a
 * donation can still be attributed to a camp, its roster is still live. Note
 * nothing in the app transitions PL → LV today, and organisers frequently never
 * click Complete (that is exactly why the admin stale-camp queue exists), so
 * gating on CO alone would mean this job almost never ran.
 *
 * AND WHY 'CO' OR EVIDENCE. A past-dated 'PL' camp with nothing recorded
 * against it is ambiguous: it may have been quietly abandoned rather than held,
 * and marking forty people absent for a camp that never happened is a real
 * harm — 'NS' is the value that will eventually cost a donor standing once
 * donors.reliability_score is wired, which is the same reason migration 312
 * separated 'DF' from it. So a roster closes when a human has said the camp
 * happened (status 'CO') or when the camp left a trace that it did (at least
 * one 'AT' or 'DF' registration). Otherwise it is left alone and stays in the
 * admin stale-camp queue for someone to complete or cancel.
 *
 * No notification. Telling a donor "you were marked absent" from a batch job
 * is a message we would not want to send on evidence this indirect.
 */
const { withRlsContextRaw } = require('../../../middleware/rlsContext');

async function run() {
  return withRlsContextRaw(
    { actor_role: 'system', change_reason: 'camp_close_roster: past-camp RG → NS' },
    async (c) => {
      const r = await c.query(
        `UPDATE camp_registrations cr
            SET status = 'NS',
                status_changed_at = clock_timestamp()
           FROM donation_camps c
          WHERE cr.camp_id = c.id
            AND cr.status = 'RG'
            AND c.status IN ('PL', 'LV', 'CO')
            AND c.scheduled_date < CURRENT_DATE - 1
            AND (
              c.status = 'CO'
              OR EXISTS (SELECT 1 FROM camp_registrations e
                          WHERE e.camp_id = c.id
                            AND e.status IN ('AT', 'DF'))
            )
        RETURNING cr.id, cr.camp_id, cr.donor_id, c.slug AS camp_slug,
                  to_char(c.scheduled_date, 'YYYY-MM-DD') AS scheduled_date`,
      );

      const camps = new Set(r.rows.map((row) => row.camp_id));
      return {
        marked_no_show: r.rowCount,
        camps_closed: camps.size,
        sample: r.rows.slice(0, 5),
      };
    },
  );
}

module.exports = {
  run,
  name: 'camp_close_roster',
  // 02:10, not 02:00 — auto_expire and the retention purge already sit on the
  // midnight/round-hour marks and this reads the same rows the camp reminder
  // jobs do.
  cron: '10 2 * * *',
  description:
    'Close rosters of past camps: donors still RG 48h after the camp become NS (never marked by hand)',
};
