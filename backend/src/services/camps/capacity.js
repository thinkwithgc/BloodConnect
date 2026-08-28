/**
 * Blood-bank camp capacity — the single source of occupancy truth.
 *
 * This module exists so that the calendar the blood bank reads and the gate
 * that blocks an organiser's booking can never disagree. Two independent COUNT
 * queries in two handlers is exactly how you end up telling an organiser a day
 * is full while the BB's own calendar shows three free slots.
 *
 *   occupancyFor(client, bbId, from, to)  → Map<'YYYY-MM-DD', DayOccupancy>
 *   checkSlot(client, bbId, date)         → DayOccupancy (one day)
 *   nextOpenDates(client, bbId, from, n)  → ['YYYY-MM-DD', …]
 *   suggestedMaxCamps(settings)           → number | null
 *
 * ── The two counts, and why only one of them blocks ────────────────────────
 *
 *   confirmed  status IN ('PL','LV') AND partnered_blood_bank_id = bb
 *              A camp the NGO has verified and this BB is on the hook for.
 *              This is the number that blocks.
 *
 *   pending    status = 'PE' AND (partnered = bb OR requested = bb)
 *              Applications nobody has reviewed yet. Shown as a warning,
 *              NEVER blocking.
 *
 * Counting pending as occupancy would let one abandoned application — a
 * half-finished form from a college that changed its mind — block a day for
 * everyone else. Ignoring it entirely would let three organisers each be told
 * the last slot is free. So it is surfaced and not enforced, and the BB decides.
 *
 * ── Absence of a row means "not published", never "closed" ─────────────────
 *
 * published:false is the state of every date until a BB says otherwise, and an
 * unpublished date NEVER blocks (ok:true). On the day this ships no BB has
 * published anything; absence-as-closed would stop camp hosting platform-wide
 * for a live pilot. Callers must branch on `published`, not on `max_camps`.
 *
 * ── Dates only ────────────────────────────────────────────────────────────
 *
 * scheduled_date and capacity_date are both DATE. donation_camps.timezone
 * (default Asia/Kolkata) is irrelevant to a day-vs-day comparison, so there is
 * no timezone arithmetic anywhere in here. Keys are 'YYYY-MM-DD' strings —
 * never Date objects, which would reintroduce the timezone question through the
 * back door the moment one got serialised.
 */

