// One place where "today" is computed, and where an ISO date is shifted.
//
// Every date field in this app is a CALENDAR LABEL, never an instant: a donor's
// date_of_birth, a camp's scheduled_date and bb_camp_capacity.capacity_date are
// all Postgres DATE columns, and <input type="date"> exchanges 'YYYY-MM-DD'
// strings. So nothing here goes near toISOString() on a local Date — that
// shifts the day for anyone east of UTC, which is everyone this platform
// serves. Same reasoning and the same shape as toIsoDate() in
// backend/src/services/camps/capacity.js.
//
// "Today" is read in IST explicitly rather than from the device clock. A demo
// laptop left on UTC would otherwise render yesterday as the earliest bookable
// camp date, and a donor registering just after midnight would be offered a
// year list one day out of step with the age CHECK the server applies.

const IST = 'Asia/Kolkata';

const istParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: IST,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const pad = (n) => String(n).padStart(2, '0');

/** Today in IST as 'YYYY-MM-DD'. */
export function todayISO() {
  const p = {};
  for (const part of istParts.formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Days in month `m` (1-12) of year `y`. Day 0 of the next month = last of this. */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * `from` (default today) shifted by whole days. UTC arithmetic on purpose:
 * these are labels, not instants, and stepping a local-midnight Date across a
 * DST boundary loses a day. India has no DST; the browser need not be in India.
 */
export function isoOffsetDays(days, from) {
  const d = new Date(`${from || todayISO()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * `from` (default today) shifted by whole years, with the day CLAMPED into the
 * target month rather than rolled forward.
 *
 * This matters for exactly one date a year. 29 Feb minus 18 years lands on a
 * date that does not exist; JS would roll it to 1 Mar, which as an upper bound
 * would admit someone a day short of eighteen. Clamping to 28 Feb keeps the
 * bound on the safe side of the donors.age_min CHECK it mirrors.
 */
export function isoOffsetYears(years, from) {
  const [y, m, d] = (from || todayISO()).split('-').map(Number);
  const y2 = y + years;
  return `${y2}-${pad(m)}-${pad(Math.min(d, daysInMonth(y2, m)))}`;
}

/** A 'YYYY-MM' month shifted by whole months. */
export function shiftMonth(ym, n) {
  const [y, m] = String(ym).split('-').map(Number);
  const zero = y * 12 + (m - 1) + n;
  return `${Math.floor(zero / 12)}-${pad((zero % 12) + 1)}`;
}

/** The 'YYYY-MM' an ISO date belongs to. */
export function monthOf(iso) {
  return String(iso || todayISO()).slice(0, 7);
}

/** Every ISO date in a 'YYYY-MM' month, in order. */
export function monthDates(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const out = [];
  for (let d = 1; d <= daysInMonth(y, m); d += 1) out.push(`${y}-${pad(m)}-${pad(d)}`);
  return out;
}

/** ISO day-of-week for an ISO date: 0 = Sunday .. 6 = Saturday. */
export function isoDow(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/**
 * The ISO day a value from the API denotes.
 *
 * A Postgres DATE arrives as JSON having gone through a JS Date, so
 * scheduled_date is '2026-09-14T00:00:00.000Z' from a UTC server and
 * '2026-09-13T18:30:00.000Z' from an IST one — the same calendar day, written
 * two ways. Reading the LOCAL parts back out recovers the day in both cases,
 * which is what fmtDate() already relies on to render it. Same contract as
 * toIsoDate() in backend/src/services/camps/capacity.js: a plain 'YYYY-MM-DD'
 * passes through untouched, so a capacity row and a camp row key alike.
 */
export function localDayKey(value) {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
