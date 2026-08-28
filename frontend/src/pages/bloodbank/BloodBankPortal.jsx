import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { Header } from '../../components/Header.jsx';
import { Footer } from '../../components/Footer.jsx';
import { apiRequest } from '../../lib/api.js';
import { errorMessage } from '../../lib/errorMessage.js';
import { donationSchema, openingStockSchema, zodFlatten } from '../../lib/schemas.js';
import { useT } from '../../i18n/useT.js';
import { DonorBulkUpload, ActivateImportButton } from '../../components/donors/DonorBulkUpload.jsx';
import { TeamPanel } from '../../components/institution/TeamPanel.jsx';
import { campStatus } from '../../lib/campStatus.js';
import {
  isoDow,
  isoOffsetDays,
  localDayKey,
  monthDates,
  monthOf,
  shiftMonth,
  todayISO,
} from '../../lib/dateBounds.js';

// Spec §7 Blood Bank Portal: inventory dashboard, record donation, TTI entry,
// supervisor verification (4-eyes). Opening-stock and incoming-request alerts
// are deferred to the next pass.

function tabsFor(t, campBadge) {
  return [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'camps', label: 'Camps', badge: campBadge },
    { id: 'incoming', label: 'Open requests' },
    { id: 'committed', label: 'My commitments' },
    { id: 'donors_in', label: 'Incoming donors' },
    { id: 'inventory', label: t('inventory') },
    { id: 'record', label: t('record_donation') },
    { id: 'screening', label: t('tti_screening') },
    { id: 'opening', label: t('opening_stock') },
    { id: 'import', label: 'Import donors' },
    { id: 'team', label: 'Team' },
  ];
}

export function BloodBankPortal() {
  const { t } = useT();
  const [tab, setTab] = useState('dashboard');

  // Lifted out of ScreeningEntry so the camp results worklist can drive it.
  // Clicking a donation in the Camps tab sets this and switches tabs, which is
  // the whole of the "upload results against each donor" ask — the operator
  // never types or sees a donation UUID. ScreeningEntry's own paste box still
  // works exactly as before.
  const [screenId, setScreenId] = useState('');

  // Badge counts camps ACTIONABLE by this blood bank: bb_response === 'PE'.
  // A camp with bb_response NULL is one an organiser named us on that the NGO
  // has not partnered yet — there is nothing to answer, so it must not nag.
  const campsQ = useQuery({
    queryKey: ['bb-camps', 'badge'],
    queryFn: () =>
      apiRequest('GET', `/camps/bb/camps?from=${todayISO()}&to=${isoOffsetDays(90)}`),
    staleTime: 60_000,
    retry: false,
  });
  const campBadge = (campsQ.data?.camps || []).filter((c) => c.bb_response === 'PE').length;

  const TABS = tabsFor(t, campBadge);

  return (
    <div className="flex min-h-full flex-col">
      <Header subtitle="Blood bank portal" />
      <main className="mx-auto w-full max-w-4xl px-4 py-6">
        <nav className="mb-4 flex gap-2 border-b border-slate-200">
          {TABS.map((tt) => (
            <button
              key={tt.id}
              type="button"
              onClick={() => setTab(tt.id)}
              className={
                'border-b-2 px-3 py-2 text-sm font-medium transition-colors ' +
                (tab === tt.id
                  ? 'border-rk-700 text-rk-700'
                  : 'border-transparent text-slate-500 hover:text-slate-800')
              }
            >
              {tt.label}
              {tt.badge ? (
                <span className="ml-1.5 inline-flex min-w-[1.25rem] justify-center rounded-full bg-rk-700 px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white">
                  {tt.badge}
                </span>
              ) : null}
            </button>
          ))}
        </nav>

        {tab === 'dashboard' ? <BBDashboard /> : null}
        {tab === 'camps' ? (
          <CampsPanel
            onScreenDonation={(id) => {
              setScreenId(id);
              setTab('screening');
            }}
          />
        ) : null}
        {tab === 'incoming' ? <OpenRequestsPanel /> : null}
        {tab === 'committed' ? <MyCommitmentsPanel /> : null}
        {tab === 'donors_in' ? <IncomingDonorsPanel /> : null}
        {tab === 'inventory' ? <InventoryView /> : null}
        {tab === 'record' ? <RecordDonation /> : null}
        {tab === 'screening' ? <ScreeningEntry openId={screenId} /> : null}
        {tab === 'opening' ? <OpeningStock /> : null}
        {tab === 'import' ? <DonorBulkUpload /> : null}
        {tab === 'team' ? <TeamPanel /> : null}
      </main>
      <Footer variant="compact" />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Dashboard tab — at-a-glance overview for the blood bank
// ────────────────────────────────────────────────────────────────────────────
const GRID_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const URG = {
  CR: { label: 'Critical', cls: 'bg-rk-700 text-white' },
  UR: { label: 'Urgent', cls: 'bg-amber-500 text-white' },
  PL: { label: 'Planned', cls: 'bg-slate-300 text-slate-800' },
};

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  } catch {
    return String(v);
  }
}

function KpiCard({ label, value, tone }) {
  return (
    <div className="rk-card">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={'mt-1 text-3xl font-bold ' + (tone || 'text-slate-900')}>{value}</div>
    </div>
  );
}