// node-postgres returns DATE as a JS Date at local midnight. Formatting it with
// toISOString() would shift it a day for anyone east of UTC — which is
// everyone here. Read the local date parts instead.
function toIsoDate(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Every ISO date from `from` to `to` inclusive.
 *
 * The calendar and the public availability strip both need a row per day, gaps
 * included — a month grid with holes in it is worse than no grid. Walked with
 * UTC arithmetic on purpose: these are calendar labels, not instants, and
 * stepping a local-midnight Date across a DST boundary is how you lose a day.
 * India has no DST, but the server this runs on need not be in India.
 */
function datesBetween(from, to) {
  const out = [];
  const start = new Date(`${toIsoDate(from)}T00:00:00Z`);
  const end = new Date(`${toIsoDate(to)}T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function emptyDay(date) {
  return {
    date,
    published: false,
    max_camps: null,
    confirmed: 0,
    pending: 0,
    slots_left: null, // unknowable while unpublished — not Infinity, not 0
    note: null,
    staff_committed: null,
    ok: true, // unpublished never blocks
  };
}

function finalise(day) {
  if (!day.published) {
    day.slots_left = null;
    day.ok = true;
    return day;
  }
  day.slots_left = Math.max(0, day.max_camps - day.confirmed);
  day.ok = day.confirmed < day.max_camps;
  return day;
}

/**
 * Occupancy for every date in [fromDate, toDate], inclusive.
 *
 * Returns a Map keyed by 'YYYY-MM-DD' holding ONLY dates that have either a
 * capacity row or at least one camp. Callers walking a calendar month must
 * fill the gaps with emptyDay() — see dayOrEmpty().
 */
async function occupancyFor(client, bloodBankId, fromDate, toDate) {
  const days = new Map();

  const cap = await client.query(
    `SELECT capacity_date, max_camps, staff_committed, note
       FROM bb_camp_capacity
      WHERE blood_bank_id = $1
        AND capacity_date BETWEEN $2::date AND $3::date`,
    [bloodBankId, fromDate, toDate],
  );

  for (const r of cap.rows) {
    const date = toIsoDate(r.capacity_date);
    days.set(date, {
      ...emptyDay(date),
      published: true,
      max_camps: r.max_camps,
      staff_committed: r.staff_committed,
      note: r.note,
    });
  }

  // One pass over the camps, splitting confirmed from pending in SQL so the
  // definition of each lives in exactly one place.
  const camps = await client.query(
    `SELECT scheduled_date,
            COUNT(*) FILTER (
              WHERE status IN ('PL','LV') AND partnered_blood_bank_id = $1
            ) AS confirmed,
            COUNT(*) FILTER (
              WHERE status = 'PE'
                AND (partnered_blood_bank_id = $1 OR requested_blood_bank_id = $1)
            ) AS pending
       FROM donation_camps
      WHERE scheduled_date BETWEEN $2::date AND $3::date
        AND (partnered_blood_bank_id = $1 OR requested_blood_bank_id = $1)
      GROUP BY scheduled_date`,
    [bloodBankId, fromDate, toDate],
  );

  for (const r of camps.rows) {
    const date = toIsoDate(r.scheduled_date);
    const day = days.get(date) || emptyDay(date);
    day.confirmed = Number(r.confirmed) || 0;
    day.pending = Number(r.pending) || 0;
    days.set(date, day);
  }

  for (const day of days.values()) finalise(day);
  return days;
}

/** A day from an occupancy Map, or a fresh unpublished one. */
function dayOrEmpty(days, date) {
  return days.get(date) || emptyDay(date);
}

/**
 * One day, for the booking gate. Same shape as an occupancyFor() entry, so the
 * gate and the calendar are reading the identical structure.
 */
async function checkSlot(client, bloodBankId, date) {
  const iso = toIsoDate(date);
  if (!iso) return emptyDay(null);
  const days = await occupancyFor(client, bloodBankId, iso, iso);
  return dayOrEmpty(days, iso);
}

/**
 * The next `limit` dates this BB can still take a camp on, starting at
 * `fromDate`. Used to turn a 409 into something actionable — an organiser told
 * "the 14th is full" with no alternative just picks up the phone, which is the
 * behaviour this whole feature exists to remove.
 *
 * Only PUBLISHED, non-full days count. An unpublished day is not offered as an
 * alternative even though it would not block: suggesting a day the BB has not
 * committed to would manufacture exactly the false confidence the capacity
 * calendar removes.
 */
async function nextOpenDates(client, bloodBankId, fromDate, limit = 5, horizonDays = 92) {
  const { rows } = await client.query(
    `WITH cap AS (
       SELECT capacity_date, max_camps
         FROM bb_camp_capacity
        WHERE blood_bank_id = $1
          AND capacity_date >= $2::date
          AND capacity_date <= $2::date + ($3 || ' days')::interval
          AND max_camps > 0
     ),
     used AS (
       SELECT scheduled_date, COUNT(*) AS confirmed
         FROM donation_camps
        WHERE partnered_blood_bank_id = $1
          AND status IN ('PL','LV')
          AND scheduled_date >= $2::date
        GROUP BY scheduled_date
     )
     SELECT cap.capacity_date
       FROM cap
       LEFT JOIN used ON used.scheduled_date = cap.capacity_date
      WHERE COALESCE(used.confirmed, 0) < cap.max_camps
      ORDER BY cap.capacity_date
      LIMIT $4`,
    [bloodBankId, toIsoDate(fromDate), String(horizonDays), limit],
  );
  return rows.map((r) => toIsoDate(r.capacity_date));
}

/**
 * floor(staff_total / staff_per_camp) — the number the calendar header offers
 * as a suggestion. Advisory only: max_camps is what the BB actually commits to,
 * and a BB borrowing techs from another branch is never held to this figure.
 */
function suggestedMaxCamps(settings) {
  const total = Number(settings?.staff_total);
  const per = Number(settings?.staff_per_camp);
  if (!Number.isFinite(total) || !Number.isFinite(per) || per <= 0) return null;
  return Math.floor(total / per);
}

module.exports = {
  occupancyFor,
  dayOrEmpty,
  emptyDay,
  checkSlot,
  nextOpenDates,
  suggestedMaxCamps,
  toIsoDate,
  datesBetween,
};
