/**
 * The blood bank's own camp calendar, as the organiser sees it BEFORE applying.
 *
 * The founder's ask, verbatim: an organiser "should be able to see the
 * available slots for each date so they can plan accordingly", and "keep watch
 * on the dates if they are planning but not registering that the number of
 * slots are getting booked". So this is a browsable month grid, not a verdict
 * on one date — it is useful to someone who has picked no date at all, and it
 * is re-checkable next week without filling the form in again.
 *
 * ── What it may show ──────────────────────────────────────────────────────
 *
 * COUNTS ONLY. GET /camps/bb-availability is public and deliberately returns
 * no camp id, name, venue, organiser, target or note — a note can name a
 * person ("2 techs on leave"). Never render a field this endpoint does not
 * return, and never reach for a second endpoint to enrich a cell.
 *
 * ── The three day-states, and only one of them blocks ──────────────────────
 *
 *   published:false   NOT PLANNED. The blood bank has said nothing about this
 *                     day. It does not block, and it must not read as closed —
 *                     absence-as-closed would make every date on a fresh
 *                     calendar look shut. Branch on `published`, never on
 *                     `max_camps` (migration 316's header).
 *   max_camps === 0   Closed by choice. This IS the holiday — there is no
 *                     blackout table.
 *   slots_left        n free of max_camps. 0 means full for the day.
 *
 * `pending` is applications nobody has reviewed yet. Shown as a warning and it
 * NEVER blocks: one abandoned form from a college that changed its mind must
 * not hold a day hostage. That asymmetry is decided in
 * backend/src/services/camps/capacity.js and only surfaced here.
 *
 * ── It must never stop anyone applying ────────────────────────────────────
 *
 * A failed fetch renders nothing at all, so the form behaves exactly as it did
 * before this existed, and the real gate — the 409 on POST /camps/apply — still
 * catches a genuine clash. Picking a full day here is allowed too: the NGO team
 * confirms the blood bank at review, and a hard block in the browser would turn
 * a soft, overridable rule into a dead end.
 */
import { useEffect, useMemo, useState } from 'react';

import { apiRequest } from '../../lib/api.js';
import {
  isoDow,
  isoOffsetDays,
  monthDates,
  monthOf,
  shiftMonth,
  todayISO,
} from '../../lib/dateBounds.js';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// 90 days: inside the endpoint's 92-day cap, and past the horizon anyone books
// a camp on. Fetched once per blood bank and sliced by month in the browser, so
// paging months is instant and costs no requests.
const HORIZON_DAYS = 90;

function monthLabel(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
  });
}