function BBDashboard() {
  const q = useQuery({
    queryKey: ['bb', 'dashboard'],
    queryFn: () => apiRequest('GET', '/inventory/dashboard'),
    staleTime: 15_000,
  });

  if (q.isLoading) return <div className="rk-card text-center text-slate-500">…</div>;
  if (q.error)
    return (
      <div className="rk-card text-rk-700">
        {errorMessage(q.error, 'load this page')}
      </div>
    );

  const d = q.data || {};
  const k = d.kpis || {};
  const grid = d.inventory_grid || [];
  const components = [...new Set(grid.map((r) => r.component))].sort();
  const cellFor = (g, comp) => grid.find((r) => r.blood_group === g && r.component === comp);

  return (
    <section className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Available units" value={k.available_units ?? 0} tone="text-green-700" />
        <KpiCard
          label="Expired — dispose"
          value={k.expired_units ?? 0}
          tone={k.expired_units ? 'text-rk-700' : 'text-slate-900'}
        />
        <KpiCard
          label="Expiring <48h"
          value={k.expiring_48h ?? 0}
          tone={k.expiring_48h ? 'text-rk-700' : 'text-slate-900'}
        />
        <KpiCard
          label="Pending TTI"
          value={k.pending_tti ?? 0}
          tone={k.pending_tti ? 'text-amber-600' : 'text-slate-900'}
        />
        <KpiCard label="Issued this month" value={k.issued_this_month ?? 0} />
        <KpiCard label="Donations today" value={k.donations_today ?? 0} />
      </div>

      {/* Inventory grid */}
      <article className="rk-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Inventory at a glance
        </h2>
        {components.length === 0 ? (
          <p className="text-sm text-slate-500">
            No inventory yet — record a donation to build stock.
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
                        const avail = cell?.available ?? 0;
                        return (
                          <td key={comp} className="px-3 py-2 text-center">
                            <span
                              className={
                                avail > 0 ? 'font-semibold text-slate-900' : 'text-slate-300'
                              }
                            >
                              {avail}
                            </span>
                            {cell && cell.total > avail ? (
                              <span className="text-xs text-slate-400"> /{cell.total}</span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Cell = available units · /n = total bags incl. quarantine.
            </p>
          </>
        )}
      </article>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Incoming requests */}
        <article className="rk-card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Incoming requests · your district
          </h2>
          {(d.incoming_requests || []).length === 0 ? (
            <p className="text-sm text-slate-500">No open requests in your district.</p>
          ) : (
            <ul className="space-y-2">
              {d.incoming_requests.map((r) => {
                const u = URG[r.urgency_tier] || URG.PL;
                return (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${u.cls}`}>
                      {u.label}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">{r.request_number}</span>
                    <span className="font-medium text-slate-900">
                      {r.blood_group} · {r.component} · {r.units_required}u
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

        {/* Recent donations */}
        <article className="rk-card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Recent donations
          </h2>
          {(d.recent_donations || []).length === 0 ? (
            <p className="text-sm text-slate-500">No donations recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {d.recent_donations.map((dn) => (
                <li key={dn.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-900">{dn.donor_name}</span>
                  <span className="text-xs text-slate-500">
                    {dn.component} · {dn.volume_ml}ml · {fmtDate(dn.collection_date)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Open requests I can fulfil — cross-BB partial-fulfilment view.
// Shows open requests where THIS BB has compatible available inventory.
// If BB1 confirmed 3 of an 11-unit request, this BB sees "8 units still needed"
// alongside their own available exact+fallback stock. Polls every 15s.
// ────────────────────────────────────────────────────────────────────────────
function fmtAge(mins) {
  if (mins == null) return '—';
  const m = Math.floor(mins);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  // Past a day, keep reading in days — "960h 33m ago" is unreadable at a glance,
  // and this sits next to a Critical badge where age drives triage.
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return remH === 0 ? `${d}d ago` : `${d}d ${remH}h ago`;
  }
  const rem = m % 60;
  return rem === 0 ? `${h}h ago` : `${h}h ${rem}m ago`;
}

function OpenRequestsPanel() {
  const q = useQuery({
    queryKey: ['bb', 'open-requests'],
    queryFn: () => apiRequest('GET', '/inventory/open-requests'),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  if (q.isLoading) return <div className="rk-card text-center text-slate-500">Loading…</div>;
  if (q.error)
    return (
      <div className="rk-card text-rk-700">
        {errorMessage(q.error, 'load this page')}
      </div>
    );

  const requests = q.data?.requests || [];

  return (
    <section className="space-y-4">
      <div className="rk-card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Open requests you can fulfil
          </h2>
          <span className="text-xs text-slate-400">Auto-refresh every 15s</span>
        </div>
        {requests.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No open requests match your available inventory right now.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {requests.map((r) => (
              <OpenRequestCard key={r.id} r={r} />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-slate-400">
        Only requests where your available stock is compatible are shown. Bags stay in your control
        until you voluntarily offer units — Raktify never auto-reserves your inventory. The
        "confirmed" count aggregates offers already made by other blood banks so you can see the
        remaining unmet need at a glance.
      </p>
    </section>
  );
}

function OpenRequestCard({ r }) {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [declineOpen, setDeclineOpen] = useState(false);
  const u = URG[r.urgency_tier] || URG.PL;
  const pct = r.units_required > 0
    ? Math.min(100, (r.units_committed / r.units_required) * 100)
    : 0;
  const iOfferedAny = (r.units_i_committed ?? 0) > 0;
  const canOffer = (r.units_i_can_offer ?? 0) > 0;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.cls}`}>{u.label}</span>
          <span className="font-mono text-[11px] text-slate-500">{r.request_number}</span>
          {iOfferedAny ? (
            <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
              You offered {r.units_i_committed}
            </span>
          ) : null}
          {!r.is_same_district ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
              Adjacent district
            </span>
          ) : null}
        </div>
        <span className="text-xs text-slate-500">{fmtAge(r.mins_since_raised)}</span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-slate-500">Requesting</div>
          <div className="text-sm font-semibold text-slate-900">{r.hospital_name}</div>
          <div className="text-xs text-slate-500">{r.hospital_district} district</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Required</div>
          <div className="text-sm font-semibold text-slate-900">
            {r.blood_group} · {r.component}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>
            <span className="font-bold text-slate-900">{r.units_committed}</span> of{' '}
            <span className="font-bold text-slate-900">{r.units_required}</span> committed
            {r.units_committed > 0 && !iOfferedAny ? ' (by other BBs)' : ''}
          </span>
          <span>
            <span className="font-bold text-rk-700">{r.units_still_needed}</span> still needed
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 rounded bg-slate-50 p-2 text-xs">
        <div className="font-semibold text-slate-700">Your available compatible stock</div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-600">
          <span>
            Exact match ({r.blood_group}):{' '}
            <span className="font-bold text-slate-900">{r.exact_units}</span>
          </span>
          {r.fallback_units > 0 ? (
            <span>
              Compatible fallback:{' '}
              <span className="font-bold text-slate-900">{r.fallback_units}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setDeclineOpen(true)}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          Can&apos;t fulfil
        </button>
        {canOffer ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded bg-rk-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rk-800"
          >
            Offer up to {r.units_i_can_offer} unit{r.units_i_can_offer !== 1 ? 's' : ''}
          </button>
        ) : (
          <span className="text-xs italic text-slate-400">
            {iOfferedAny ? 'Your offer already recorded' : 'No further units to offer'}
          </span>
        )}
        {/* A BB only becomes a party to the case once it has committed stock
            (offering sets matched_blood_bank_id), which is also what the
            backend thread guard checks — so only surface chat after an offer. */}
        {iOfferedAny ? (
          <Link
            to={`/bb/requests/${r.id}`}
            className="text-xs font-semibold text-rk-700 hover:underline"
          >
            Open case chat →
          </Link>
        ) : null}
      </div>

      {modalOpen ? (
        <OfferModal
          r={r}
          onClose={() => setModalOpen(false)}
          onDone={() => {
            setModalOpen(false);
            qc.invalidateQueries({ queryKey: ['bb', 'open-requests'] });
            qc.invalidateQueries({ queryKey: ['bb', 'dashboard'] });
            qc.invalidateQueries({ queryKey: ['inventory'] });
          }}
        />
      ) : null}

      {declineOpen ? (
        <DeclineModal
          r={r}
          onClose={() => setDeclineOpen(false)}
          onDone={() => {
            setDeclineOpen(false);
            qc.invalidateQueries({ queryKey: ['bb', 'open-requests'] });
          }}
        />
      ) : null}
    </li>
  );
}

function DeclineModal({ r, onClose, onDone }) {
  const [reason, setReason] = useState('NS');
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);

  const m = useMutation({
    mutationFn: (body) =>
      apiRequest('POST', `/inventory/open-requests/${r.id}/decline`, body),
    onSuccess: onDone,
    onError: (e) => setErr(errorMessage(e, 'record that you cannot fulfil this')),
  });

  const REASONS = [
    {
      key: 'NS',
      label: 'No compatible stock',
      hint: 'You have no matching units, but you can still accept walk-in donors for this request.',
    },
    {
      key: 'NC',
      label: 'No capacity today',
      hint: 'Short-staffed / lab down / out of QA bags. Donors will NOT be routed to you today.',
    },
    {
      key: 'ND',
      label: 'Not on duty',
      hint: 'Closed for the day (holiday etc.). Donors will NOT be routed to you today.',
    },
  ];

  const submit = () => {
    setErr(null);
    m.mutate({ reason, note: note.trim() || undefined });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">
          Can&apos;t fulfil {r.request_number}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          Why can&apos;t this BB help this request? Decline auto-expires in 24 hours.
        </p>

        <div className="mt-4 space-y-2">
          {REASONS.map((opt) => (
            <label
              key={opt.key}
              className={
                'flex cursor-pointer flex-col gap-1 rounded border p-2 text-sm ' +
                (reason === opt.key
                  ? 'border-rk-700 bg-rk-50'
                  : 'border-slate-200 hover:bg-slate-50')
              }
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="decline_reason"
                  value={opt.key}
                  checked={reason === opt.key}
                  onChange={() => setReason(opt.key)}
                />
                <span className="font-semibold text-slate-900">{opt.label}</span>
              </div>
              <span className="pl-6 text-xs text-slate-500">{opt.hint}</span>
            </label>
          ))}
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">
          Note (optional)
        </label>
        <textarea
          rows={2}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-rk-700 focus:outline-none"
          placeholder="Anything useful for the coordinator (e.g. expected time before you can help again)."
        />

        {err ? <p className="mt-2 text-xs text-rk-700">Error: {err}</p> : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={m.isPending}
            className="flex-1 rounded bg-rk-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rk-800 disabled:opacity-60"
          >
            {m.isPending ? 'Saving…' : 'Confirm decline'}
          </button>
        </div>
      </div>
    </div>
  );
}

function OfferModal({ r, onClose, onDone }) {
  const max = r.units_i_can_offer ?? 0;
  const [units, setUnits] = useState(Math.min(max, r.units_still_needed ?? max));
  const [needsReplacement, setNeedsReplacement] = useState(false);
  const [deadlineDays, setDeadlineDays] = useState(14);
  const [err, setErr] = useState(null);

  const m = useMutation({
    mutationFn: (body) =>
      apiRequest('POST', `/inventory/open-requests/${r.id}/offer`, body),
    onSuccess: onDone,
    onError: (e) => setErr(errorMessage(e, 'record this offer')),
  });

  const submit = () => {
    setErr(null);
    const n = Number(units);
    if (!Number.isFinite(n) || n < 1 || n > max) {
      setErr('choose_a_valid_number');
      return;
    }
    m.mutate({
      units: n,
      needs_replacement: needsReplacement,
      replacement_deadline_days: needsReplacement ? Number(deadlineDays) : undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">
          Offer units for {r.request_number}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {r.hospital_name} · {r.blood_group} · {r.component} · {r.units_still_needed} still needed
        </p>

        <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">
          Units to reserve (max {max})
        </label>
        <input
          type="number"
          min={1}
          max={max}
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-lg font-semibold text-slate-900 focus:border-rk-700 focus:outline-none"
        />
        <p className="mt-2 text-xs text-slate-500">
          Same-group first, then compatible fallback. Bags are reserved (status RE) and remain in
          your control until issued or released.
        </p>

        {/* Replacement obligation — V2 spec §7 (Option B: support with friction) */}
        <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={needsReplacement}
              onChange={(e) => setNeedsReplacement(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="font-semibold text-slate-800">
                This BB will need replacement donor(s) for these units
              </span>
              <span className="mt-1 block text-xs text-slate-500">
                Raktify will invite <em>nearby eligible volunteers</em> to help replenish the
                blood bank. This is an invitation to strangers, not a demand on the
                patient&apos;s family.
              </span>
            </span>
          </label>
          {needsReplacement ? (
            <div className="mt-3 flex items-center gap-2 text-xs">
              <label className="font-semibold text-slate-600">Deadline:</label>
              <select
                value={deadlineDays}
                onChange={(e) => setDeadlineDays(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-1"
              >
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={21}>21 days</option>
                <option value={30}>30 days</option>
              </select>
            </div>
          ) : null}
        </div>

        {err ? <p className="mt-2 text-xs text-rk-700">Error: {err}</p> : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={m.isPending}
            className="flex-1 rounded bg-rk-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rk-800 disabled:opacity-60"
          >
            {m.isPending ? 'Reserving…' : `Confirm offer of ${units}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// My commitments — cases this BB has committed bags to.
//
// "Open requests" drops a case the moment it is fully committed, so without
// this tab the BB loses the case it just accepted, and with it the only route
// into the case chat. Shows what was promised, what is still reserved vs
// transfused, and any replacement obligation still running.
// ────────────────────────────────────────────────────────────────────────────
const REQ_STATUS = {
  OP: { label: 'Open', cls: 'bg-amber-100 text-amber-800' },
  MT: { label: 'Matched', cls: 'bg-blue-100 text-blue-800' },
  AS: { label: 'Assigned', cls: 'bg-blue-100 text-blue-800' },
  PF: { label: 'Partly filled', cls: 'bg-amber-100 text-amber-800' },
  FU: { label: 'Fulfilled', cls: 'bg-green-100 text-green-800' },
  CL: { label: 'Closed', cls: 'bg-slate-200 text-slate-700' },
  CA: { label: 'Cancelled', cls: 'bg-slate-200 text-slate-600' },
};

function MyCommitmentsPanel() {
  const q = useQuery({
    queryKey: ['bb', 'my-commitments'],
    queryFn: () => apiRequest('GET', '/inventory/my-commitments'),
    refetchInterval: 20_000,
  });

  if (q.isLoading) return <div className="rk-card text-center text-slate-500">…</div>;
  if (q.error)
    return <div className="rk-card text-rk-700">{errorMessage(q.error, 'load your commitments')}</div>;

  const rows = q.data?.commitments || [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Cases you have committed units to
        </h2>
        <span className="text-xs text-slate-400">Auto-refresh every 20s</span>
      </div>

      {rows.length === 0 ? (
        <p className="rk-card py-6 text-center text-sm text-slate-500">
          You haven&apos;t committed units to any case yet. Offer units from{' '}
          <span className="font-medium">Open requests</span> and the case will appear here.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <CommitmentCard key={r.id} r={r} />
          ))}
        </ul>
      )}
    </section>
  );
}

// One dot per custody stage, so a BB can see at a glance where its units are.
function ChainPips({ r }) {
  const stages = [
    { n: r.units_reserved, label: 'reserved', cls: 'bg-slate-400' },
    { n: r.units_issued, label: 'issued', cls: 'bg-blue-500' },
    { n: r.units_received, label: 'received', cls: 'bg-indigo-500' },
    { n: r.units_transfused, label: 'transfused', cls: 'bg-green-600' },
  ].filter((s) => s.n > 0);
  if (stages.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
      {stages.map((s) => (
        <span key={s.label} className="inline-flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${s.cls}`} />
          {s.n} {s.label}
        </span>
      ))}
    </div>
  );
}

function CommitmentCard({ r }) {
  const qc = useQueryClient();
  const [err, setErr] = useState(null);
  const st = REQ_STATUS[r.status] || { label: r.status, cls: 'bg-slate-100 text-slate-700' };
  const u = URG[r.urgency_tier] || URG.PL;
  const owesReplacement =
    r.replacement_units_target != null && r.replacement_units_fulfilled < r.replacement_units_target;

  const issue = useMutation({
    mutationFn: () => apiRequest('POST', `/inventory/requests/${r.id}/issue`, {}),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ['bb', 'my-commitments'] });
      qc.invalidateQueries({ queryKey: ['bb', 'open-requests'] });
    },
    onError: (e) => setErr(errorMessage(e, 'issue these units')),
  });

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.cls}`}>{u.label}</span>
        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>{st.label}</span>
        <span className="font-mono text-[11px] text-slate-500">{r.request_number}</span>
        <span className="ml-auto text-xs text-slate-500">{fmtAge(r.mins_since_raised)}</span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase text-slate-500">Requesting</div>
          <div className="text-sm font-semibold text-slate-900">{r.hospital_name}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Required</div>
          <div className="text-sm font-semibold text-slate-900">
            {r.blood_group} · {r.component}
          </div>
          <div className="text-xs text-slate-500">
            {r.units_committed_total} of {r.units_required} committed in total
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Your {r.units_i_committed} unit
            {r.units_i_committed !== 1 ? 's' : ''}</div>
          <ChainPips r={r} />
        </div>
      </div>

      {owesReplacement ? (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
          Replacement donors: {r.replacement_units_fulfilled} of {r.replacement_units_target} by{' '}
          {new Date(r.replacement_deadline).toLocaleDateString('en-IN', {
            day: 'numeric',
            month: 'short',
          })}
        </p>
      ) : null}

      {err ? <p className="mt-2 text-xs text-rk-700">{err}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-2">
        {r.units_reserved > 0 ? (
          <button
            type="button"
            onClick={() => issue.mutate()}
            disabled={issue.isPending}
            className="rounded bg-rk-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rk-800 disabled:opacity-50"
          >
            {issue.isPending
              ? 'Issuing…'
              : `Mark ${r.units_reserved} unit${r.units_reserved !== 1 ? 's' : ''} issued →`}
          </button>
        ) : null}
        <Link
          to={`/bb/requests/${r.id}`}
          className="text-xs font-semibold text-rk-700 hover:underline"
        >
          Open case chat →
        </Link>
        {r.closed_at ? (
          <span className="text-xs text-slate-400">
            Closed {new Date(r.closed_at).toLocaleDateString('en-IN')}
          </span>
        ) : null}
      </div>
    </li>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Incoming donors — V2 donor-BB routing (spec §5).
// Donors who accepted alerts and chose THIS BB show up here so staff can
// plan intake. Actions: Arrived → No-show → Deferred at intake.
// ────────────────────────────────────────────────────────────────────────────
function IncomingDonorsPanel() {
  const q = useQuery({
    queryKey: ['bb', 'incoming-donors'],
    queryFn: () => apiRequest('GET', '/inventory/incoming-donors'),
    refetchInterval: 20_000,
    staleTime: 15_000,
  });

  if (q.isLoading) return <div className="rk-card text-center text-slate-500">Loading…</div>;
  if (q.error)
    return (
      <div className="rk-card text-rk-700">
        {errorMessage(q.error, 'load this page')}
      </div>
    );

  const donors = q.data?.incoming || [];

  return (
    <section className="space-y-4">
      <div className="rk-card">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Incoming donors
          </h2>
          <span className="text-xs text-slate-400">Auto-refresh every 20s</span>
        </div>
        {donors.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No donors have chosen your blood bank right now. When someone accepts an alert and picks
            you, they&apos;ll appear here so you can plan intake.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {donors.map((d) => (
              <IncomingDonorCard key={d.choice_id} d={d} />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-slate-400">
        Donor mobile shown so you can call if they&apos;re running late. Their identity is NOT
        visible to the requesting hospital — Raktify keeps the two sides masked.
      </p>
    </section>
  );
}

function IncomingDonorCard({ d }) {
  const qc = useQueryClient();
  const u = URG[d.urgency_tier] || URG.PL;
  const isArrived = d.status === 'AR';

  const arrivedM = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/inventory/incoming-donors/${d.choice_id}/arrived`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bb', 'incoming-donors'] }),
  });
  const noShowM = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/inventory/incoming-donors/${d.choice_id}/no-show`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bb', 'incoming-donors'] }),
  });
  const [deferOpen, setDeferOpen] = useState(false);

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.cls}`}>{u.label}</span>
          <span className="font-mono text-[11px] text-slate-500">{d.request_number}</span>
          {isArrived ? (
            <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
              Arrived
            </span>
          ) : (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              Expected
            </span>
          )}
        </div>
        {d.distance_to_bb_km != null ? (
          <span className="text-xs text-slate-500">{Number(d.distance_to_bb_km).toFixed(1)} km</span>
        ) : null}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-slate-500">Donor</div>
          <div className="text-sm font-semibold text-slate-900">{d.donor_name}</div>
          <a
            href={`tel:${d.donor_mobile}`}
            className="text-xs font-mono text-rk-700 hover:underline"
          >
            {d.donor_mobile}
          </a>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Fulfilling</div>
          <div className="text-sm font-semibold text-slate-900">
            {d.blood_group} · {d.component}
          </div>
          <div className="text-xs text-slate-500">
            for {d.hospital_name} · {d.hospital_district_name}
          </div>
        </div>
      </div>

      {d.expected_arrival_at ? (
        <div className="mt-2 text-xs text-slate-500">
          Expected: {new Date(d.expected_arrival_at).toLocaleString('en-IN')}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {!isArrived ? (
          <button
            type="button"
            onClick={() => arrivedM.mutate()}
            disabled={arrivedM.isPending}
            className="rounded bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-60"
          >
            {arrivedM.isPending ? 'Saving…' : 'Mark arrived'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setDeferOpen(true)}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          Defer at intake
        </button>
        <button
          type="button"
          onClick={() => noShowM.mutate()}
          disabled={noShowM.isPending}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {noShowM.isPending ? 'Saving…' : 'No-show'}
        </button>
      </div>

      {deferOpen ? (
        <DeferModal
          choiceId={d.choice_id}
          onClose={() => setDeferOpen(false)}
          onDone={() => {
            setDeferOpen(false);
            qc.invalidateQueries({ queryKey: ['bb', 'incoming-donors'] });
          }}
        />
      ) : null}
    </li>
  );
}

function DeferModal({ choiceId, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(null);
  const m = useMutation({
    mutationFn: (body) =>
      apiRequest('POST', `/inventory/incoming-donors/${choiceId}/deferred`, body),
    onSuccess: onDone,
    onError: (e) => setErr(errorMessage(e, 'defer this donor')),
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">Defer donor at intake</h3>
        <p className="mt-1 text-xs text-slate-500">
          Donor is at the BB but can&apos;t donate today (low Hb, recent tattoo, blood-pressure,
          etc.). Reason is recorded for the donor&apos;s health passport.
        </p>
        <textarea
          rows={3}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          className="mt-3 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-rk-700 focus:outline-none"
          placeholder="e.g. Hb 11.8 g/dL — advise iron-rich diet, return in 6 weeks"
        />
        {err ? <p className="mt-2 text-xs text-rk-700">Error: {err}</p> : null}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (reason.trim().length < 3) {
                setErr('reason_too_short');
                return;
              }
              m.mutate({ reason: reason.trim() });
            }}
            disabled={m.isPending}
            className="flex-1 rounded bg-rk-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rk-800 disabled:opacity-60"
          >
            {m.isPending ? 'Saving…' : 'Confirm defer'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Inventory tab — bag list with expiry colour-coding
// ────────────────────────────────────────────────────────────────────────────
function expiryClass(expiry) {
  if (!expiry) return 'bg-slate-100 text-slate-600';
  const days = Math.floor((new Date(expiry).getTime() - Date.now()) / 86400000);
  if (days < 2) return 'bg-rk-700 text-white';        // < 48h
  if (days <= 7) return 'bg-amber-500 text-white';    // 2–7d
  return 'bg-green-100 text-green-800';               // > 7d
}

function InventoryView() {
  const [statusFilter, setStatusFilter] = useState('');
  const inventoryQ = useQuery({
    queryKey: ['inventory', statusFilter],
    queryFn: () =>
      apiRequest('GET', `/inventory${statusFilter ? `?status=${statusFilter}` : ''}`),
    staleTime: 10_000,
  });
  const bags = inventoryQ.data?.bags || [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Inventory</h1>
        <select
          aria-label="status filter"
          className="rk-input max-w-[12rem]"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="QA">QA — quarantine</option>
          <option value="AV">AV — available</option>
          <option value="RE">RE — reserved</option>
          <option value="IS">IS — issued</option>
          <option value="TR">TR — transfused</option>
          <option value="EX">EX — expired</option>
          <option value="RC">RC — recalled</option>
        </select>
      </div>

      {inventoryQ.isLoading ? (
        <div className="rk-card text-center text-slate-500">…</div>
      ) : bags.length === 0 ? (
        <div className="rk-card text-sm text-slate-500">
          No bags{statusFilter ? ` in status ${statusFilter}` : ''}.
        </div>
      ) : (
        <div className="rk-card overflow-x-auto p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">ISBT</th>
                <th className="px-3 py-2 text-left">Group</th>
                <th className="px-3 py-2 text-left">Component</th>
                <th className="px-3 py-2 text-right">Volume</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Expiry</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bags.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-2 font-mono text-xs">{b.isbt_barcode}</td>
                  <td className="px-3 py-2 font-semibold">{b.blood_group_code || '—'}</td>
                  <td className="px-3 py-2">{b.component_code || '—'}</td>
                  <td className="px-3 py-2 text-right">{b.volume_ml ?? '—'} ml</td>
                  <td className="px-3 py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                      {b.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        'rounded-full px-2 py-0.5 text-xs font-medium ' + expiryClass(b.expiry_date)
                      }
                    >
                      {b.expiry_date || '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Record donation tab
// ────────────────────────────────────────────────────────────────────────────
const COMPONENTS = [
  { id: 1, code: 'WB', name: 'Whole Blood' },
  { id: 2, code: 'RBC', name: 'Red Cells' },
  { id: 3, code: 'FFP', name: 'Fresh Frozen Plasma' },
  { id: 4, code: 'PLT', name: 'Platelets' },
  { id: 5, code: 'CRY', name: 'Cryoprecipitate' },
  { id: 6, code: 'SDP', name: 'Single-Donor Platelet' },
];

const blankDonation = {
  donor_id: '',
  collection_date: todayISO(),
  collection_time: '',
  component_id: 1,
  volume_ml: 350,
  hb_gdl: 13.5,
  hb_method: 'CS',
  pulse_bpm: '',
  bp_systolic: '',
  bp_diastolic: '',
  weight_kg: '',
  isbt_barcode: '',
  notes: '',
};

function RecordDonation() {
  const qc = useQueryClient();
  const [form, setForm] = useState(blankDonation);
  const [result, setResult] = useState(null);
  const [mobileQuery, setMobileQuery] = useState('');
  const [donorPreview, setDonorPreview] = useState(null);
  const [lookupError, setLookupError] = useState('');
  const [validationErrors, setValidationErrors] = useState(null);
  // Batch context: the camp these donations belong to, and how many have been
  // entered in this sitting. Held outside `form` on purpose - a camp batch
  // survives the per-donor reset between records.
  //   null = untouched, so fall through to the auto-selection below;
  //   ''   = the blood bank explicitly said "not at a camp".
  const [campChoice, setCampChoice] = useState(null);
  const [batchCount, setBatchCount] = useState(0);

  // The read side of services/donations/camp.js: same statuses, same +/-2 day
  // tolerance, same ownership rule, so the picker can never offer a camp that
  // POST /donations would refuse with 409 camp_not_collectable.
  const collectable = useQuery({
    queryKey: ['camps', 'collectable', form.collection_date],
    queryFn: () => apiRequest('GET', `/camps/collectable?date=${form.collection_date}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(form.collection_date),
    staleTime: 60_000,
  });
  const campList = collectable.data?.camps || [];
  // Auto-select ONLY on an unambiguous exact-date match: one camp, dated the day
  // being recorded. Two camps that day - or a camp merely inside the tolerance
  // window - is a judgement call the blood bank has to make, because silently
  // attributing an in-house walk-in to a camp writes an attendance row that
  // migration 314 deliberately never unwinds.
  const sameDayCamps = campList.filter((c) => c.scheduled_date === form.collection_date);
  const autoCampId = sameDayCamps.length === 1 ? sameDayCamps[0].id : '';
  // Resolving through campList also drops a stale choice after the date changes,
  // so a camp id can never be posted for a date it is no longer valid for.
  const selectedCamp =
    campList.find((c) => c.id === (campChoice === null ? autoCampId : campChoice)) || null;
  const campId = selectedCamp ? selectedCamp.id : '';

  const lookup = useMutation({
    mutationFn: (mobile) =>
      apiRequest('GET', `/donors/lookup?mobile=${encodeURIComponent(mobile)}`),
    onSuccess: (data) => {
      setDonorPreview(data);
      setForm((prev) => ({ ...prev, donor_id: data.donor_id }));
      setLookupError('');
    },
    onError: (err) => {
      setDonorPreview(null);
      setLookupError(errorMessage(err, 'look up this donor'));
    },
  });

  const create = useMutation({
    mutationFn: (payload) => apiRequest('POST', '/donations', payload),
    onSuccess: (data) => {
      setResult(data);
      if (data.camp) setBatchCount((n) => n + 1);
      qc.invalidateQueries({ queryKey: ['inventory'] });
      // donations_recorded on the picker is how the blood bank sees how far
      // through a camp batch they are, so refresh it after every save.
      qc.invalidateQueries({ queryKey: ['camps', 'collectable'] });
    },
  });

  function update(k, v) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  function clearDonor() {
    setDonorPreview(null);
    setMobileQuery('');
    setForm((prev) => ({ ...prev, donor_id: '' }));
  }

  // Batch entry. At a camp the blood bank enters 30 donations in one sitting; a
  // reset that also cleared the camp and the date would make them re-pick both 30
  // times, and the camp would end up skipped - which is exactly how the attendance
  // derivation gets lost. Everything donor-specific clears; the batch context (the
  // camp, via campChoice, plus the collection date) survives.
  function nextDonor() {
    setResult(null);
    setValidationErrors(null);
    setForm({ ...blankDonation, collection_date: form.collection_date });
    clearDonor();
  }

  function submit(e) {
    e.preventDefault();
    setResult(null);
    setValidationErrors(null);
    const candidate = {
      donor_id: form.donor_id.trim(),
      collection_date: form.collection_date,
      ...(form.collection_time ? { collection_time: form.collection_time } : {}),
      ...(campId ? { donation_camp_id: campId } : {}),
      component_id: Number(form.component_id),
      volume_ml: Number(form.volume_ml),
      hb_gdl: Number(form.hb_gdl),
      hb_method: form.hb_method,
      ...(form.pulse_bpm ? { pulse_bpm: Number(form.pulse_bpm) } : {}),
      ...(form.bp_systolic ? { bp_systolic: Number(form.bp_systolic) } : {}),
      ...(form.bp_diastolic ? { bp_diastolic: Number(form.bp_diastolic) } : {}),
      ...(form.weight_kg ? { weight_kg: Number(form.weight_kg) } : {}),
      isbt_barcode: form.isbt_barcode.trim(),
      ...(form.notes ? { notes: form.notes } : {}),
    };
    const parsed = donationSchema.safeParse(candidate);
    if (!parsed.success) {
      setValidationErrors(zodFlatten(parsed.error));
      return;
    }
    create.mutate(parsed.data);
  }

  const error = create.error?.response?.data;

  return (
    <section className="space-y-3">
      <h1 className="text-lg font-semibold text-slate-900">Record donation</h1>

      {result ? (
        <div className="rk-card border-l-4 border-green-500">
          <div className="font-mono text-xs text-slate-700">{result.donation_id}</div>
          <div className="font-semibold text-green-800">Donation recorded</div>
          <div className="text-sm text-slate-600">
            ISBT {result.isbt_barcode} · bag status {result.inventory_bag?.status || 'pending'}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Move to the TTI screening tab to enter the test panel — the bag stays in QA until
            screening is verified.
          </p>
          {result.camp ? (
            <p className="mt-2 text-xs text-rk-900">
              Attributed to <strong>{result.camp.name}</strong> ({result.camp.scheduled_date}) -
              this donor is now marked <strong>Attended</strong> on that camp&apos;s roster. No
              roster tap needed.
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button type="button" className="rk-button-secondary" onClick={nextDonor}>
              {result.camp ? 'Next donor (same camp)' : 'Record another'}
            </button>
          </div>
        </div>
      ) : null}

      <form className="rk-card grid gap-4 sm:grid-cols-2" onSubmit={submit}>
        {/* Camp attribution, shown only when a collectable camp exists near this
            collection date - a bank with no camp that week sees the form unchanged.
            This is the field that fills the roster: attendance, turnout,
            units_collected and the next-morning thank-you all derive from the
            donation row, so it sits above the donor lookup as batch context
            rather than beside the clinical fields. */}
        {campList.length > 0 ? (
          <div className="sm:col-span-2 rounded-md border border-rk-100 bg-rk-50/60 p-3">
            <label className="rk-label" htmlFor="camp">
              Camp
            </label>
            <select
              id="camp"
              className="rk-input mt-1"
              value={campId}
              onChange={(e) => setCampChoice(e.target.value)}
            >
              <option value="">In-house donation - not at a camp</option>
              {campList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} - {c.scheduled_date} - {c.venue || c.district_name}
                </option>
              ))}
            </select>
            {selectedCamp ? (
              <p className="mt-2 text-xs text-rk-900">
                Each donation saved with this camp selected marks that donor{' '}
                <strong>Attended</strong> on its roster automatically -{' '}
                <strong>{selectedCamp.donations_recorded}</strong> recorded against it so far
                {batchCount > 0 ? `, ${batchCount} in this sitting` : ''}. The camp stays
                selected between records.
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                {campList.length === 1 ? 'A camp is' : `${campList.length} camps are`}{' '}
                scheduled near this collection date. Pick one when you are collecting at it so
                the roster fills itself; leave this as in-house for a donation at the bank.
              </p>
            )}
          </div>
        ) : null}

        <div className="sm:col-span-2 space-y-2">
          <label className="rk-label" htmlFor="donor-mobile">
            Donor mobile lookup
          </label>
          <div className="flex gap-2">
            <input
              id="donor-mobile"
              inputMode="tel"
              className="rk-input flex-1"
              placeholder="+91 9XXXXXXXXX"
              value={mobileQuery}
              onChange={(e) => setMobileQuery(e.target.value)}
              disabled={Boolean(donorPreview)}
            />
            {donorPreview ? (
              <button type="button" className="rk-button-secondary" onClick={clearDonor}>
                Clear
              </button>
            ) : (
              <button
                type="button"
                className="rk-button-primary"
                onClick={() => lookup.mutate(mobileQuery.trim())}
                disabled={lookup.isPending || mobileQuery.trim().length < 10}
              >
                {lookup.isPending ? '…' : 'Look up'}
              </button>
            )}
          </div>
          {lookupError ? <p className="text-sm text-rk-700">{lookupError}</p> : null}
          {donorPreview ? (
            <div className="rounded-md bg-slate-50 p-3 text-sm ring-1 ring-slate-200">
              <div className="font-semibold text-slate-900">{donorPreview.full_name}</div>
              <div className="mt-1 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-rk-50 px-2 py-0.5 font-medium text-rk-700">
                  {donorPreview.blood_group_verified
                    ? `Verified ${donorPreview.blood_group_verified_code}`
                    : donorPreview.blood_group_self_reported_code
                      ? `Self ${donorPreview.blood_group_self_reported_code} (unverified)`
                      : 'No blood group'}
                </span>
                <span
                  className={
                    'rounded-full px-2 py-0.5 font-medium ' +
                    (donorPreview.deferral_status === 'P' || donorPreview.deferral_status === 'T'
                      ? 'bg-rk-700 text-white'
                      : 'bg-green-100 text-green-800')
                  }
                >
                  Deferral: {donorPreview.deferral_status || 'N'}
                </span>
                {donorPreview.next_eligible_date ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                    Next eligible: {donorPreview.next_eligible_date}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 font-mono text-[10px] text-slate-500">
                id {donorPreview.donor_id}
              </div>
              {!donorPreview.blood_group_verified ? (
                <p className="mt-1 text-xs text-amber-800">
                  Donor has no verified blood group — POST /donations will fail. Verify via{' '}
                  <code>POST /donors/:id/blood-group/verify</code> first.
                </p>
              ) : null}
              {donorPreview.needs_activation ? (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  <p className="font-medium">
                    Imported donor — needs activation before donation.
                  </p>
                  <p className="mt-0.5">
                    This donor was added in bulk (source:{' '}
                    <code>{donorPreview.registration_source}</code>) and never completed
                    consent. Walk them through the activation steps below.
                  </p>
                  <ActivateImportButton
                    donor={donorPreview}
                    onActivated={(updated) => {
                      setForm((prev) => ({ ...prev, donor_id: updated.donor.id }));
                      // Refresh the lookup so the UI hides this banner.
                      lookup.mutate(mobileQuery.trim());
                    }}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <Field label="Collection date" htmlFor="cd">
          <input
            id="cd"
            type="date"
            className="rk-input"
            value={form.collection_date}
            onChange={(e) => update('collection_date', e.target.value)}
            required
            min={isoOffsetDays(-365)}
            max={todayISO()}
          />
        </Field>
        <Field label="Time (optional)" htmlFor="ct">
          <input
            id="ct"
            type="time"
            className="rk-input"
            value={form.collection_time}
            onChange={(e) => update('collection_time', e.target.value)}
          />
        </Field>

        <Field label="Component" htmlFor="comp">
          <select
            id="comp"
            className="rk-input"
            value={form.component_id}
            onChange={(e) => update('component_id', e.target.value)}
          >
            {COMPONENTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Volume (ml)" htmlFor="vol">
          <input
            id="vol"
            type="number"
            min={50}
            max={500}
            className="rk-input"
            value={form.volume_ml}
            onChange={(e) => update('volume_ml', e.target.value)}
            required
          />
        </Field>

        <Field label="Hb (g/dL)" htmlFor="hb">
          <input
            id="hb"
            type="number"
            step="0.1"
            min={5}
            max={25}
            className="rk-input"
            value={form.hb_gdl}
            onChange={(e) => update('hb_gdl', e.target.value)}
          />
        </Field>
        <Field label="Hb method" htmlFor="hbm">
          <select
            id="hbm"
            className="rk-input"
            value={form.hb_method}
            onChange={(e) => update('hb_method', e.target.value)}
          >
            <option value="CS">CS — copper sulphate</option>
            <option value="HC">HC — HemoCue</option>
            <option value="LB">LB — lab analyser</option>
          </select>
        </Field>

        <Field label="Pulse" htmlFor="pulse">
          <input
            id="pulse"
            type="number"
            className="rk-input"
            value={form.pulse_bpm}
            onChange={(e) => update('pulse_bpm', e.target.value)}
          />
        </Field>
        <Field label="Weight (kg)" htmlFor="wt">
          <input
            id="wt"
            type="number"
            step="0.1"
            className="rk-input"
            value={form.weight_kg}
            onChange={(e) => update('weight_kg', e.target.value)}
          />
        </Field>

        <Field label="BP systolic" htmlFor="sys">
          <input
            id="sys"
            type="number"
            className="rk-input"
            value={form.bp_systolic}
            onChange={(e) => update('bp_systolic', e.target.value)}
          />
        </Field>
        <Field label="BP diastolic" htmlFor="dia">
          <input
            id="dia"
            type="number"
            className="rk-input"
            value={form.bp_diastolic}
            onChange={(e) => update('bp_diastolic', e.target.value)}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label="ISBT barcode" htmlFor="isbt">
            <input
              id="isbt"
              className="rk-input font-mono"
              value={form.isbt_barcode}
              onChange={(e) => update('isbt_barcode', e.target.value)}
              required
              minLength={4}
              maxLength={64}
            />
          </Field>
        </div>

        <div className="sm:col-span-2">
          <Field label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              rows={2}
              className="rk-input"
              value={form.notes}
              onChange={(e) => update('notes', e.target.value)}
            />
          </Field>
        </div>

        <div className="sm:col-span-2 flex items-center justify-between">
          <div className="text-xs text-slate-500">
            DB triggers create the QA bag automatically — TTI screening unlocks it for AV.
          </div>
          <button type="submit" className="rk-button-primary" disabled={create.isPending}>
            {create.isPending ? '…' : 'Record donation'}
          </button>
        </div>

        {validationErrors ? (
          <ul className="sm:col-span-2 rounded-md bg-rk-50 p-3 text-sm text-rk-900 ring-1 ring-rk-100">
            {Object.entries(validationErrors).map(([field, msg]) => (
              <li key={field}>
                <code className="font-mono text-xs">{field}</code>: {msg}
              </li>
            ))}
          </ul>
        ) : null}

        {error ? (
          <p className="sm:col-span-2 text-sm text-rk-700">
            {error.error}
            {error.detail ? ` — ${JSON.stringify(error.detail)}` : ''}
          </p>
        ) : null}
      </form>
    </section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// TTI screening tab
// ────────────────────────────────────────────────────────────────────────────
const TTI_FIELDS = [
  { id: 'hiv_status', label: 'HIV' },
  { id: 'hbsag_status', label: 'HBsAg' },
  { id: 'hcv_status', label: 'HCV' },
  { id: 'syphilis_status', label: 'Syphilis' },
  { id: 'malaria_status', label: 'Malaria' },
];
const TTI_RESULTS = [
  { code: 'PE', label: 'Pending' },
  { code: 'NR', label: 'Non-reactive' },
  { code: 'RR', label: 'Reactive' },
  { code: 'ID', label: 'Indeterminate' },
];

const blankScreening = TTI_FIELDS.reduce(
  (acc, f) => ({ ...acc, [f.id]: 'PE' }),
  { notes: '' },
);

function ScreeningEntry({ openId }) {
  const qc = useQueryClient();
  const [donationId, setDonationId] = useState(openId || '');
  const [activeId, setActiveId] = useState(openId || ''); // committed lookup
  const [tti, setTti] = useState(blankScreening);
  const [postedSummary, setPostedSummary] = useState(null);

  // A row clicked in the camp results worklist arrives as a prop instead of
  // through the paste box. Nothing below this line changes: the same
  // POST /donations/:id/screening and the same 4-eyes verify, which is the
  // point — this is a way of REACHING the screening path, not a second one.
  useEffect(() => {
    if (!openId) return;
    setDonationId(openId);
    setActiveId(openId);
    setPostedSummary(null);
    setTti(blankScreening);
  }, [openId]);

  const detailQ = useQuery({
    enabled: Boolean(activeId),
    queryKey: ['donation', activeId],
    queryFn: () => apiRequest('GET', `/donations/${activeId}`),
    staleTime: 5_000,
  });
  const donation = detailQ.data;

  const submitScreening = useMutation({
    mutationFn: () => apiRequest('POST', `/donations/${activeId}/screening`, tti),
    onSuccess: (data) => {
      setPostedSummary(data);
      qc.invalidateQueries({ queryKey: ['donation', activeId] });
    },
  });

  const verifyScreening = useMutation({
    mutationFn: () => apiRequest('POST', `/donations/${activeId}/screening/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['donation', activeId] }),
  });

  const screeningExists = Boolean(donation?.screening_id);
  const verified = Boolean(donation?.verified_at);
  const verificationRequired = donation?.verification_required;

  return (
    <section className="space-y-3">
      <h1 className="text-lg font-semibold text-slate-900">TTI screening</h1>

      <div className="rk-card flex gap-2">
        <input
          className="rk-input flex-1 font-mono text-xs"
          placeholder="Donation ID (UUID)"
          value={donationId}
          onChange={(e) => setDonationId(e.target.value)}
        />
        <button
          type="button"
          className="rk-button-primary"
          onClick={() => {
            setActiveId(donationId.trim());
            setPostedSummary(null);
            setTti(blankScreening);
          }}
        >
          Open
        </button>
      </div>

      {detailQ.isLoading ? (
        <div className="rk-card text-center text-slate-500">…</div>
      ) : null}
      {detailQ.error ? (
        <div className="rk-card text-rk-700">
          {errorMessage(detailQ.error, 'load this donation')}
        </div>
      ) : null}

      {donation ? (
        <article className="rk-card space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Component</div>
              <div className="font-medium">{donation.component_code || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">ISBT</div>
              <div className="font-mono text-xs">{donation.isbt_barcode || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Bag status</div>
              <div className="font-medium">{donation.bag_status || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">Clearance</div>
              <div className="font-medium">{donation.overall_clearance || 'PE'}</div>
            </div>
          </div>

          {!screeningExists ? (
            <ScreeningForm
              tti={tti}
              setTti={setTti}
              onSubmit={() => submitScreening.mutate()}
              busy={submitScreening.isPending}
              error={submitScreening.error?.response?.data?.error}
              postedSummary={postedSummary}
            />
          ) : (
            <div className="space-y-2">
              <div className="rounded-md bg-slate-50 p-3 text-sm">
                Screening recorded by user{' '}
                <span className="font-mono text-xs">{donation.entered_by}</span>.
              </div>
              {verificationRequired && !verified ? (
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                  <p className="font-semibold">4-eyes verification required</p>
                  <p className="text-xs">
                    A second blood-bank user (different from the entry author) must verify before
                    the bag clears or recalls.
                  </p>
                  <button
                    type="button"
                    className="rk-button-primary mt-2"
                    onClick={() => verifyScreening.mutate()}
                    disabled={verifyScreening.isPending}
                  >
                    {verifyScreening.isPending ? '…' : 'Verify screening'}
                  </button>
                  {verifyScreening.error ? (
                    <p className="mt-1 text-xs text-rk-700">
                      {verifyScreening.error?.response?.data?.error}
                    </p>
                  ) : null}
                </div>
              ) : verified ? (
                <div className="rounded-md bg-green-50 p-3 text-sm text-green-900 ring-1 ring-green-200">
                  Verified at {donation.verified_at}.
                </div>
              ) : null}
            </div>
          )}
        </article>
      ) : null}
    </section>
  );
}

function ScreeningForm({ tti, setTti, onSubmit, busy, error, postedSummary }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Enter the test panel. Any RR (reactive) result will require 4-eyes supervisor verification before the system acts (deferral, recall, lookback).</p>
      <div className="space-y-2">
        {TTI_FIELDS.map((f) => (
          <details key={f.id} className="rounded-md border border-slate-200">
            <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-sm">
              <span className="font-medium">{f.label}</span>
              <span
                className={
                  'rounded-full px-2 py-0.5 text-xs font-medium ' +
                  (tti[f.id] === 'RR'
                    ? 'bg-rk-700 text-white'
                    : tti[f.id] === 'NR'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-slate-100 text-slate-700')
                }
              >
                {tti[f.id]}
              </span>
            </summary>
            <div className="flex gap-2 px-3 py-2">
              {TTI_RESULTS.map((r) => (
                <button
                  type="button"
                  key={r.code}
                  className={
                    'rounded-full border px-3 py-1 text-xs font-medium ' +
                    (tti[f.id] === r.code
                      ? 'border-rk-700 bg-rk-50 text-rk-900'
                      : 'border-slate-300 bg-white text-slate-700')
                  }
                  onClick={() => setTti((prev) => ({ ...prev, [f.id]: r.code }))}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </details>
        ))}
      </div>
      <div>
        <label className="rk-label" htmlFor="screening-notes">
          Notes
        </label>
        <textarea
          id="screening-notes"
          rows={2}
          className="rk-input"
          value={tti.notes}
          onChange={(e) => setTti((prev) => ({ ...prev, notes: e.target.value }))}
        />
      </div>
      <button type="button" className="rk-button-primary" onClick={onSubmit} disabled={busy}>
        {busy ? '…' : 'Submit screening'}
      </button>
      {error ? <p className="text-sm text-rk-700">{error}</p> : null}
      {postedSummary ? (
        <div className="rounded-md bg-slate-50 p-3 text-sm">
          Submitted. overall_clearance =
          <span className="ml-1 font-mono">{postedSummary.overall_clearance}</span>
          {postedSummary.verification_required ? ' · 4-eyes required' : ''}
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, htmlFor, children }) {
  return (
    <div>
      <label className="rk-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Opening-stock tab — one-time legacy stock entry at BB onboarding (spec §7).
// Backend POST /inventory/opening-stock accepts a single collection_date and
// an array of {blood_group_id, component_id, units, volume_ml_each} rows.
// ────────────────────────────────────────────────────────────────────────────
const OS_BLOOD_GROUPS = [
  { id: 1, code: 'A+' },
  { id: 2, code: 'A-' },
  { id: 3, code: 'B+' },
  { id: 4, code: 'B-' },
  { id: 5, code: 'AB+' },
  { id: 6, code: 'AB-' },
  { id: 7, code: 'O+' },
  { id: 8, code: 'O-' },
];

const blankBag = { blood_group_id: 7, component_id: 2, units: 1, volume_ml_each: 280 };

function OpeningStock() {
  const qc = useQueryClient();
  const [collectionDate, setCollectionDate] = useState(todayISO());
  const [bags, setBags] = useState([{ ...blankBag }]);
  const [result, setResult] = useState(null);
  const [validationErrors, setValidationErrors] = useState(null);

  const submit = useMutation({
    mutationFn: (payload) => apiRequest('POST', '/inventory/opening-stock', payload),
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
  });

  function trySubmit() {
    setValidationErrors(null);
    const candidate = {
      collection_date: collectionDate,
      bags: bags.map((b) => ({
        blood_group_id: Number(b.blood_group_id),
        component_id: Number(b.component_id),
        units: Number(b.units),
        volume_ml_each: Number(b.volume_ml_each),
      })),
    };
    const parsed = openingStockSchema.safeParse(candidate);
    if (!parsed.success) {
      setValidationErrors(zodFlatten(parsed.error));
      return;
    }
    submit.mutate(parsed.data);
  }

  function updateBag(idx, k, v) {
    setBags((prev) => prev.map((b, i) => (i === idx ? { ...b, [k]: v } : b)));
  }
  function addBag() {
    setBags((prev) => (prev.length >= 50 ? prev : [...prev, { ...blankBag }]));
  }
  function removeBag(idx) {
    setBags((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  const totalUnits = bags.reduce((sum, b) => sum + (Number(b.units) || 0), 0);

  return (
    <section className="space-y-3">
      <h1 className="text-lg font-semibold text-slate-900">Opening stock</h1>
      <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
        One-time entry at onboarding. Bags created here are tagged{' '}
        <code>source='WB'</code> (legacy) and skip TTI gating per spec §6 — they're labelled
        <em> "no TTI record"</em> for matching. Use only for stock that pre-dates platform onboarding.
      </p>

      {result ? (
        <div className="rk-card border-l-4 border-green-500">
          <div className="font-semibold text-green-800">
            {result.bags_created ?? totalUnits} bags created
          </div>
          {result.skipped_reasons ? (
            <p className="text-sm text-slate-600">
              Skipped: {JSON.stringify(result.skipped_reasons)}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rk-card space-y-4">
        <div>
          <label className="rk-label" htmlFor="os-date">
            Collection date (legacy bags share one date)
          </label>
          <input
            id="os-date"
            type="date"
            className="rk-input max-w-[14rem]"
            value={collectionDate}
            onChange={(e) => setCollectionDate(e.target.value)}
            min={isoOffsetDays(-365)}
            max={todayISO()}
          />
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2 text-left">Group</th>
                <th className="px-2 py-2 text-left">Component</th>
                <th className="px-2 py-2 text-right">Units</th>
                <th className="px-2 py-2 text-right">Vol (ml/bag)</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bags.map((b, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">
                    <select
                      aria-label="blood group"
                      className="rk-input"
                      value={b.blood_group_id}
                      onChange={(e) => updateBag(i, 'blood_group_id', e.target.value)}
                    >
                      {OS_BLOOD_GROUPS.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      aria-label="component"
                      className="rk-input"
                      value={b.component_id}
                      onChange={(e) => updateBag(i, 'component_id', e.target.value)}
                    >
                      {COMPONENTS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.code}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min={1}
                      max={100}
                      aria-label="units"
                      className="rk-input text-right"
                      value={b.units}
                      onChange={(e) => updateBag(i, 'units', e.target.value)}
                    />
                  </td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min={50}
                      max={500}
                      aria-label="volume per bag"
                      className="rk-input text-right"
                      value={b.volume_ml_each}
                      onChange={(e) => updateBag(i, 'volume_ml_each', e.target.value)}
                    />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <button
                      type="button"
                      className="text-xs text-rk-700 hover:underline disabled:opacity-30"
                      onClick={() => removeBag(i)}
                      disabled={bags.length <= 1}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="rk-button-secondary"
            onClick={addBag}
            disabled={bags.length >= 50}
          >
            + Add row
          </button>
          <div className="text-sm text-slate-600">
            Total: <strong>{totalUnits}</strong> units across {bags.length} groups
          </div>
        </div>

        <button
          type="button"
          className="rk-button-primary w-full"
          onClick={trySubmit}
          disabled={submit.isPending || bags.length === 0 || totalUnits === 0}
        >
          {submit.isPending ? '…' : 'Submit opening stock'}
        </button>

        {validationErrors ? (
          <ul className="rounded-md bg-rk-50 p-3 text-sm text-rk-900 ring-1 ring-rk-100">
            {Object.entries(validationErrors).map(([field, msg]) => (
              <li key={field}>
                <code className="font-mono text-xs">{field}</code>: {msg}
              </li>
            ))}
          </ul>
        ) : null}

        {submit.error ? (
          <p className="text-sm text-rk-700">
            {errorMessage(submit.error, 'save this')}
          </p>
        ) : null}
      </div>
    </section>
  );
}

// ── Camps ──────────────────────────────────────────────────────────────────
//
// Three surfaces, one tab: the answer queue (which camps need a yes/no), the
// capacity calendar (how many camps we can staff, published a month ahead), and
// the per-camp brief (who is actually coming, and afterwards, whose results are
// still unentered).
//
// The whole point is that the calendar answers most questions BEFORE they are
// asked. Accept/decline is the exception path — a venue 80 km away with no
// power is a reason capacity arithmetic can never express.

// Migration 317's vocabulary, in the order a BB would reach for them. Shown to
// the NGO admin and NEVER to the organiser — they see only that a different
// blood bank is being arranged.
const BB_DECLINE_REASONS = [
  { code: 'NC', label: 'No capacity that day' },
  { code: 'ND', label: 'Staff not on duty' },
  { code: 'DT', label: 'Date clash with another camp' },
  { code: 'VE', label: 'Venue / logistics not workable' },
  { code: 'OT', label: 'Other (please explain)' },
];

// Our own answer, which is NOT the camp's status (migration 317 is a separate
// axis — a declined camp is still happening). Status keeps campStatus.js.
const BB_RESPONSE = {
  AC: { label: 'You accepted', cls: 'bg-green-100 text-green-800' },
  DC: { label: 'You declined', cls: 'bg-rk-700/80 text-white' },
  PE: { label: 'Awaiting your answer', cls: 'bg-amber-100 text-amber-800' },
};

// bb_response NULL is its own state and the easiest one to get wrong. It means
// an organiser named us but the NGO has not partnered us yet, so there is
// nothing to answer — POST /camps/:id/bb-response would 409 not_your_camp. It
// must inform, never nag: no buttons, and not counted in the tab badge.
const BB_NAMED_ONLY = {
  label: 'Named by organiser · NGO reviewing',
  cls: 'bg-slate-100 text-slate-700',
};

function bbResponseBadge(code) {
  return code ? BB_RESPONSE[code] || BB_NAMED_ONLY : BB_NAMED_ONLY;
}

function Pill({ label, cls }) {
  return (
    <span className={'rounded-full px-2 py-0.5 text-xs font-semibold ' + cls}>{label}</span>
  );
}

/** "2 confirmed · 1 pending · 4 of 6 free" for one day, or the unplanned state. */
function OccupancyLine({ day }) {
  if (!day) return null;
  if (!day.published) {
    return <span className="text-slate-500">No capacity published for this day</span>;
  }
  if (day.max_camps === 0) {
    return <span className="font-medium text-rk-700">You are closed this day</span>;
  }
  return (
    <span className={day.ok ? 'text-slate-600' : 'font-medium text-amber-700'}>
      {day.confirmed} of {day.max_camps} camps booked
      {day.pending ? ` · ${day.pending} awaiting review` : ''}
      {day.ok ? ` · ${day.slots_left} free` : ' · day is full'}
    </span>
  );
}

function CampsPanel({ onScreenDonation }) {
  const [view, setView] = useState('requests');
  const [openCampId, setOpenCampId] = useState('');

  if (openCampId) {
    return (
      <CampBriefPanel
        campId={openCampId}
        onBack={() => setOpenCampId('')}
        onScreenDonation={onScreenDonation}
      />
    );
  }

  const VIEWS = [
    { id: 'requests', label: 'Camps' },
    { id: 'calendar', label: 'Plan capacity' },
  ];

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors ' +
              (view === v.id ? 'bg-rk-700 text-white' : 'text-slate-600 hover:text-slate-900')
            }
          >
            {v.label}
          </button>
        ))}
      </div>

      {view === 'requests' ? <CampRequestsPanel onOpen={setOpenCampId} /> : <CampCalendar />}
    </div>
  );
}

// The answer queue. Ordered so the thing needing a decision is at the top and
// the archive is at the bottom — a BB opening this tab should not have to hunt
// for what it is being asked.
function CampRequestsPanel({ onOpen }) {
  const from = todayISO();
  const to = isoOffsetDays(90);

  const campsQ = useQuery({
    queryKey: ['bb-camps', from, to],
    queryFn: () => apiRequest('GET', `/camps/bb/camps?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  // Same range, so every camp card can show what else is booked that day. One
  // request, not one per card, and the numbers come from the same service the
  // booking gate uses so the card and the calendar can never disagree.
  const capQ = useQuery({
    queryKey: ['bb-capacity', from, to],
    queryFn: () => apiRequest('GET', `/camps/bb/capacity?from=${from}&to=${to}`),
    staleTime: 30_000,
  });
  const byDate = useMemo(() => {
    const m = new Map();
    for (const d of capQ.data?.days || []) m.set(d.date, d);
    return m;
  }, [capQ.data]);

  const camps = campsQ.data?.camps || [];
  const groups = [
    { key: 'PE', title: 'Needs your answer', rows: camps.filter((c) => c.bb_response === 'PE') },
    { key: 'AC', title: 'You accepted', rows: camps.filter((c) => c.bb_response === 'AC') },
    {
      key: 'NULL',
      title: 'Named by an organiser · NGO reviewing',
      rows: camps.filter((c) => !c.bb_response),
    },
    { key: 'DC', title: 'You declined', rows: camps.filter((c) => c.bb_response === 'DC') },
  ].filter((g) => g.rows.length);

  if (campsQ.isLoading) return <p className="text-sm text-slate-500">Loading camps…</p>;
  if (campsQ.error) {
    return <p className="text-sm text-rk-700">{errorMessage(campsQ.error, 'load your camps')}</p>;
  }

  return (
    <div className="space-y-6">
      {camps.length === 0 ? (
        <div className="rk-card text-sm text-slate-600">
          <p className="font-medium text-slate-900">No camps in the next 90 days.</p>
          <p className="mt-1">
            Publish your capacity under <strong>Plan capacity</strong> and organisers will be
            able to pick days you can already staff.
          </p>
        </div>
      ) : null}

      {groups.map((g) => (
        <section key={g.key} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {g.title} ({g.rows.length})
          </h2>
          {g.rows.map((c) => (
            <CampAnswerCard
              key={c.id}
              camp={c}
              day={byDate.get(localDayKey(c.scheduled_date))}
              onOpen={onOpen}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function CampAnswerCard({ camp, day, onOpen }) {
  const qc = useQueryClient();
  const [declineOpen, setDeclineOpen] = useState(false);
  const [err, setErr] = useState(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['bb-camps'] });
    qc.invalidateQueries({ queryKey: ['bb-capacity'] });
  };

  const accept = useMutation({
    mutationFn: () => apiRequest('POST', `/camps/${camp.id}/bb-response`, { response: 'AC' }),
    onSuccess: refresh,
    onError: (e) => setErr(errorMessage(e, 'accept this camp')),
  });

  const st = campStatus(camp.status);
  const bb = bbResponseBadge(camp.bb_response);
  const actionable = camp.bb_response === 'PE';

  // The organiser's own number reaches us ONLY on a camp we accepted — the API
  // drops the field otherwise. So this renders when it renders; there is no
  // client-side gate to get wrong.
  const hasContact = camp.submitted_by_name || camp.submitted_by_mobile;

  const expected = Number(camp.target_donor_count) || 0;
  const rsvp = Number(camp.registered_donor_count) || 0;

  return (
    <div className="rk-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onOpen(camp.id)}
            className="text-left text-base font-semibold text-slate-900 hover:text-rk-700"
          >
            {camp.name}
          </button>
          <p className="mt-0.5 text-sm text-slate-600">
            {fmtDate(camp.scheduled_date)}
            {camp.start_time ? ` · ${String(camp.start_time).slice(0, 5)}` : ''}
            {camp.end_time ? `–${String(camp.end_time).slice(0, 5)}` : ''}
          </p>
          <p className="text-sm text-slate-500">
            {[camp.venue, camp.taluka_name, camp.district_name].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Pill label={st.label} cls={st.cls} />
          <Pill label={bb.label} cls={bb.cls} />
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-slate-500">Organiser expects </dt>
          <dd className="inline font-semibold text-slate-900">{expected || '—'}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">Signed up so far </dt>
          <dd
            className={
              'inline font-semibold ' +
              (expected && rsvp > expected ? 'text-rk-700' : 'text-slate-900')
            }
          >
            {rsvp}
            {expected && rsvp > expected ? ' — above the estimate' : ''}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-sm">
        <OccupancyLine day={day} />
      </p>

      {hasContact ? (
        <p className="mt-2 text-sm text-slate-600">
          Host: <span className="font-medium text-slate-900">{camp.submitted_by_name || '—'}</span>
          {camp.submitted_by_mobile ? (
            <>
              {' · '}
              <a className="font-medium text-rk-700" href={`tel:${camp.submitted_by_mobile}`}>
                {camp.submitted_by_mobile}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {camp.bb_response === 'DC' && camp.bb_decline_reason ? (
        <p className="mt-2 text-sm text-slate-600">
          Your reason:{' '}
          {(BB_DECLINE_REASONS.find((r) => r.code === camp.bb_decline_reason) || {}).label ||
            camp.bb_decline_reason}
          {camp.bb_decline_note ? ` — ${camp.bb_decline_note}` : ''}
        </p>
      ) : null}

      {!camp.bb_response ? (
        <p className="mt-2 text-sm text-slate-500">
          The organiser asked for you. Nothing to answer until the NGO confirms the partnership.
        </p>
      ) : null}

      {err ? <p className="mt-2 text-sm text-rk-700">{err}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {actionable ? (
          <>
            <button
              type="button"
              className="rk-button-primary"
              disabled={accept.isPending}
              onClick={() => {
                setErr(null);
                accept.mutate();
              }}
            >
              {accept.isPending ? 'Saving…' : 'Accept this camp'}
            </button>
            <button
              type="button"
              className="rk-button-secondary"
              onClick={() => setDeclineOpen(true)}
            >
              Can&apos;t do this one
            </button>
          </>
        ) : null}
        <button type="button" className="rk-button-secondary" onClick={() => onOpen(camp.id)}>
          Open camp brief
        </button>
      </div>

      {declineOpen ? (
        <CampDeclineModal
          camp={camp}
          onClose={() => setDeclineOpen(false)}
          onDone={() => {
            setDeclineOpen(false);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

// A decline needs a reason because the NGO admin has to find another blood bank
// and "no" alone starts the phone call this feature exists to end. The reason is
// for the admin only — the organiser is told a different blood bank is being
// arranged and nothing more.
function CampDeclineModal({ camp, onClose, onDone }) {
  const [reason, setReason] = useState('NC');
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);

  const m = useMutation({
    mutationFn: (body) => apiRequest('POST', `/camps/${camp.id}/bb-response`, body),
    onSuccess: onDone,
    onError: (e) => setErr(errorMessage(e, 'record your answer')),
  });

  const submit = () => {
    setErr(null);
    m.mutate({ response: 'DC', decline_reason: reason, note: note.trim() || undefined });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">Can&apos;t collect at this camp</h3>
        <p className="mt-1 text-xs text-slate-500">
          The camp still goes ahead — the NGO will arrange another blood bank. Your reason is
          shown to the NGO team only, never to the organiser.
        </p>

        <div className="mt-4 space-y-2">
          {BB_DECLINE_REASONS.map((opt) => (
            <label
              key={opt.code}
              className={
                'flex cursor-pointer items-center gap-2 rounded border p-2 text-sm ' +
                (reason === opt.code
                  ? 'border-rk-700 bg-rk-50'
                  : 'border-slate-200 hover:bg-slate-50')
              }
            >
              <input
                type="radio"
                name="camp_decline_reason"
                value={opt.code}
                checked={reason === opt.code}
                onChange={() => setReason(opt.code)}
              />
              <span className="font-semibold text-slate-900">{opt.label}</span>
            </label>
          ))}
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">
          {reason === 'OT' ? 'Please explain' : 'Note (optional)'}
        </label>
        <textarea
          rows={2}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-rk-700 focus:outline-none"
          placeholder="Anything that helps the NGO place this camp elsewhere."
        />

        {err ? <p className="mt-2 text-xs text-rk-700">Error: {err}</p> : null}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="rk-button-secondary flex-1">
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={m.isPending}
            className="rk-button-primary flex-1"
          >
            {m.isPending ? 'Saving…' : 'Send to NGO'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Plan capacity ──────────────────────────────────────────────────────────
//
// The half of this feature that actually removes the phone calls. A blood bank
// that publishes "6 camps a day, closed the 12th-15th" once a month has already
// answered the question every organiser was going to ring up and ask.
//
// Three states per day, and keeping them distinct is the whole job:
//   not published  we have said nothing - organisers are unconstrained, exactly
//                  as before this shipped. NOT the same as closed.
//   0 camps        published holiday. We are closed and organisers can see it.
//   n camps        n bookable slots, minus whatever is already confirmed.

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function monthLabel(ym) {
  try {
    return new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-IN', {
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return ym;
  }
}

function dayCellClass(day, isToday) {
  const base =
    'relative flex min-h-[4.75rem] flex-col rounded-lg border p-1.5 text-left transition-colors ';
  const ring = isToday ? ' ring-2 ring-rk-700 ring-offset-1' : '';
  if (!day || !day.published) {
    return base + 'border-dashed border-slate-300 bg-white hover:bg-slate-50' + ring;
  }
  if (day.max_camps === 0) {
    return base + 'border-rk-100 bg-rk-50 hover:bg-rk-100' + ring;
  }
  if (!day.ok) {
    return base + 'border-amber-300 bg-amber-50 hover:bg-amber-100' + ring;
  }
  return base + 'border-green-300 bg-green-50 hover:bg-green-100' + ring;
}

/** confirmed as filled pips, pending as hollow ones. Capped so a busy day stays legible. */
function DayPips({ day }) {
  if (!day) return null;
  const conf = Math.min(day.confirmed || 0, 6);
  const pend = Math.min(day.pending || 0, 6 - conf);
  if (!conf && !pend) return null;
  return (
    <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1">
      {Array.from({ length: conf }).map((_, i) => (
        <span key={`c${i}`} className="h-1.5 w-1.5 rounded-full bg-rk-700" />
      ))}
      {Array.from({ length: pend }).map((_, i) => (
        <span key={`p${i}`} className="h-1.5 w-1.5 rounded-full ring-1 ring-inset ring-rk-700" />
      ))}
    </span>
  );
}

function CampCalendar() {
  const qc = useQueryClient();
  const today = todayISO();
  const [month, setMonth] = useState(monthOf(today));
  const [editDate, setEditDate] = useState('');
  const [banner, setBanner] = useState(null);

  const dates = useMemo(() => monthDates(month), [month]);
  const from = dates[0];
  const to = dates[dates.length - 1];

  const settingsQ = useQuery({
    queryKey: ['bb-camp-settings'],
    queryFn: () => apiRequest('GET', '/camps/bb/settings'),
    staleTime: 5 * 60_000,
  });

  const capQ = useQuery({
    queryKey: ['bb-capacity', from, to],
    queryFn: () => apiRequest('GET', `/camps/bb/capacity?from=${from}&to=${to}`),
    staleTime: 30_000,
  });

  const byDate = useMemo(() => {
    const m = new Map();
    for (const d of capQ.data?.days || []) m.set(d.date, d);
    return m;
  }, [capQ.data]);

  const publish = useMutation({
    mutationFn: () => apiRequest('POST', '/camps/bb/capacity/publish-month', { month }),
    onSuccess: (res) => {
      setBanner(
        res.created
          ? `Published ${res.created} day${res.created === 1 ? '' : 's'} for ${monthLabel(month)}. Days you had already set were left alone.`
          : `Every day in ${monthLabel(month)} was already planned - nothing changed.`,
      );
      qc.invalidateQueries({ queryKey: ['bb-capacity'] });
    },
    onError: (e) => setBanner(errorMessage(e, 'plan this month')),
  });

  const settings = settingsQ.data?.settings || null;
  const suggested = settingsQ.data?.suggested_max_camps ?? null;
  const leading = dates.length ? isoDow(from) : 0;

  return (
    <div className="space-y-4">
      <CapacitySettingsBar
        settings={settings}
        suggested={suggested}
        loading={settingsQ.isLoading}
      />

      <div className="rk-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous month"
              className="rk-button-secondary px-2.5 py-1"
              onClick={() => {
                setMonth(shiftMonth(month, -1));
                setBanner(null);
              }}
            >
              &lsaquo;
            </button>
            <span className="min-w-[9.5rem] text-center text-base font-semibold text-slate-900">
              {monthLabel(month)}
            </span>
            <button
              type="button"
              aria-label="Next month"
              className="rk-button-secondary px-2.5 py-1"
              onClick={() => {
                setMonth(shiftMonth(month, 1));
                setBanner(null);
              }}
            >
              &rsaquo;
            </button>
          </div>
          <button
            type="button"
            className="rk-button-primary"
            disabled={publish.isPending}
            onClick={() => {
              setBanner(null);
              publish.mutate();
            }}
          >
            {publish.isPending ? 'Planning...' : 'Plan this month'}
          </button>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          Plan this month fills every day from today onwards using your default number of camps,
          and closes the weekdays you are normally shut. Days you have already set by hand are
          never overwritten.
        </p>

        {banner ? <p className="mt-2 text-sm text-slate-700">{banner}</p> : null}

        <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
          {DOW_LABELS.map((d) => (
            <span key={d}>{d}</span>
          ))}
        </div>

        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: leading }).map((_, i) => (
            <span key={`lead${i}`} />
          ))}
          {dates.map((iso) => {
            const day = byDate.get(iso);
            const past = iso < today;
            return (
              <button
                key={iso}
                type="button"
                onClick={() => setEditDate(iso)}
                className={dayCellClass(day, iso === today) + (past ? ' opacity-60' : '')}
              >
                <span className="text-sm font-semibold text-slate-900">
                  {Number(iso.slice(8, 10))}
                </span>
                <span className="text-[11px] leading-tight text-slate-600">
                  {!day || !day.published
                    ? 'Not planned'
                    : day.max_camps === 0
                      ? 'Closed'
                      : `${day.confirmed}/${day.max_camps} booked`}
                </span>
                {day?.note ? (
                  <span className="truncate text-[10px] leading-tight text-slate-500">
                    {day.note}
                  </span>
                ) : null}
                <DayPips day={day} />
              </button>
            );
          })}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-rk-700 align-middle" />
            confirmed camp
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle ring-1 ring-inset ring-rk-700" />
            waiting for NGO review
          </span>
          <span>
            Green = slots free &middot; Amber = day full &middot; Red = closed &middot; Dashed =
            not planned
          </span>
        </div>
      </div>

      {editDate ? (
        <CapacityDayEditor
          date={editDate}
          day={byDate.get(editDate)}
          suggested={suggested}
          onClose={() => setEditDate('')}
          onDone={() => {
            setEditDate('');
            qc.invalidateQueries({ queryKey: ['bb-capacity'] });
            qc.invalidateQueries({ queryKey: ['bb-camps'] });
          }}
        />
      ) : null}
    </div>
  );
}

// The founder's arithmetic, on screen: 50 staff, 8 per camp, so 6 camps a day.
// Advisory only - max_camps on a given day is what actually binds, so a BB
// borrowing two techs from another branch for one big camp is never blocked by
// a number it did not commit to.
function CapacitySettingsBar({ settings, suggested, loading }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);

  const startEdit = () => {
    setErr(null);
    setForm({
      staff_total: settings?.staff_total ?? '',
      staff_per_camp: settings?.staff_per_camp ?? '',
      default_max_camps: settings?.default_max_camps ?? 1,
      weekly_closed_days: settings?.weekly_closed_days || [],
      auto_accept_within_capacity: !!settings?.auto_accept_within_capacity,
    });
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: (body) => apiRequest('PUT', '/camps/bb/settings', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bb-camp-settings'] });
      setOpen(false);
    },
    onError: (e) => setErr(errorMessage(e, 'save these settings')),
  });

  const submit = () => {
    setErr(null);
    const body = {
      default_max_camps: Number(form.default_max_camps),
      weekly_closed_days: form.weekly_closed_days,
      auto_accept_within_capacity: form.auto_accept_within_capacity,
    };
    // Blanks are omitted, not sent as null: the endpoint upserts with COALESCE,
    // so an omitted field keeps whatever is on record rather than wiping it.
    if (String(form.staff_total).trim() !== '') body.staff_total = Number(form.staff_total);
    if (String(form.staff_per_camp).trim() !== '') {
      body.staff_per_camp = Number(form.staff_per_camp);
    }
    save.mutate(body);
  };

  const toggleDow = (n) =>
    setForm((f) => ({
      ...f,
      weekly_closed_days: f.weekly_closed_days.includes(n)
        ? f.weekly_closed_days.filter((x) => x !== n)
        : [...f.weekly_closed_days, n].sort(),
    }));

  if (loading) return <div className="rk-card text-sm text-slate-500">Loading your setup...</div>;

  if (!open) {
    const closed = (settings?.weekly_closed_days || [])
      .map((n) => DOW_LABELS[n])
      .filter(Boolean)
      .join(', ');
    return (
      <div className="rk-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="text-sm text-slate-700">
            {settings ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  <strong className="text-slate-900">{settings.staff_total ?? '--'}</strong> staff
                </span>
                <span className="text-slate-400">|</span>
                <span>
                  <strong className="text-slate-900">{settings.staff_per_camp ?? '--'}</strong> per
                  camp
                </span>
                <span className="text-slate-400">|</span>
                <span>
                  suggests{' '}
                  <strong className="text-slate-900">{suggested ?? '--'}</strong> camps a day
                </span>
                <span className="text-slate-400">|</span>
                <span>
                  usually plans{' '}
                  <strong className="text-slate-900">{settings.default_max_camps}</strong> a day
                </span>
                {closed ? (
                  <>
                    <span className="text-slate-400">|</span>
                    <span>closed {closed}</span>
                  </>
                ) : null}
                {settings.auto_accept_within_capacity ? (
                  <>
                    <span className="text-slate-400">|</span>
                    <span className="text-green-700">auto-accepts inside capacity</span>
                  </>
                ) : null}
              </p>
            ) : (
              <>
                <p className="font-medium text-slate-900">Tell us how you staff a camp.</p>
                <p className="mt-1">
                  Your headcount and the people one camp needs. We work out how many camps a day
                  that is, and organisers stop ringing up to ask.
                </p>
              </>
            )}
          </div>
          <button type="button" className="rk-button-secondary shrink-0" onClick={startEdit}>
            {settings ? 'Edit setup' : 'Set this up'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rk-card">
      <h2 className="text-sm font-semibold text-slate-900">How you staff a camp</h2>
      <p className="mt-1 text-xs text-slate-500">
        Numbers, not names. These figures only suggest a daily limit - what you set on a day is
        what counts, so borrowing two techs for one big camp is never blocked by this.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="rk-label" htmlFor="cap-staff-total">
            Staff you have
          </label>
          <input
            id="cap-staff-total"
            type="number"
            min={0}
            max={500}
            className="rk-input"
            value={form.staff_total}
            onChange={(e) => setForm({ ...form, staff_total: e.target.value })}
            placeholder="50"
          />
        </div>
        <div>
          <label className="rk-label" htmlFor="cap-staff-per">
            People one camp needs
          </label>
          <input
            id="cap-staff-per"
            type="number"
            min={1}
            max={100}
            className="rk-input"
            value={form.staff_per_camp}
            onChange={(e) => setForm({ ...form, staff_per_camp: e.target.value })}
            placeholder="8"
          />
        </div>
        <div>
          <label className="rk-label" htmlFor="cap-default">
            Camps a day, normally
          </label>
          <input
            id="cap-default"
            type="number"
            min={0}
            max={20}
            className="rk-input"
            value={form.default_max_camps}
            onChange={(e) => setForm({ ...form, default_max_camps: e.target.value })}
          />
        </div>
      </div>

      <p className="mt-2 text-xs text-slate-600">
        {Number(form.staff_total) > 0 && Number(form.staff_per_camp) > 0
          ? `That works out to ${Math.floor(Number(form.staff_total) / Number(form.staff_per_camp))} camps a day.`
          : 'Fill both staff figures and we will work out a suggestion.'}
      </p>

      <fieldset className="mt-4">
        <legend className="rk-label">Days you are normally shut for camps</legend>
        <div className="flex flex-wrap gap-2">
          {DOW_LABELS.map((lbl, n) => (
            <label
              key={lbl}
              className={
                'flex cursor-pointer items-center gap-1.5 rounded border px-2.5 py-1.5 text-sm ' +
                (form.weekly_closed_days.includes(n)
                  ? 'border-rk-700 bg-rk-50 font-semibold text-slate-900'
                  : 'border-slate-200 text-slate-700 hover:bg-slate-50')
              }
            >
              <input
                type="checkbox"
                checked={form.weekly_closed_days.includes(n)}
                onChange={() => toggleDow(n)}
              />
              {lbl}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Only used when you plan a whole month in one go. An exceptional Sunday is still yours to
          open on the calendar.
        </p>
      </fieldset>

      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.auto_accept_within_capacity}
          onChange={(e) => setForm({ ...form, auto_accept_within_capacity: e.target.checked })}
        />
        <span>
          <span className="font-medium text-slate-900">
            Accept camps automatically when the day has room
          </span>
          <br />
          <span className="text-xs text-slate-500">
            Off by default. With this on you are committed the moment an organiser applies, before
            anyone from your team has seen the venue.
          </span>
        </span>
      </label>

      {err ? <p className="mt-3 text-sm text-rk-700">{err}</p> : null}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          className="rk-button-primary"
          disabled={save.isPending}
          onClick={submit}
        >
          {save.isPending ? 'Saving...' : 'Save setup'}
        </button>
        <button type="button" className="rk-button-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// One day, three states, and the editor has to keep them apart:
//   a number   this many camps, bookable
//   0          published holiday - organisers see you are shut
//   removed    back to unplanned, which is silence, not a "no"
//
// Sending max_camps:null is what withdraws the day, so "Remove from plan" is a
// real action here and not just clearing the box.
function CapacityDayEditor({ date, day, suggested, onClose, onDone }) {
  const published = !!day?.published;
  const confirmed = day?.confirmed || 0;
  const pending = day?.pending || 0;

  const [maxCamps, setMaxCamps] = useState(
    published ? String(day.max_camps) : String(suggested ?? 1),
  );
  const [staff, setStaff] = useState(day?.staff_committed ?? '');
  const [note, setNote] = useState(day?.note ?? '');
  const [err, setErr] = useState(null);

  const write = useMutation({
    mutationFn: (days) => apiRequest('PUT', '/camps/bb/capacity', { days }),
    onSuccess: onDone,
    onError: (e) => setErr(errorMessage(e, 'save this day')),
  });

  const n = Number(maxCamps);
  const valid = Number.isInteger(n) && n >= 0 && n <= 20;
  const belowBooked = valid && n < confirmed;

  const save = () => {
    setErr(null);
    if (!valid) {
      setErr('Enter a number between 0 and 20. Use Remove from plan to go back to unplanned.');
      return;
    }
    write.mutate([
      {
        date,
        max_camps: n,
        staff_committed: String(staff).trim() === '' ? null : Number(staff),
        note: note.trim() || null,
      },
    ]);
  };

  const withdraw = () => {
    setErr(null);
    write.mutate([{ date, max_camps: null }]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-900">{fmtDate(date)}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {published
            ? `Planned for ${day.max_camps} camp${day.max_camps === 1 ? '' : 's'}.`
            : 'Not planned yet. Organisers are not being told anything about this day.'}
        </p>

        <p className="mt-2 text-sm text-slate-700">
          <OccupancyLine day={day} />
        </p>

        <label className="mt-4 block rk-label" htmlFor="cap-day-max">
          Camps you can staff this day
        </label>
        <input
          id="cap-day-max"
          type="number"
          min={0}
          max={20}
          className="rk-input"
          value={maxCamps}
          onChange={(e) => setMaxCamps(e.target.value)}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            onClick={() => setMaxCamps('0')}
          >
            Closed this day
          </button>
          {suggested ? (
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setMaxCamps(String(suggested))}
            >
              Your usual {suggested}
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Zero means you are shut and organisers can see it. That is different from leaving the day
          unplanned.
        </p>

        {belowBooked ? (
          <p className="mt-2 text-sm text-amber-700">
            You already have {confirmed} confirmed camp{confirmed === 1 ? '' : 's'} this day.
            Setting {n} will not cancel anything - the day just shows as over its limit until you
            or the NGO move a camp.
          </p>
        ) : null}

        <label className="mt-4 block rk-label" htmlFor="cap-day-staff">
          Staff you are committing (optional)
        </label>
        <input
          id="cap-day-staff"
          type="number"
          min={0}
          max={500}
          className="rk-input"
          value={staff}
          onChange={(e) => setStaff(e.target.value)}
          placeholder="48"
        />

        <label className="mt-4 block rk-label" htmlFor="cap-day-note">
          Note for your team and the NGO (optional)
        </label>
        <input
          id="cap-day-note"
          type="text"
          maxLength={500}
          className="rk-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Diwali, 2 techs on leave"
        />
        <p className="mt-1 text-xs text-slate-500">
          Seen by your team and the NGO only. Organisers never read this.
        </p>

        {err ? <p className="mt-3 text-sm text-rk-700">{err}</p> : null}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="rk-button-secondary flex-1">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={write.isPending}
            className="rk-button-primary flex-1"
          >
            {write.isPending ? 'Saving...' : 'Save day'}
          </button>
        </div>

        {published ? (
          <button
            type="button"
            onClick={withdraw}
            disabled={write.isPending}
            className="mt-3 w-full text-center text-xs font-medium text-slate-500 underline hover:text-rk-700"
          >
            Remove from plan (back to unplanned)
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── One camp, before and after the day ─────────────────────────────────────
//
// Before: what to load into the van. The organiser's estimate and the live
// sign-up count sit next to each other because they diverge - 50 becomes 200 -
// and the whole point is seeing that while still standing in the blood bank.
//
// After: the results worklist. The screening endpoints are reused untouched;
// all this does is give them a way in that is not a pasted UUID.
function CampBriefPanel({ campId, onBack, onScreenDonation }) {
  const campQ = useQuery({
    queryKey: ['bb-camp', campId],
    queryFn: () => apiRequest('GET', `/camps/${campId}`),
  });
  const regQ = useQuery({
    queryKey: ['bb-camp-regs', campId],
    queryFn: () => apiRequest('GET', `/camps/${campId}/registrations`),
    staleTime: 30_000,
  });
  const donQ = useQuery({
    queryKey: ['bb-camp-donations', campId],
    queryFn: () => apiRequest('GET', `/camps/${campId}/donations`),
    staleTime: 15_000,
  });
  const settingsQ = useQuery({
    queryKey: ['bb-camp-settings'],
    queryFn: () => apiRequest('GET', '/camps/bb/settings'),
    staleTime: 5 * 60_000,
  });

  const camp = campQ.data || null;
  const regs = regQ.data?.registrations || [];
  const summary = regQ.data?.summary || null;
  const perCamp = settingsQ.data?.settings?.staff_per_camp ?? null;

  // Sign-ups, excluding the ones who pulled out. This is the number to prepare
  // for; the roster summary's `registered` counts only status 'RG', which drops
  // everyone already marked attended once the day starts.
  const signedUp = useMemo(() => regs.filter((r) => r.status !== 'CN').length, [regs]);
  const expected = Number(camp?.target_donor_count) || 0;
  const overEstimate = expected > 0 && signedUp > expected;

  const groups = useMemo(() => {
    const counts = new Map();
    let unknown = 0;
    for (const r of regs) {
      if (r.status === 'CN') continue;
      if (r.blood_group_code) counts.set(r.blood_group_code, (counts.get(r.blood_group_code) || 0) + 1);
      else unknown += 1;
    }
    return { counts, unknown };
  }, [regs]);

  // Supplies, from the number of people who actually said they are coming.
  // Deliberately arithmetic and not a stored figure: it has to move the moment
  // one more donor signs up, which is the whole complaint being answered.
  const kit = useMemo(() => {
    if (!signedUp) return null;
    const bags = Math.ceil(signedUp * 1.1); // spares for a torn or short-drawn bag
    return {
      bags,
      tubes: signedUp * 2, // one grouping, one TTI
      staff: perCamp ? perCamp : null,
    };
  }, [signedUp, perCamp]);

  const donations = donQ.data?.donations || [];
  const awaitingScreening = donQ.data?.awaiting_screening ?? 0;
  const awaitingVerification = donQ.data?.awaiting_verification ?? 0;

  // The organiser's number reaches us only because this BB accepted - the
  // endpoint strips it otherwise, so there is no client-side gate to get wrong.
  const hostName = camp?.submitted_by_name || camp?.organiser_contact_name || null;
  const hostMobile = camp?.submitted_by_mobile || camp?.organiser_contact_mobile || null;

  if (campQ.isLoading) {
    return (
      <div className="rk-card text-sm text-slate-500">
        <button type="button" className="mb-3 text-sm text-rk-700 underline" onClick={onBack}>
          Back to camps
        </button>
        <p>Loading this camp...</p>
      </div>
    );
  }

  if (campQ.isError || !camp) {
    return (
      <div className="rk-card">
        <button type="button" className="mb-3 text-sm text-rk-700 underline" onClick={onBack}>
          Back to camps
        </button>
        <p className="text-sm text-rk-700">{errorMessage(campQ.error, 'open this camp')}</p>
      </div>
    );
  }

  const st = campStatus(camp.status);
  const resp = bbResponseBadge(camp.bb_response);

  return (
    <div className="space-y-4">
      <button type="button" className="text-sm text-rk-700 underline" onClick={onBack}>
        Back to camps
      </button>

      <div className="rk-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{camp.name}</h3>
            <p className="mt-0.5 text-sm text-slate-600">
              {fmtDate(camp.scheduled_date)}
              {camp.start_time ? ` · ${String(camp.start_time).slice(0, 5)}` : ''}
              {camp.end_time ? ` to ${String(camp.end_time).slice(0, 5)}` : ''}
            </p>
            <p className="mt-0.5 text-sm text-slate-600">
              {camp.venue}
              {camp.address_line ? `, ${camp.address_line}` : ''}
              {camp.district_name ? ` · ${camp.district_name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill label={st.label} cls={st.cls} />
            <Pill label={resp.label} cls={resp.cls} />
          </div>
        </div>

        {hostName || hostMobile ? (
          <div className="mt-3 border-t border-slate-200 pt-3 text-sm">
            <p className="text-slate-700">
              <span className="font-medium">Organiser:</span> {hostName || 'Name not given'}
            </p>
            {hostMobile ? (
              <a className="text-rk-700 underline" href={`tel:${hostMobile}`}>
                {hostMobile}
              </a>
            ) : null}
            <p className="mt-1 text-xs text-slate-500">
              You can see this because you accepted this camp. Use it for gate access, table
              space and power on the day.
            </p>
          </div>
        ) : null}
      </div>

      <div className="rk-card">
        <h4 className="text-sm font-semibold text-slate-900">How many people are coming</h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-sand/60 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Organiser said</p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{expected || '--'}</p>
          </div>
          <div
            className={
              'rounded-lg p-3 ' + (overEstimate ? 'bg-rk-50 ring-1 ring-rk-700' : 'bg-sand/60')
            }
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">Signed up so far</p>
            <p
              className={
                'mt-1 text-2xl font-semibold ' +
                (overEstimate ? 'text-rk-700' : 'text-slate-900')
              }
            >
              {signedUp}
            </p>
          </div>
        </div>
        {overEstimate ? (
          <p className="mt-2 text-sm font-medium text-rk-700">
            {signedUp - expected} more than the organiser estimated. Load for {signedUp}, not{' '}
            {expected}.
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            Sign-ups keep coming in. Check this again on the morning of the camp.
          </p>
        )}
        {regQ.isError ? (
          <p className="mt-2 text-sm text-rk-700">
            {errorMessage(regQ.error, 'read the sign-up list')}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rk-card">
          <h4 className="text-sm font-semibold text-slate-900">Blood groups signed up</h4>
          {signedUp === 0 ? (
            <p className="mt-2 text-sm text-slate-500">Nobody has signed up yet.</p>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {GRID_GROUPS.map((g) => (
                  <div key={g} className="rounded-lg bg-sand/60 p-2 text-center">
                    <p className="text-xs font-semibold text-slate-500">{g}</p>
                    <p className="text-lg font-semibold tabular-nums text-slate-900">
                      {groups.counts.get(g) || 0}
                    </p>
                  </div>
                ))}
              </div>
              {groups.unknown ? (
                <p className="mt-2 text-sm text-amber-700">
                  {groups.unknown} donor{groups.unknown === 1 ? '' : 's'} with no verified group
                  yet - they will need grouping at the camp.
                </p>
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  Every donor signed up has a verified group on record.
                </p>
              )}
            </>
          )}
        </div>

        <div className="rk-card">
          <h4 className="text-sm font-semibold text-slate-900">Suggested to load</h4>
          {!kit ? (
            <p className="mt-2 text-sm text-slate-500">
              Nothing to work out until people start signing up.
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-1 text-sm text-slate-700">
                <li>
                  <span className="font-semibold tabular-nums">{kit.bags}</span> collection bags
                  <span className="text-slate-500"> (sign-ups plus 10% spare)</span>
                </li>
                <li>
                  <span className="font-semibold tabular-nums">{kit.tubes}</span> sample tubes
                  <span className="text-slate-500"> (grouping + TTI, 2 each)</span>
                </li>
                {kit.staff ? (
                  <li>
                    <span className="font-semibold tabular-nums">{kit.staff}</span> staff
                    <span className="text-slate-500"> (your figure for one camp)</span>
                  </li>
                ) : null}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                A starting point worked out from sign-ups, not a requisition. Your own judgement
                on the day wins.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="rk-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-900">Results from this camp</h4>
          <p className="text-xs text-slate-500">
            {donations.length} donation{donations.length === 1 ? '' : 's'} recorded
            {awaitingScreening ? ` · ${awaitingScreening} awaiting screening` : ''}
            {awaitingVerification ? ` · ${awaitingVerification} awaiting verify` : ''}
          </p>
        </div>

        {donQ.isLoading ? (
          <p className="mt-2 text-sm text-slate-500">Loading...</p>
        ) : donQ.isError ? (
          <p className="mt-2 text-sm text-rk-700">
            {errorMessage(donQ.error, 'read the donations from this camp')}
          </p>
        ) : donations.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Nothing recorded yet. Donations you enter with this camp selected will appear here,
            ready for screening.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">
              Tap a row to enter or check its TTI results. Matching a paper sheet: the last four
              digits of the mobile are shown.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">Donor</th>
                    <th className="py-2 pr-3">Mobile</th>
                    <th className="py-2 pr-3">Group</th>
                    <th className="py-2 pr-3">Bag</th>
                    <th className="py-2 pr-3">Screening</th>
                  </tr>
                </thead>
                <tbody>
                  {donations.map((d) => {
                    const pill = screeningPill(d);
                    return (
                      <tr
                        key={d.donation_id}
                        className="cursor-pointer border-b border-slate-100 hover:bg-sand/50"
                        onClick={() => onScreenDonation(d.donation_id)}
                      >
                        <td className="py-2 pr-3 font-medium text-slate-900">
                          {d.full_name || 'Name not on record'}
                          {d.is_invalidated ? (
                            <span className="ml-2 text-xs font-semibold text-rk-700">
                              discarded
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 tabular-nums text-slate-600">
                          {d.mobile_masked || '--'}
                        </td>
                        <td className="py-2 pr-3 text-slate-600">{d.blood_group_code || '--'}</td>
                        <td className="py-2 pr-3 tabular-nums text-slate-600">
                          {d.isbt_barcode || '--'}
                        </td>
                        <td className="py-2 pr-3">
                          <Pill label={pill.label} cls={pill.cls} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// The screening state of one donation, in four words or fewer. Derived, never
// stored: the same three fields the screening endpoints already return.
function screeningPill(d) {
  if (!d.screening_id) return { label: 'Not entered', cls: 'bg-slate-100 text-slate-700' };
  if (d.overall_clearance === 'CL') return { label: 'Cleared', cls: 'bg-green-100 text-green-800' };
  if (d.overall_clearance === 'IN') {
    return { label: 'Not usable', cls: 'bg-rk-700/80 text-white' };
  }
  if (!d.verified_at) return { label: 'Awaiting verify', cls: 'bg-amber-100 text-amber-800' };
  return { label: 'Entered', cls: 'bg-slate-100 text-slate-700' };
}
