import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

/**
 * The institution register: every hospital and blood bank on the platform, and
 * the two dates that decide whether it may legally still operate.
 *
 * This tab exists because onboarding was the only place an institution was ever
 * looked at, and onboarding ends. A renewed CDSCO licence, a moved hospital, a
 * changed contact person, a lapsed MoU — none of it had a home, so the register
 * drifted out of date with nobody able to see that it had. Licence and MoU
 * expiry are therefore columns here rather than details one click in: an expiry
 * you have to go looking for is an expiry you hear about from an inspector.
 *
 * Status filtering is server-side (the list endpoint's existing ?status=); the
 * text search is client-side because the register is a district at a time, well
 * inside the endpoint's cap.
 */

const STATUS_FILTERS = [
  { id: '', label: 'All' },
  { id: 'AC', label: 'Active' },
  { id: 'PE', label: 'Pending review' },
  { id: 'VE', label: 'Awaiting MoU' },
  { id: 'SU', label: 'Suspended' },
  { id: 'AR', label: 'Archived' },
];

const STATUS_META = {
  PE: { label: 'Pending review', cls: 'bg-slate-100 text-slate-700' },
  VE: { label: 'Awaiting paper MoU', cls: 'bg-amber-100 text-amber-900' },
  AC: { label: 'Active', cls: 'bg-green-100 text-green-800' },
  SU: { label: 'Suspended', cls: 'bg-amber-100 text-amber-900' },
  AR: { label: 'Archived', cls: 'bg-rk-50 text-rk-800' },
};

const KIND_LABEL = { HO: 'Hospital', BB: 'Blood bank' };

// India-only platform, so "today" is today in IST, not UTC — same reasoning as
// istToday() in OnboardingDetail. IST has no DST so the offset is exact. Both
// expiry columns arrive as 'YYYY-MM-DD' text (the server casts the DATE with
// to_char precisely so no timezone can shift a legal date), which makes a plain
// string comparison correct and avoids re-introducing the off-by-one-day bug.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(`${v}T00:00:00Z`).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(v);
  }
}

/**
 * Bands an expiry date: red once it has passed, amber inside 90 days — long
 * enough to actually chase a renewal through a government office, which is the
 * point of warning early rather than accurately.
 */
function ExpiryCell({ date, today, soon }) {
  if (!date) return <span className="text-slate-400">—</span>;
  const lapsed = date < today;
  const near = !lapsed && date <= soon;
  const cls = lapsed
    ? 'text-rk-700 font-semibold'
    : near
      ? 'text-amber-700 font-medium'
      : 'text-slate-700';
  return (
    <span className={cls}>
      {fmtDate(date)}
      {lapsed ? <span className="ml-1 text-xs">lapsed</span> : null}
      {near ? <span className="ml-1 text-xs">expiring</span> : null}
    </span>
  );
}

export function InstitutionsTab() {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');

  const listQ = useQuery({
    queryKey: ['admin', 'institutions', { status }],
    queryFn: () => apiRequest('GET', `/institutions${status ? `?status=${status}` : ''}`),
    staleTime: 15_000,
  });

  const today = istToday();
  const soon = addDays(today, 90);

  const all = listQ.data?.institutions || [];

  // Resolve a child's parent so a paired hospital + in-house blood bank reads as
  // one organisation instead of two rows that happen to sit near each other.
  const parentOf = useMemo(() => {
    const byId = new Map(all.map((i) => [i.id, i]));
    return (row) => (row.parent_institution_id ? byId.get(row.parent_institution_id) : null);
  }, [all]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((i) =>
      [i.display_name, i.legal_name, i.shortname, i.district_name]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)),
    );
  }, [all, q]);

  // Only active institutions are worth warning about — a pending application has
  // no licence obligation yet, and an archived one has stopped operating.
  const attention = useMemo(
    () =>
      all.filter(
        (i) =>
          i.onboarding_status === 'AC' &&
          ((i.cdsco_licence_expires && i.cdsco_licence_expires <= soon) ||
            (i.mou_expires_at && i.mou_expires_at <= soon)),
      ),
    [all, soon],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Institutions</h2>
        <p className="text-sm text-slate-600">
          Every hospital and blood bank on the platform. Open one to correct its details, manage
          its staff logins, or read what has been changed and why.
        </p>
      </div>

      {attention.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            {attention.length} active institution{attention.length === 1 ? '' : 's'} with a licence
            or MoU expiring inside 90 days
          </p>
          <p className="mt-1 text-xs">
            A blood bank operating on a lapsed CDSCO licence is the platform's exposure as much as
            theirs. Chase the renewal, then record the new expiry on the institution — the change
            is logged against your username with your reason.
          </p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.id || 'all'}
            type="button"
            className={pillCls(status === f.id)}
            onClick={() => setStatus(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="max-w-md">
        <label className="rk-label" htmlFor="inst-q">
          Search
        </label>
        <input
          id="inst-q"
          className="rk-input"
          placeholder="name, shortname or district"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {listQ.isLoading ? <div className="rk-card">Loading…</div> : null}
      {listQ.error ? (
        <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
          {listQ.error?.response?.data?.error || 'load_failed'}
        </div>
      ) : null}

      {listQ.data ? (
        <>
          <p className="text-xs text-slate-500">
            {rows.length} of {all.length} institution{all.length === 1 ? '' : 's'}
            {status ? ' in this status' : ''}.
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Institution</th>
                  <th className="px-3 py-2">District</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">CDSCO licence</th>
                  <th className="px-3 py-2">MoU</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.length === 0 ? (
                  <tr>
                    <td className="px-3 py-4 text-slate-500" colSpan={6}>
                      No institutions match.
                    </td>
                  </tr>
                ) : null}
                {rows.map((i) => {
                  const parent = parentOf(i);
                  const meta = STATUS_META[i.onboarding_status] || {
                    label: i.onboarding_status,
                    cls: 'bg-slate-100 text-slate-700',
                  };
                  return (
                    <tr
                      key={i.id}
                      className={i.onboarding_status === 'AR' ? 'bg-slate-50/60' : undefined}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-900">
                          {i.display_name || i.legal_name}
                        </div>
                        <div className="font-mono text-xs text-slate-500">
                          @{i.shortname} · {KIND_LABEL[i.kind] || i.kind}
                        </div>
                        {parent ? (
                          <div className="text-xs text-slate-500">
                            in-house blood bank of @{parent.shortname}
                          </div>
                        ) : null}
                        {i.has_inhouse_blood_bank ? (
                          <div className="text-xs text-slate-500">has an in-house blood bank</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{i.district_name || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {i.kind === 'BB' || i.cdsco_licence_expires ? (
                          <ExpiryCell date={i.cdsco_licence_expires} today={today} soon={soon} />
                        ) : (
                          <span className="text-xs text-slate-400">n/a</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <ExpiryCell date={i.mou_expires_at} today={today} soon={soon} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          to={`/admin/institutions/${i.id}`}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

function pillCls(active) {
  return (
    'rounded-full border px-3 py-1 text-sm font-medium ' +
    (active
      ? 'border-rk-700 bg-rk-50 text-rk-900'
      : 'border-slate-300 text-slate-600 hover:bg-slate-50')
  );
}