/** "Sat 14 Sep" — the weekday matters, a working Tuesday is a different camp. */
function fmtDay(iso) {
  if (!iso) return '';
  try {
    return new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

/**
 * How one cell reads. Order matters: `published` is tested before `max_camps`,
 * so an unplanned day can never be mistaken for a closed one.
 */
function cellState(day) {
  if (!day || !day.published) {
    return {
      kind: 'unplanned',
      label: '—',
      cls: 'border-slate-200 bg-white text-slate-400',
      title: 'Not planned yet — you can still ask for this day',
    };
  }
  if (day.max_camps === 0) {
    return {
      kind: 'closed',
      label: 'Closed',
      cls: 'border-slate-300 bg-slate-100 text-slate-500',
      title: 'The blood bank is closed for camps this day',
    };
  }
  if (day.slots_left === 0) {
    return {
      kind: 'full',
      label: 'Full',
      cls: 'border-rk-200 bg-rk-50 text-rk-700',
      title: `All ${day.max_camps} camp slots are taken`,
    };
  }
  return {
    kind: 'free',
    label: `${day.slots_left} free`,
    cls: 'border-green-200 bg-green-50 text-green-800',
    title: `${day.confirmed} of ${day.max_camps} slots booked`,
  };
}

export function BbAvailabilityCalendar({ bloodBankId, date, dayFull, onPickDate }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);
  const today = todayISO();
  const lastDay = isoOffsetDays(HORIZON_DAYS);
  const firstMonth = monthOf(today);
  const lastMonth = monthOf(lastDay);
  // Opens on the month of the date already chosen, so someone editing an
  // application lands where they left off rather than on today.
  const [month, setMonth] = useState(() => {
    const m = monthOf(date || today);
    return m < firstMonth || m > lastMonth ? firstMonth : m;
  });

  useEffect(() => {
    if (!bloodBankId) {
      setData(null);
      setFailed(false);
      return undefined;
    }
    let live = true;
    setData(null);
    setFailed(false);
    apiRequest(
      'GET',
      `/camps/bb-availability?blood_bank_id=${bloodBankId}&from=${today}&to=${lastDay}`,
    )
      .then((r) => {
        if (live) setData(r);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bloodBankId]);

  const byDate = useMemo(() => {
    const m = new Map();
    for (const d of data?.days || []) m.set(d.date, d);
    return m;
  }, [data]);

  // See the header: never block the form on this component's own failure.
  if (failed) return null;

  const days = data?.days || [];
  const open = days.filter((d) => d.published && d.ok && d.max_camps > 0);
  const chosen = date ? byDate.get(date) || null : null;
  const grid = monthDates(month);
  const lead = isoDow(grid[0]);

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-700">
          {data?.blood_bank_name || 'This blood bank'} — free camp slots
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-600 disabled:opacity-40"
            disabled={month <= firstMonth}
            onClick={() => setMonth(shiftMonth(month, -1))}
            aria-label="Previous month"
          >
            ‹
          </button>
          <span className="min-w-[9rem] text-center text-sm font-medium text-slate-700">
            {monthLabel(month)}
          </span>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-slate-600 disabled:opacity-40"
            disabled={month >= lastMonth}
            onClick={() => setMonth(shiftMonth(month, 1))}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      </div>

      {!data ? (
        <p className="mt-2 text-slate-500">Checking their calendar…</p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-7 gap-1">
            {WEEKDAYS.map((w, i) => (
              <div
                key={`${w}${i}`}
                className="pb-1 text-center text-[11px] font-medium uppercase text-slate-400"
              >
                {w}
              </div>
            ))}
            {Array.from({ length: lead }, (_, i) => (
              <div key={`lead${i}`} />
            ))}
            {grid.map((iso) => {
              // Outside the fetched window: rendered, greyed, unclickable. A
              // month with holes in it is harder to read than one with edges.
              if (iso < today || iso > lastDay) {
                return (
                  <div
                    key={iso}
                    className="rounded-md border border-transparent p-1 text-center text-slate-300"
                  >
                    <div className="text-xs">{Number(iso.slice(8))}</div>
                  </div>
                );
              }
              const day = byDate.get(iso);
              const st = cellState(day);
              const picked = iso === date;
              return (
                <button
                  key={iso}
                  type="button"
                  title={st.title}
                  onClick={() => onPickDate(iso)}
                  className={
                    `rounded-md border p-1 text-center transition hover:brightness-95 ${st.cls}` +
                    (picked ? ' ring-2 ring-rk-700 ring-offset-1' : '')
                  }
                >
                  <div className="text-xs font-semibold">{Number(iso.slice(8))}</div>
                  <div className="text-[10px] leading-tight">{st.label}</div>
                  {/* Pending applications: a warning, never a block. */}
                  {day?.pending ? (
                    <div className="text-[10px] leading-tight text-amber-700">
                      +{day.pending}?
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-green-200" />
              free
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-rk-200" />
              full
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-slate-200" />
              closed
            </span>
            <span>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm border border-slate-300 bg-white" />
              not planned yet
            </span>
            <span className="text-amber-700">+n? = applications being reviewed</span>
          </div>
        </>
      )}

      {/* The verdict on the day actually chosen. The grid above says what every
          day is; this says what it means for THIS application, which is the one
          thing a colour cannot. The 409 branch wins when present — the backend
          refused for real, and its counts are the authoritative ones. */}
      {!data ? null : dayFull ? (
        <p className="mt-2 font-medium text-rk-700">
          Fully booked on {fmtDay(dayFull.scheduled_date)} — {dayFull.confirmed} of{' '}
          {dayFull.max_camps} camps already taken. Pick another day above.
        </p>
      ) : chosen && chosen.published && chosen.max_camps === 0 ? (
        <p className="mt-2 font-medium text-rk-700">
          They are closed for camps on {fmtDay(chosen.date)}. Pick another day above.
        </p>
      ) : chosen && chosen.published && !chosen.ok ? (
        <p className="mt-2 font-medium text-amber-700">
          Already full on {fmtDay(chosen.date)} — {chosen.confirmed} of {chosen.max_camps}{' '}
          camps taken. Pick another day above.
        </p>
      ) : chosen && chosen.published ? (
        <p className="mt-2 text-green-800">
          Room on {fmtDay(chosen.date)} — {chosen.slots_left} of {chosen.max_camps} slots
          still free.
          {chosen.pending
            ? ` ${chosen.pending} other application for that day is being reviewed.`
            : ''}
        </p>
      ) : chosen ? (
        <p className="mt-2 text-slate-600">
          They have not published a plan for {fmtDay(chosen.date)} yet. Go ahead — our team
          confirms it with them when we review your application.
        </p>
      ) : (
        <p className="mt-2 text-slate-600">Tap a day to choose it as your camp date.</p>
      )}

      {/* Suggested days, one tap each. Shown only when the chosen day will not
          work — offering alternatives to someone whose date is already fine just
          invites second-guessing. The backend's own next_open_dates beat
          anything worked out here: they were computed at the moment of the
          refusal. Published, non-full days only — a day the blood bank has not
          committed to is not an assurance to hand out. */}
      {dayFull || (chosen && chosen.published && !chosen.ok) ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {(dayFull?.next_open_dates?.length
            ? dayFull.next_open_dates
            : open.map((d) => d.date)
          )
            .slice(0, 6)
            .map((d) => (
              <button
                key={d}
                type="button"
                className="rounded-full border border-rk-700 px-3 py-1 text-xs font-medium text-rk-700 hover:bg-rk-50"
                onClick={() => onPickDate(d)}
              >
                {fmtDay(d)}
              </button>
            ))}
        </div>
      ) : null}

      <p className="mt-2 text-xs text-slate-500">
        You can still apply for any date. Our NGO team confirms the blood bank before the
        camp is published.
      </p>
    </div>
  );
}
