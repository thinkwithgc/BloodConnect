import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

const GRID_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const URG = {
  CR: { label: 'Critical', cls: 'bg-rk-700 text-white' },
  UR: { label: 'Urgent', cls: 'bg-amber-500 text-white' },
  PL: { label: 'Planned', cls: 'bg-slate-300 text-slate-800' },
};

const STATUS_LABEL = {
  CL: 'Closed',
  FU: 'Fulfilled',
  EX: 'Expired',
  CA: 'Cancelled',
};

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch {
    return String(v);
  }
}

function fmtDuration(seconds) {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} h` : `${h} h ${rem} m`;
}

function KpiCard({ label, value, tone, hint }) {
  return (
    <div className="rk-card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={'mt-1 text-3xl font-bold ' + (tone || 'text-slate-900')}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-slate-400">{hint}</div> : null}
    </div>
  );
}

function fmtExpiryLabel(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  const now = Date.now();
  if (t <= now) return 'expired';
  const hours = Math.round((t - now) / 3_600_000);
  if (hours < 48) return `${hours}h left`;
  const days = Math.round(hours / 24);
  return `${days}d left`;
}

function PendingBbAdminPanel() {
  const [copied, setCopied] = useState(false);

  const q = useQuery({
    queryKey: ['hospital', 'pending-bb-admin'],
    queryFn: () => apiRequest('GET', '/hospital/pending-bb-admin'),
    // Poll gently so once the BB admin consumes their token the panel
    // disappears without a page refresh.
    staleTime: 60_000,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  const resend = useMutation({
    mutationFn: () => apiRequest('POST', '/hospital/pending-bb-admin/resend'),
  });

  if (!q.data?.pending) return null;
  const d = q.data;

  return (
    <article className="rk-card border border-amber-300 bg-amber-50">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-900">
        In-house blood bank — activate BB admin
      </h2>
      <p className="mt-1 text-sm text-amber-900">
        Your blood bank <strong>{d.child_institution.display_name}</strong> is provisioned but
        its admin hasn't set a password yet. Share this activation link with the BB team, or
        resend to your registered WhatsApp number.
      </p>
      <div className="mt-3 space-y-2 text-sm">
        <div>
          <span className="text-xs uppercase tracking-wide text-amber-800">Username</span>
          <div className="font-mono text-amber-900">{d.username}</div>
        </div>
        <div>
          <span className="text-xs uppercase tracking-wide text-amber-800">Activation URL</span>
          <div className="flex items-center gap-2">
            <input
              className="flex-1 rounded-md border border-amber-300 bg-white px-2 py-1 font-mono text-xs text-amber-900"
              value={d.setup_url}
              readOnly
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(d.setup_url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  /* clipboard rejection — the input is already selectable */
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              className="rounded-md border border-amber-500 bg-amber-500 px-2 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-60"
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
            >
              {resend.isPending ? '…' : 'Send via WhatsApp'}
            </button>
          </div>
          <p className="mt-1 text-xs text-amber-800">
            Expires: {new Date(d.expires_at).toLocaleString('en-IN')} ·{' '}
            <strong>{fmtExpiryLabel(d.expires_at)}</strong>
          </p>
          {resend.data ? (
            <p className="mt-1 text-xs text-amber-800">
              {resend.data.sent
                ? `Sent via ${resend.data.provider}.`
                : 'Send attempted — check delivery status; retry in 1 min if needed.'}
            </p>
          ) : null}
          {resend.error ? (
            <p className="mt-1 text-xs text-rk-700">
              {resend.error?.response?.data?.error === 'rate_limit_resend'
                ? 'Wait a minute before resending.'
                : `Resend failed: ${resend.error?.response?.data?.error || 'unknown'}`}
            </p>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function HospitalDashboard({ onRaise }) {
  const q = useQuery({
    queryKey: ['hospital', 'dashboard'],
    queryFn: () => apiRequest('GET', '/requests/dashboard'),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  if (q.isLoading) {
    return <div className="rk-card text-center text-slate-500">…</div>;
  }
  if (q.error) {
    return (
      <div className="rk-card text-rk-700">
        {q.error?.response?.data?.error || 'load_failed'}
      </div>
    );
  }

  const d = q.data || {};
  const k = d.kpis || {};
  const availability = d.district_availability || [];
  const components = [...new Set(availability.map((r) => r.component))].sort();
  const cellFor = (g, comp) =>
    availability.find((r) => r.blood_group === g && r.component === comp);

  return (
    <section className="space-y-4">
      {/* Header strip with Raise CTA */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-900">Hospital dashboard</h1>
          <p className="text-xs text-slate-500">
            Last 90 days of activity · district availability refreshes every 30 s.
          </p>
        </div>
        {onRaise ? (
          <button type="button" className="rk-button-primary text-sm" onClick={onRaise}>
            + Raise request
          </button>
        ) : null}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <KpiCard
          label="Open requests"
          value={k.open_count ?? 0}
          tone={k.open_count ? 'text-rk-700' : 'text-slate-900'}
        />
        <KpiCard
          label="Critical now"
          value={k.critical_now ?? 0}
          tone={k.critical_now ? 'text-rk-700' : 'text-slate-900'}
        />
        <KpiCard
          label="Fulfilled this month"
          value={k.fulfilled_this_month ?? 0}
          tone={k.fulfilled_this_month ? 'text-green-700' : 'text-slate-900'}
        />
        <KpiCard
          label="Expired this month"
          value={k.expired_this_month ?? 0}
          tone={k.expired_this_month ? 'text-amber-600' : 'text-slate-900'}
        />
        <KpiCard
          label="Avg time to fulfil"
          value={fmtDuration(k.avg_fulfilment_seconds)}
          hint="raised → fulfilled"
        />
      </div>

      {/* In-house BB admin activation — only rendered for hospitals with a
          paired BB child whose admin hasn't consumed the setup token yet. */}
      <PendingBbAdminPanel />

      {/* District availability grid */}
      <article className="rk-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Blood availability in your district
        </h2>
        {components.length === 0 ? (
          <p className="text-sm text-slate-500">
            No available units reported in your district right now. Raise the request — the
            matching engine will widen the search to adjacent districts.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 text-left">Group</th>
                    {components.map((comp) => (
                      <th key={comp} className="px-3 py-2 text-center">
                        {comp}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {GRID_GROUPS.map((g) => (
                    <tr key={g}>
                      <td className="px-3 py-2 font-semibold text-rk-700">{g}</td>
                      {components.map((comp) => {
                        const cell = cellFor(g, comp);
                        const avail = cell?.available_units ?? 0;
                        return (
                          <td key={comp} className="px-3 py-2 text-center">
                            <span
                              className={
                                avail > 0
                                  ? 'font-semibold text-slate-900'
                                  : 'text-slate-300'
                              }
                            >
                              {avail}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Counts are district-wide totals across all blood banks. Bag-level details are
              not shown to hospitals — the platform mediates issue.
            </p>
          </>
        )}
      </article>

      {/* Recent activity */}
      <article className="rk-card">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recent activity
        </h2>
        {(d.recent_activity || []).length === 0 ? (
          <p className="text-sm text-slate-500">No closed requests in the last 90 days.</p>
        ) : (
          <ul className="space-y-2">
            {d.recent_activity.map((r) => {
              const u = URG[r.urgency_tier] || URG.PL;
              return (
                <li key={r.id} className="flex items-center gap-2 text-sm">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${u.cls}`}>
                    {u.label}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">
                    {r.request_number}
                  </span>
                  <span className="font-medium text-slate-900">
                    {r.blood_group} · {r.component} · {r.units_fulfilled}/{r.units_required}u
                  </span>
                  <span className="ml-auto text-xs text-slate-500">
                    {STATUS_LABEL[r.status] || r.status} ·{' '}
                    {fmtDate(r.closed_at || r.raised_at)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    </section>
  );
}
