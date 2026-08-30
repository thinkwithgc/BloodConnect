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
import { InstitutionBanner } from '../../components/institution/InstitutionBanner.jsx';
import { campStatus, campStatusLabel } from '../../lib/campStatus.js';
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
    { id: 'dashboard', label: t('bb_tab_dashboard') },
    { id: 'camps', label: t('bb_tab_camps'), badge: campBadge },
    { id: 'incoming', label: t('bb_tab_incoming') },
    { id: 'committed', label: t('bb_tab_committed') },
    { id: 'donors_in', label: t('bb_tab_donors_in') },
    { id: 'inventory', label: t('inventory') },
    { id: 'record', label: t('record_donation') },
    { id: 'screening', label: t('tti_screening') },
    { id: 'opening', label: t('opening_stock') },
    { id: 'import', label: t('bb_tab_import') },
    { id: 'team', label: t('bb_tab_team') },
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
      <Header subtitle={t('bb_subtitle')} />
      <main className="mx-auto w-full max-w-4xl px-4 py-6">
        <InstitutionBanner fallback={t('bb_subtitle')} />
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
// `key` is the translated label; `label` stays as the English fallback for any
// caller without `t` in scope. Same shape as lib/campStatus.js.
const URG = {
  CR: { key: 'bb_urg_CR', label: 'Critical', cls: 'bg-rk-700 text-white' },
  UR: { key: 'bb_urg_UR', label: 'Urgent', cls: 'bg-amber-500 text-white' },
  PL: { key: 'bb_urg_PL', label: 'Planned', cls: 'bg-slate-300 text-slate-800' },
};

// "14 सप्टें". Month names come from the string pack, never
// toLocaleDateString('mr-IN'): Intl's Marathi short-month data is not reliably
// present and its forms are unpredictable. Digits stay Latin in every language.
function fmtDate(v, t) {
  if (!v) return '—';
  const ymd = String(v).slice(0, 10);
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return String(v);
  const months = t ? t('camp_months_short') : null;
  const mn = Array.isArray(months) ? months[m - 1] : m;
  return `${d} ${mn}`;
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
  const { t } = useT();
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
        <KpiCard
          label={t('bb_kpi_available')}
          value={k.available_units ?? 0}
          tone="text-green-700"
        />
        <KpiCard
          label={t('bb_kpi_expired')}
          value={k.expired_units ?? 0}
          tone={k.expired_units ? 'text-rk-700' : 'text-slate-900'}
        />
        <KpiCard
          label={t('bb_kpi_expiring_48h')}
          value={k.expiring_48h ?? 0}
          tone={k.expiring_48h ? 'text-rk-700' : 'text-slate-900'}
        />
        <KpiCard
          label={t('bb_kpi_pending_tti')}
          value={k.pending_tti ?? 0}
          tone={k.pending_tti ? 'text-amber-600' : 'text-slate-900'}
        />
        <KpiCard label={t('bb_kpi_issued_month')} value={k.issued_this_month ?? 0} />
        <KpiCard label={t('bb_kpi_donations_today')} value={k.donations_today ?? 0} />
      </div>

      {/* Inventory grid */}
      <article className="rk-card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          {t('bb_inv_glance')}
        </h2>
        {components.length === 0 ? (
          <p className="text-sm text-slate-500">{t('bb_inv_empty')}</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 text-left">{t('bb_col_group')}</th>
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
            <p className="mt-2 text-xs text-slate-400">{t('bb_inv_cell_note')}</p>
          </>
        )}
      </article>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Incoming requests */}
        <article className="rk-card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
            {t('bb_incoming_district')}
          </h2>
          {(d.incoming_requests || []).length === 0 ? (
            <p className="text-sm text-slate-500">{t('bb_incoming_empty')}</p>
          ) : (
            <ul className="space-y-2">
              {d.incoming_requests.map((r) => {
                const u = URG[r.urgency_tier] || URG.PL;
                return (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${u.cls}`}>
                      {t(u.key)}
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
            {t('bb_recent_donations')}
          </h2>
          {(d.recent_donations || []).length === 0 ? (
            <p className="text-sm text-slate-500">{t('bb_recent_donations_empty')}</p>
          ) : (
            <ul className="space-y-2">
              {d.recent_donations.map((dn) => (
                <li key={dn.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-900">{dn.donor_name}</span>
                  <span className="text-xs text-slate-500">
                    {dn.component} · {dn.volume_ml}ml · {fmtDate(dn.collection_date, t)}
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
function fmtAge(mins, t) {
  if (mins == null) return '—';
  const m = Math.floor(mins);
  if (m < 60) return t('bb_age_m', { n: m });
  const h = Math.floor(m / 60);
  // Past a day, keep reading in days — "960h 33m ago" is unreadable at a glance,
  // and this sits next to a Critical badge where age drives triage.
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const remH = h % 24;
    return remH === 0 ? t('bb_age_d', { n: d }) : t('bb_age_dh', { d, h: remH });
  }
  const rem = m % 60;
  return rem === 0 ? t('bb_age_h', { n: h }) : t('bb_age_hm', { h, m: rem });
}

function OpenRequestsPanel() {
  const { t } = useT();
  const q = useQuery({
    queryKey: ['bb', 'open-requests'],
    queryFn: () => apiRequest('GET', '/inventory/open-requests'),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  if (q.isLoading)
    return <div className="rk-card text-center text-slate-500">{t('bb_loading')}</div>;
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
            {t('bb_req_title')}
          </h2>
          <span className="text-xs text-slate-400">{t('bb_refresh_15')}</span>
        </div>
        {requests.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{t('bb_req_none')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {requests.map((r) => (
              <OpenRequestCard key={r.id} r={r} />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-slate-400">{t('bb_req_note')}</p>
    </section>
  );
}

function OpenRequestCard({ r }) {
  const { t } = useT();
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
          <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.cls}`}>{t(u.key)}</span>
          <span className="font-mono text-[11px] text-slate-500">{r.request_number}</span>
          {iOfferedAny ? (
            <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
              {t('bb_req_you_offered', { n: r.units_i_committed })}
            </span>
          ) : null}
          {!r.is_same_district ? (
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
              {t('bb_req_adjacent')}
            </span>
          ) : null}
        </div>
        <span className="text-xs text-slate-500">{fmtAge(r.mins_since_raised, t)}</span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-slate-500">{t('bb_lbl_requesting')}</div>
          <div className="text-sm font-semibold text-slate-900">{r.hospital_name}</div>
          <div className="text-xs text-slate-500">
            {t('bb_lbl_district', { d: r.hospital_district })}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">{t('bb_lbl_required')}</div>
          <div className="text-sm font-semibold text-slate-900">
            {r.blood_group} · {r.component}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>
            <span className="font-bold text-slate-900">{r.units_committed}</span> /{' '}
            <span className="font-bold text-slate-900">{r.units_required}</span>{' '}
            {t('bb_req_committed')}
            {r.units_committed > 0 && !iOfferedAny ? t('bb_req_by_others') : ''}
          </span>
          <span>
            <span className="font-bold text-rk-700">{r.units_still_needed}</span>{' '}
            {t('bb_req_still_needed')}
          </span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full bg-green-500" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="mt-3 rounded bg-slate-50 p-2 text-xs">
        <div className="font-semibold text-slate-700">{t('bb_req_your_stock')}</div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-slate-600">
          <span>
            {t('bb_req_exact', { g: r.blood_group })}{' '}
            <span className="font-bold text-slate-900">{r.exact_units}</span>
          </span>
          {r.fallback_units > 0 ? (
            <span>
              {t('bb_req_fallback')}{' '}
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
          {t('bb_req_cant')}
        </button>
        {canOffer ? (
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            className="rounded bg-rk-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rk-800"
          >
            {t(r.units_i_can_offer === 1 ? 'bb_req_offer_1' : 'bb_req_offer_n', {
              n: r.units_i_can_offer,
            })}
          </button>
        ) : (
          <span className="text-xs italic text-slate-400">
            {t(iOfferedAny ? 'bb_req_offered_done' : 'bb_req_no_more')}
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
            {t('bb_open_chat')}
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
  const { t } = useT();
  const [reason, setReason] = useState('NS');
  const [note, setNote] = useState('');
  const [err, setErr] = useState(null);

  const m = useMutation({
    mutationFn: (body) =>
      apiRequest('POST', `/inventory/open-requests/${r.id}/decline`, body),
    onSuccess: onDone,
    onError: (e) => setErr(errorMessage(e, 'record that you cannot fulfil this')),
  });

  // `code` is the reason posted to the API — never translate it.
  const REASONS = ['NS', 'NC', 'ND'].map((code) => ({
    code,
    label: t('bb_dm_' + code),
    hint: t('bb_dm_' + code + '_hint'),
  }));

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
          {t('bb_dm_title', { num: r.request_number })}
        </h3>
        <p className="mt-1 text-xs text-slate-500">{t('bb_dm_sub')}</p>

        <div className="mt-4 space-y-2">
          {REASONS.map((opt) => (
            <label
              key={opt.code}
              className={
                'flex cursor-pointer flex-col gap-1 rounded border p-2 text-sm ' +
                (reason === opt.code
                  ? 'border-rk-700 bg-rk-50'
                  : 'border-slate-200 hover:bg-slate-50')
              }
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="decline_reason"
                  value={opt.code}
                  checked={reason === opt.code}
                  onChange={() => setReason(opt.code)}
                />
                <span className="font-semibold text-slate-900">{opt.label}</span>
              </div>
              <span className="pl-6 text-xs text-slate-500">{opt.hint}</span>
            </label>
          ))}
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">
          {t('bb_dm_note')}
        </label>
        <textarea
          rows={2}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-rk-700 focus:outline-none"
          placeholder={t('bb_dm_note_ph')}
        />

        {err ? <p className="mt-2 text-xs text-rk-700">Error: {err}</p> : null}

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {t('bb_cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={m.isPending}
            className="flex-1 rounded bg-rk-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rk-800 disabled:opacity-60"
          >
            {m.isPending ? t('bb_saving') : t('bb_dm_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

function OfferModal({ r, onClose, onDone }) {
  const { t } = useT();
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
      setErr(t('bb_err_number'));
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
          {t('bb_om_title', { num: r.request_number })}
        </h3>
        <p className="mt-1 text-xs text-slate-500">
          {r.hospital_name} · {r.blood_group} · {r.component} · {r.units_still_needed}{' '}
          {t('bb_req_still_needed')}
        </p>

        <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">
          {t('bb_om_units', { max })}
        </label>
        <input
          type="number"
          min={1}
          max={max}
          value={units}
          onChange={(e) => setUnits(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-lg font-semibold text-slate-900 focus:border-rk-700 focus:outline-none"
        />
        <p className="mt-2 text-xs text-slate-500">{t('bb_om_help')}</p>

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
              <span className="font-semibold text-slate-800">{t('bb_om_repl')}</span>
              <span className="mt-1 block text-xs text-slate-500">
                {t('bb_om_repl_a')}
                <em>{t('bb_om_repl_em')}</em>
                {t('bb_om_repl_b')}
              </span>
            </span>
          </label>
          {needsReplacement ? (
            <div className="mt-3 flex items-center gap-2 text-xs">
              <label className="font-semibold text-slate-600">{t('bb_om_deadline')}</label>
              <select
                value={deadlineDays}
                onChange={(e) => setDeadlineDays(e.target.value)}
                className="rounded border border-slate-300 bg-white px-2 py-1"
              >
                {[7, 14, 21, 30].map((n) => (
                  <option key={n} value={n}>
                    {t('bb_om_days', { n })}
                  </option>
                ))}
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
            {t('bb_cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={m.isPending}
            className="flex-1 rounded bg-rk-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rk-800 disabled:opacity-60"
          >
            {m.isPending ? t('bb_om_reserving') : t('bb_om_confirm', { n: units })}
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
  OP: { key: 'bb_rs_OP', cls: 'bg-amber-100 text-amber-800' },
  MT: { key: 'bb_rs_MT', cls: 'bg-blue-100 text-blue-800' },
  AS: { key: 'bb_rs_AS', cls: 'bg-blue-100 text-blue-800' },
  PF: { key: 'bb_rs_PF', cls: 'bg-amber-100 text-amber-800' },
  FU: { key: 'bb_rs_FU', cls: 'bg-green-100 text-green-800' },
  CL: { key: 'bb_rs_CL', cls: 'bg-slate-200 text-slate-700' },
  CA: { key: 'bb_rs_CA', cls: 'bg-slate-200 text-slate-600' },
};

function MyCommitmentsPanel() {
  const { t } = useT();
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
          {t('bb_com_title')}
        </h2>
        <span className="text-xs text-slate-400">{t('bb_refresh_20')}</span>
      </div>

      {rows.length === 0 ? (
        <p className="rk-card py-6 text-center text-sm text-slate-500">
          {t('bb_com_none_a')}
          <span className="font-medium">{t('bb_tab_incoming')}</span>
          {t('bb_com_none_b')}
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
  const { t } = useT();
  const stages = [
    { id: 'reserved', n: r.units_reserved, cls: 'bg-slate-400' },
    { id: 'issued', n: r.units_issued, cls: 'bg-blue-500' },
    { id: 'received', n: r.units_received, cls: 'bg-indigo-500' },
    { id: 'transfused', n: r.units_transfused, cls: 'bg-green-600' },
  ].filter((s) => s.n > 0);
  if (stages.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
      {stages.map((s) => (
        <span key={s.id} className="inline-flex items-center gap-1">
          <span className={`inline-block h-2 w-2 rounded-full ${s.cls}`} />
          {s.n} {t('bb_pip_' + s.id)}
        </span>
      ))}
    </div>
  );
}

function CommitmentCard({ r }) {
  const { t } = useT();
  const qc = useQueryClient();
  const [err, setErr] = useState(null);
  const st = REQ_STATUS[r.status] || { key: null, cls: 'bg-slate-100 text-slate-700' };
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
        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.cls}`}>{t(u.key)}</span>
        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${st.cls}`}>
          {st.key ? t(st.key) : r.status}
        </span>
        <span className="font-mono text-[11px] text-slate-500">{r.request_number}</span>
        <span className="ml-auto text-xs text-slate-500">{fmtAge(r.mins_since_raised, t)}</span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div>
          <div className="text-xs uppercase text-slate-500">{t('bb_lbl_requesting')}</div>
          <div className="text-sm font-semibold text-slate-900">{r.hospital_name}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">{t('bb_lbl_required')}</div>
          <div className="text-sm font-semibold text-slate-900">
            {r.blood_group} · {r.component}
          </div>
          <div className="text-xs text-slate-500">
            {t('bb_com_total', { com: r.units_committed_total, req: r.units_required })}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">
            {t(r.units_i_committed === 1 ? 'bb_com_your_1' : 'bb_com_your_n', {
              n: r.units_i_committed,
            })}
          </div>
          <ChainPips r={r} />
        </div>
      </div>

      {owesReplacement ? (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {t('bb_com_repl', {
            done: r.replacement_units_fulfilled,
            target: r.replacement_units_target,
            date: fmtDate(r.replacement_deadline, t),
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
              ? t('bb_com_issuing')
              : t(r.units_reserved === 1 ? 'bb_com_issue_1' : 'bb_com_issue_n', {
                  n: r.units_reserved,
                })}
          </button>
        ) : null}
        <Link
          to={`/bb/requests/${r.id}`}
          className="text-xs font-semibold text-rk-700 hover:underline"
        >
          {t('bb_open_chat')}
        </Link>
        {r.closed_at ? (
          <span className="text-xs text-slate-400">
            {t('bb_com_closed', { date: fmtDate(r.closed_at, t) })}
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
  const { t } = useT();
  const q = useQuery({
    queryKey: ['bb', 'incoming-donors'],
    queryFn: () => apiRequest('GET', '/inventory/incoming-donors'),
    refetchInterval: 20_000,
    staleTime: 15_000,
  });

  if (q.isLoading)
    return <div className="rk-card text-center text-slate-500">{t('bb_loading')}</div>;
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
            {t('bb_inc_title')}
          </h2>
          <span className="text-xs text-slate-400">{t('bb_refresh_20')}</span>
        </div>
        {donors.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">{t('bb_inc_none')}</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {donors.map((d) => (
              <IncomingDonorCard key={d.choice_id} d={d} />
            ))}
          </ul>
        )}
      </div>
      <p className="text-xs text-slate-400">{t('bb_inc_note')}</p>
    </section>
  );
}

function IncomingDonorCard({ d }) {
  const { t } = useT();
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
          <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${u.cls}`}>{t(u.key)}</span>
          <span className="font-mono text-[11px] text-slate-500">{d.request_number}</span>
          {isArrived ? (
            <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
              {t('bb_inc_arrived_chip')}
            </span>
          ) : (
            <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
              {t('bb_inc_expected_chip')}
            </span>
          )}
        </div>
        {d.distance_to_bb_km != null ? (
          <span className="text-xs text-slate-500">
            {Number(d.distance_to_bb_km).toFixed(1)} {t('bb_km')}
          </span>
        ) : null}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-slate-500">{t('bb_lbl_donor')}</div>
          <div className="text-sm font-semibold text-slate-900">{d.donor_name}</div>
          <a
            href={`tel:${d.donor_mobile}`}
            className="text-xs font-mono text-rk-700 hover:underline"
          >
            {d.donor_mobile}
          </a>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">{t('bb_inc_fulfilling')}</div>
          <div className="text-sm font-semibold text-slate-900">
            {d.blood_group} · {d.component}
          </div>
          <div className="text-xs text-slate-500">
            {t('bb_inc_for_line', {
              hospital: d.hospital_name,
              district: d.hospital_district_name,
            })}
          </div>
        </div>
      </div>

      {d.expected_arrival_at ? (
        <div className="mt-2 text-xs text-slate-500">
          {t('bb_inc_expected_at', {
            when: new Date(d.expected_arrival_at).toLocaleString('en-IN'),
          })}
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
            {arrivedM.isPending ? t('bb_saving') : t('bb_inc_mark_arrived')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setDeferOpen(true)}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          {t('bb_inc_defer')}
        </button>
        <button
          type="button"
          onClick={() => noShowM.mutate()}
          disabled={noShowM.isPending}
          className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        >
          {noShowM.isPending ? t('bb_saving') : t('bb_inc_noshow')}
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
  const { t } = useT();
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
        <h3 className="text-base font-semibold text-slate-900">{t('bb_df_title')}</h3>
        <p className="mt-1 text-xs text-slate-500">{t('bb_df_sub')}</p>
        <textarea
          rows={3}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
          className="mt-3 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-rk-700 focus:outline-none"
          placeholder={t('bb_df_ph')}
        />
        {err ? <p className="mt-2 text-xs text-rk-700">Error: {err}</p> : null}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            {t('bb_cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              if (reason.trim().length < 3) {
                setErr(t('bb_err_reason_short'));
                return;
              }
              m.mutate({ reason: reason.trim() });
            }}
            disabled={m.isPending}
            className="flex-1 rounded bg-rk-700 px-3 py-2 text-sm font-semibold text-white hover:bg-rk-800 disabled:opacity-60"
          >
            {m.isPending ? t('bb_saving') : t('bb_df_confirm')}
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
  const { t } = useT();
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
        <h1 className="text-lg font-semibold text-slate-900">{t('bb_inv_title')}</h1>
        <select
          aria-label={t('bb_inv_filter')}
          className="rk-input max-w-[12rem]"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">{t('bb_inv_all')}</option>
          {['QA', 'AV', 'RE', 'IS', 'TR', 'EX', 'RC'].map((code) => (
            <option key={code} value={code}>
              {t('bb_inv_' + code)}
            </option>
          ))}
        </select>
      </div>

      {inventoryQ.isLoading ? (
        <div className="rk-card text-center text-slate-500">…</div>
      ) : bags.length === 0 ? (
        <div className="rk-card text-sm text-slate-500">
          {statusFilter ? t('bb_inv_none_in', { s: statusFilter }) : t('bb_inv_none')}
        </div>
      ) : (
        <div className="rk-card overflow-x-auto p-0">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">ISBT</th>
                <th className="px-3 py-2 text-left">{t('bb_th_group')}</th>
                <th className="px-3 py-2 text-left">{t('bb_th_component')}</th>
                <th className="px-3 py-2 text-right">{t('bb_th_volume')}</th>
                <th className="px-3 py-2 text-left">{t('bb_th_status')}</th>
                <th className="px-3 py-2 text-left">{t('bb_th_expiry')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bags.map((b) => (
                <tr key={b.id}>
                  <td className="px-3 py-2 font-mono text-xs">{b.isbt_barcode}</td>
                  <td className="px-3 py-2 font-semibold">{b.blood_group_code || '—'}</td>
                  <td className="px-3 py-2">{b.component_code || '—'}</td>
                  <td className="px-3 py-2 text-right">{b.volume_ml ?? '—'} {t('bb_ml')}</td>
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
  const { t } = useT();
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
      <h1 className="text-lg font-semibold text-slate-900">{t('bb_rd_title')}</h1>

      {result ? (
        <div className="rk-card border-l-4 border-green-500">
          <div className="font-mono text-xs text-slate-700">{result.donation_id}</div>
          <div className="font-semibold text-green-800">{t('bb_rd_saved')}</div>
          <div className="text-sm text-slate-600">
            {t('bb_rd_isbt_line', {
              isbt: result.isbt_barcode,
              status: result.inventory_bag?.status || t('bb_rd_pending'),
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500">{t('bb_rd_next_step')}</p>
          {result.camp ? (
            <p className="mt-2 text-xs text-rk-900">
              {t('bb_rd_camp_pre')}
              <strong>{result.camp.name}</strong>
              {t('bb_rd_camp_mid', { date: result.camp.scheduled_date })}
              <strong>{t('bb_rd_camp_att')}</strong>
              {t('bb_rd_camp_post')}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <button type="button" className="rk-button-secondary" onClick={nextDonor}>
              {result.camp ? t('bb_rd_next_camp') : t('bb_rd_another')}
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
              {t('bb_rd_camp_label')}
            </label>
            <select
              id="camp"
              className="rk-input mt-1"
              value={campId}
              onChange={(e) => setCampChoice(e.target.value)}
            >
              <option value="">{t('bb_rd_inhouse')}</option>
              {campList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} - {c.scheduled_date} - {c.venue || c.district_name}
                </option>
              ))}
            </select>
            {selectedCamp ? (
              <p className="mt-2 text-xs text-rk-900">
                {t('bb_rd_sel_a')}
                <strong>{t('bb_rd_camp_att')}</strong>
                {t('bb_rd_sel_b')}
                <strong>{selectedCamp.donations_recorded}</strong>
                {t('bb_rd_sel_c', {
                  extra:
                    batchCount > 0 ? t('bb_rd_sel_sitting', { n: batchCount }) : '',
                })}
              </p>
            ) : (
              <p className="mt-2 text-xs text-slate-600">
                {campList.length === 1
                  ? t('bb_rd_pick_1')
                  : t('bb_rd_pick_n', { n: campList.length })}{' '}
                {t('bb_rd_pick_help')}
              </p>
            )}
          </div>
        ) : null}

        <div className="sm:col-span-2 space-y-2">
          <label className="rk-label" htmlFor="donor-mobile">
            {t('bb_rd_lookup_label')}
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
                {t('bb_rd_clear')}
              </button>
            ) : (
              <button
                type="button"
                className="rk-button-primary"
                onClick={() => lookup.mutate(mobileQuery.trim())}
                disabled={lookup.isPending || mobileQuery.trim().length < 10}
              >
                {lookup.isPending ? '…' : t('bb_rd_lookup_btn')}
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
                    ? t('bb_rd_bg_verified', { g: donorPreview.blood_group_verified_code })
                    : donorPreview.blood_group_self_reported_code
                      ? t('bb_rd_bg_self', {
                          g: donorPreview.blood_group_self_reported_code,
                        })
                      : t('bb_rd_bg_none')}
                </span>
                <span
                  className={
                    'rounded-full px-2 py-0.5 font-medium ' +
                    (donorPreview.deferral_status === 'P' || donorPreview.deferral_status === 'T'
                      ? 'bg-rk-700 text-white'
                      : 'bg-green-100 text-green-800')
                  }
                >
                  {t('bb_rd_deferral', { s: donorPreview.deferral_status || 'N' })}
                </span>
                {donorPreview.next_eligible_date ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-700">
                    {t('bb_rd_next_elig', { d: donorPreview.next_eligible_date })}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 font-mono text-[10px] text-slate-500">
                id {donorPreview.donor_id}
              </div>
              {!donorPreview.blood_group_verified ? (
                <p className="mt-1 text-xs text-amber-800">
                  {t('bb_rd_nobg')}{' '}
                  <code>POST /donors/:id/blood-group/verify</code>
                </p>
              ) : null}
              {donorPreview.needs_activation ? (
                <div className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                  <p className="font-medium">{t('bb_rd_imported')}</p>
                  <p className="mt-0.5">
                    {t('bb_rd_imported_a')}
                    <code>{donorPreview.registration_source}</code>
                    {t('bb_rd_imported_b')}
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

        <Field label={t('bb_fd_coll_date')} htmlFor="cd">
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
        <Field label={t('bb_fd_time')} htmlFor="ct">
          <input
            id="ct"
            type="time"
            className="rk-input"
            value={form.collection_time}
            onChange={(e) => update('collection_time', e.target.value)}
          />
        </Field>

        <Field label={t('bb_th_component')} htmlFor="comp">
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
        <Field label={t('bb_fd_volume')} htmlFor="vol">
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

        <Field label={t('bb_fd_hb')} htmlFor="hb">
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
        <Field label={t('bb_fd_hb_method')} htmlFor="hbm">
          <select
            id="hbm"
            className="rk-input"
            value={form.hb_method}
            onChange={(e) => update('hb_method', e.target.value)}
          >
            {['CS', 'HC', 'LB'].map((code) => (
              <option key={code} value={code}>
                {t('bb_hbm_' + code)}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('bb_fd_pulse')} htmlFor="pulse">
          <input
            id="pulse"
            type="number"
            className="rk-input"
            value={form.pulse_bpm}
            onChange={(e) => update('pulse_bpm', e.target.value)}
          />
        </Field>
        <Field label={t('bb_fd_weight')} htmlFor="wt">
          <input
            id="wt"
            type="number"
            step="0.1"
            className="rk-input"
            value={form.weight_kg}
            onChange={(e) => update('weight_kg', e.target.value)}
          />
        </Field>

        <Field label={t('bb_fd_bp_sys')} htmlFor="sys">
          <input
            id="sys"
            type="number"
            className="rk-input"
            value={form.bp_systolic}
            onChange={(e) => update('bp_systolic', e.target.value)}
          />
        </Field>
        <Field label={t('bb_fd_bp_dia')} htmlFor="dia">
          <input
            id="dia"
            type="number"
            className="rk-input"
            value={form.bp_diastolic}
            onChange={(e) => update('bp_diastolic', e.target.value)}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label={t('bb_fd_isbt')} htmlFor="isbt">
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
          <Field label={t('bb_fd_notes')} htmlFor="notes">
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
          <div className="text-xs text-slate-500">{t('bb_rd_footer')}</div>
          <button type="submit" className="rk-button-primary" disabled={create.isPending}>
            {create.isPending ? '…' : t('bb_rd_title')}
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
  const { t } = useT();
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
      <h1 className="text-lg font-semibold text-slate-900">{t('bb_scr_title')}</h1>

      <div className="rk-card flex gap-2">
        <input
          className="rk-input flex-1 font-mono text-xs"
          placeholder={t('bb_scr_id_ph')}
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
          {t('bb_scr_open')}
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
              <div className="text-xs uppercase tracking-wide text-slate-500">{t('bb_th_component')}</div>
              <div className="font-medium">{donation.component_code || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">ISBT</div>
              <div className="font-mono text-xs">{donation.isbt_barcode || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">{t('bb_scr_bag_status')}</div>
              <div className="font-medium">{donation.bag_status || '—'}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-500">{t('bb_scr_clearance')}</div>
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
                {t('bb_scr_by')}{' '}
                <span className="font-mono text-xs">{donation.entered_by}</span>
              </div>
              {verificationRequired && !verified ? (
                <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                  <p className="font-semibold">{t('bb_scr_4eyes_title')}</p>
                  <p className="text-xs">{t('bb_scr_4eyes_body')}</p>
                  <button
                    type="button"
                    className="rk-button-primary mt-2"
                    onClick={() => verifyScreening.mutate()}
                    disabled={verifyScreening.isPending}
                  >
                    {verifyScreening.isPending ? '…' : t('bb_scr_verify_btn')}
                  </button>
                  {verifyScreening.error ? (
                    <p className="mt-1 text-xs text-rk-700">
                      {verifyScreening.error?.response?.data?.error}
                    </p>
                  ) : null}
                </div>
              ) : verified ? (
                <div className="rounded-md bg-green-50 p-3 text-sm text-green-900 ring-1 ring-green-200">
                  {t('bb_scr_verified_at', { when: donation.verified_at })}
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
  const { t } = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{t('bb_scr_form_note')}</p>
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
          {t('bb_fd_notes')}
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
        {busy ? '…' : t('bb_scr_submit')}
      </button>
      {error ? <p className="text-sm text-rk-700">{error}</p> : null}
      {postedSummary ? (
        <div className="rounded-md bg-slate-50 p-3 text-sm">
          {t('bb_scr_posted')}
          <span className="ml-1 font-mono">{postedSummary.overall_clearance}</span>
          {postedSummary.verification_required ? t('bb_scr_4eyes_chip') : ''}
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
  const { t } = useT();
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
      <h1 className="text-lg font-semibold text-slate-900">{t('bb_os_title')}</h1>
      <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
        {t('bb_os_warn_a')}
        <code>source=&apos;WB&apos;</code>
        {t('bb_os_warn_b')}
        <em>{t('bb_os_warn_em')}</em>
        {t('bb_os_warn_c')}
      </p>

      {result ? (
        <div className="rk-card border-l-4 border-green-500">
          <div className="font-semibold text-green-800">
            {t('bb_os_created', { n: result.bags_created ?? totalUnits })}
          </div>
          {result.skipped_reasons ? (
            <p className="text-sm text-slate-600">
              {t('bb_os_skipped', { d: JSON.stringify(result.skipped_reasons) })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="rk-card space-y-4">
        <div>
          <label className="rk-label" htmlFor="os-date">
            {t('bb_os_date')}
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
                <th className="px-2 py-2 text-left">{t('bb_th_group')}</th>
                <th className="px-2 py-2 text-left">{t('bb_th_component')}</th>
                <th className="px-2 py-2 text-right">{t('bb_th_units')}</th>
                <th className="px-2 py-2 text-right">{t('bb_th_vol_bag')}</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bags.map((b, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">
                    <select
                      aria-label={t('bb_th_group')}
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
                      aria-label={t('bb_th_component')}
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
                      aria-label={t('bb_aria_units')}
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
                      aria-label={t('bb_aria_vol')}
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
                      {t('bb_os_remove')}
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
            {t('bb_os_add')}
          </button>
          <div className="text-sm text-slate-600">
            {t('bb_os_total_a')}
            <strong>{totalUnits}</strong>
            {t('bb_os_total_b', { g: bags.length })}
          </div>
        </div>

        <button
          type="button"
          className="rk-button-primary w-full"
          onClick={trySubmit}
          disabled={submit.isPending || bags.length === 0 || totalUnits === 0}
        >
          {submit.isPending ? '…' : t('bb_os_submit')}
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
  { code: 'NC', key: 'bb_dec_NC' },
  { code: 'ND', key: 'bb_dec_ND' },
  { code: 'DT', key: 'bb_dec_DT' },
  { code: 'VE', key: 'bb_dec_VE' },
  { code: 'OT', key: 'bb_dec_OT' },
];

// Our own answer, which is NOT the camp's status (migration 317 is a separate
// axis — a declined camp is still happening). Status keeps campStatus.js.
const BB_RESPONSE = {
  AC: { key: 'bb_resp_AC', cls: 'bg-green-100 text-green-800' },
  DC: { key: 'bb_resp_DC', cls: 'bg-rk-700/80 text-white' },
  PE: { key: 'bb_resp_PE', cls: 'bg-amber-100 text-amber-800' },
};

// bb_response NULL is its own state and the easiest one to get wrong. It means
// an organiser named us but the NGO has not partnered us yet, so there is
// nothing to answer — POST /camps/:id/bb-response would 409 not_your_camp. It
// must inform, never nag: no buttons, and not counted in the tab badge.
const BB_NAMED_ONLY = {
  key: 'bb_resp_named',
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

/** "2 of 6 camps booked · 1 awaiting review · 4 free", or the unplanned state. */
function OccupancyLine({ day }) {
  const { t } = useT();
  if (!day) return null;
  if (!day.published) {
    return <span className="text-slate-500">{t('bb_occ_unpublished')}</span>;
  }
  if (day.max_camps === 0) {
    return <span className="font-medium text-rk-700">{t('bb_occ_closed')}</span>;
  }
  return (
    <span className={day.ok ? 'text-slate-600' : 'font-medium text-amber-700'}>
      {t('bb_occ_booked', { n: day.confirmed, max: day.max_camps })}
      {day.pending ? ` · ${t('bb_occ_pending', { n: day.pending })}` : ''}
      {day.ok ? ` · ${t('bb_occ_free', { n: day.slots_left })}` : ` · ${t('bb_occ_full')}`}
    </span>
  );
}

function CampsPanel({ onScreenDonation }) {
  const { t } = useT();
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
    { id: 'requests', label: t('bb_camps_view_requests') },
    { id: 'calendar', label: t('bb_camps_view_calendar') },
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
  const { t } = useT();
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
    {
      key: 'PE',
      title: t('bb_camps_g_PE'),
      rows: camps.filter((c) => c.bb_response === 'PE'),
    },
    {
      key: 'AC',
      title: t('bb_camps_g_AC'),
      rows: camps.filter((c) => c.bb_response === 'AC'),
    },
    {
      key: 'NULL',
      title: t('bb_camps_g_NULL'),
      rows: camps.filter((c) => !c.bb_response),
    },
    {
      key: 'DC',
      title: t('bb_camps_g_DC'),
      rows: camps.filter((c) => c.bb_response === 'DC'),
    },
  ].filter((g) => g.rows.length);

  if (campsQ.isLoading) return <p className="text-sm text-slate-500">{t('bb_camps_loading')}</p>;
  if (campsQ.error) {
    return <p className="text-sm text-rk-700">{errorMessage(campsQ.error, 'load your camps')}</p>;
  }

  return (
    <div className="space-y-6">
      {camps.length === 0 ? (
        <div className="rk-card text-sm text-slate-600">
          <p className="font-medium text-slate-900">{t('bb_camps_none_1')}</p>
          <p className="mt-1">
            <strong>{t('bb_camps_none_2a')}</strong>
            {t('bb_camps_none_2b')}
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
  const { t } = useT();
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
            {fmtDate(camp.scheduled_date, t)}
            {camp.start_time ? ` · ${String(camp.start_time).slice(0, 5)}` : ''}
            {camp.end_time ? `–${String(camp.end_time).slice(0, 5)}` : ''}
          </p>
          <p className="text-sm text-slate-500">
            {[camp.venue, camp.taluka_name, camp.district_name].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Pill label={campStatusLabel(camp.status, t)} cls={st.cls} />
          <Pill label={t(bb.key)} cls={bb.cls} />
        </div>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-slate-500">{t('bb_camp_expects')}</dt>
          <dd className="inline font-semibold text-slate-900">{expected || '—'}</dd>
        </div>
        <div>
          <dt className="inline text-slate-500">{t('bb_camp_signed_up')}</dt>
          <dd
            className={
              'inline font-semibold ' +
              (expected && rsvp > expected ? 'text-rk-700' : 'text-slate-900')
            }
          >
            {rsvp}
            {expected && rsvp > expected ? t('bb_camp_above_est') : ''}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-sm">
        <OccupancyLine day={day} />
      </p>

      {hasContact ? (
        <p className="mt-2 text-sm text-slate-600">
          {t('bb_camp_host')}
          <span className="font-medium text-slate-900">{camp.submitted_by_name || '—'}</span>
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
          {t('bb_camp_your_reason')}
          {(() => {
            const r = BB_DECLINE_REASONS.find((x) => x.code === camp.bb_decline_reason);
            return r ? t(r.key) : camp.bb_decline_reason;
          })()}
          {camp.bb_decline_note ? ` — ${camp.bb_decline_note}` : ''}
        </p>
      ) : null}

      {!camp.bb_response ? (
        <p className="mt-2 text-sm text-slate-500">{t('bb_camp_named_only_note')}</p>
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
              {accept.isPending ? t('bb_saving') : t('bb_camp_accept')}
            </button>
            <button
              type="button"
              className="rk-button-secondary"
              onClick={() => setDeclineOpen(true)}
            >
              {t('bb_camp_cant')}
            </button>
          </>
        ) : null}
        <button type="button" className="rk-button-secondary" onClick={() => onOpen(camp.id)}>
          {t('bb_camp_open_brief')}
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
  const { t } = useT();
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
        <h3 className="text-base font-semibold text-slate-900">{t('bb_dec_title')}</h3>
        <p className="mt-1 text-xs text-slate-500">{t('bb_dec_help')}</p>

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
              <span className="font-semibold text-slate-900">{t(opt.key)}</span>
            </label>
          ))}
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase text-slate-500">
          {reason === 'OT' ? t('bb_dec_explain') : t('bb_dec_note')}
        </label>
        <textarea
          rows={2}
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-rk-700 focus:outline-none"
          placeholder={t('bb_dec_placeholder')}
        />

        {err ? (
          <p className="mt-2 text-xs text-rk-700">
            {t('bb_err_prefix')}
            {err}
          </p>
        ) : null}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="rk-button-secondary flex-1">
            {t('bb_cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={m.isPending}
            className="rk-button-primary flex-1"
          >
            {m.isPending ? t('bb_saving') : t('bb_dec_send')}
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

// Month and weekday names come from the camps string pack, never from Intl:
// short-form mr-IN data is unreliable and its forms unpredictable, and a
// calendar cell cannot absorb a surprise six-character weekday.
function monthLabel(ym, t) {
  const [y, m] = String(ym).split('-');
  const names = t ? t('camp_months') : null;
  const name = Array.isArray(names) ? names[Number(m) - 1] : null;
  return name ? `${name} ${y}` : ym;
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
  const { t } = useT();
  const qc = useQueryClient();
  const today = todayISO();
  const [month, setMonth] = useState(monthOf(today));
  const [editDate, setEditDate] = useState('');
  const [banner, setBanner] = useState(null);
  // Multi-day editing. A BB that published a whole month on the wrong default
  // has 30 wrong days, and "Plan this month" will not fix one of them - it is
  // additive by construction and never overwrites. Without this the only route
  // back is 30 modals, which is what "there is no way to clear the calendar
  // days" actually meant.
  const [pick, setPick] = useState(false);
  const [sel, setSel] = useState(() => new Set());

  const toggleDay = (iso) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });

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
          ? t('bb_cap_published', { month: monthLabel(month, t), n: res.created })
          : t('bb_cap_all_planned', { month: monthLabel(month, t) }),
      );
      qc.invalidateQueries({ queryKey: ['bb-capacity'] });
    },
    onError: (e) => setBanner(errorMessage(e, 'plan this month')),
  });

  const settings = settingsQ.data?.settings || null;
  const suggested = settingsQ.data?.suggested_max_camps ?? null;
  const leading = dates.length ? isoDow(from) : 0;
  const dowNames = t('camp_weekdays_short');

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
              aria-label={t('bb_cap_prev_month')}
              className="rk-button-secondary px-2.5 py-1"
              onClick={() => {
                setMonth(shiftMonth(month, -1));
                setBanner(null);
                setSel(new Set());
              }}
            >
              &lsaquo;
            </button>
            <span className="min-w-[9.5rem] text-center text-base font-semibold text-slate-900">
              {monthLabel(month, t)}
            </span>
            <button
              type="button"
              aria-label={t('bb_cap_next_month')}
              className="rk-button-secondary px-2.5 py-1"
              onClick={() => {
                setMonth(shiftMonth(month, 1));
                setBanner(null);
                setSel(new Set());
              }}
            >
              &rsaquo;
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={pick ? 'rk-button-primary' : 'rk-button-secondary'}
              onClick={() => {
                setBanner(null);
                setSel(new Set());
                setPick(!pick);
              }}
            >
              {pick ? t('bb_cap_pick_done') : t('bb_cap_pick_start')}
            </button>
            <button
              type="button"
              className="rk-button-primary"
              disabled={publish.isPending || pick}
              onClick={() => {
                setBanner(null);
                publish.mutate();
              }}
            >
              {publish.isPending ? t('bb_cap_planning') : t('bb_cap_plan_month')}
            </button>
          </div>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          {pick ? t('bb_cap_help_pick') : t('bb_cap_help_plain')}
        </p>

        {banner ? <p className="mt-2 text-sm text-slate-700">{banner}</p> : null}

        <div className="mt-4 grid grid-cols-7 gap-1 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
          {dowNames.map((d, dow) =>
            pick ? (
              <button
                key={d}
                type="button"
                className="rounded py-0.5 uppercase hover:bg-slate-100 hover:text-rk-700"
                title={t('bb_cap_dow_title', { d })}
                onClick={() =>
                  setSel((prev) => {
                    const next = new Set(prev);
                    for (const iso of dates) {
                      if (iso >= today && isoDow(iso) === dow) next.add(iso);
                    }
                    return next;
                  })
                }
              >
                {d}
              </button>
            ) : (
              <span key={d}>{d}</span>
            ),
          )}
        </div>

        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: leading }).map((_, i) => (
            <span key={`lead${i}`} />
          ))}
          {dates.map((iso) => {
            const day = byDate.get(iso);
            const past = iso < today;
            const chosen = sel.has(iso);
            // A past day is never worth bulk-editing, and letting it into a
            // selection is how you accidentally rewrite history. Still tappable
            // on its own, exactly as before.
            const lockedForPick = pick && past;
            return (
              <button
                key={iso}
                type="button"
                disabled={lockedForPick}
                aria-pressed={pick ? chosen : undefined}
                onClick={() => (pick ? toggleDay(iso) : setEditDate(iso))}
                className={
                  dayCellClass(day, iso === today) +
                  (past ? ' opacity-60' : '') +
                  (chosen ? ' ring-2 ring-rk-700 ring-offset-1' : '') +
                  (lockedForPick ? ' cursor-not-allowed' : '')
                }
              >
                {chosen ? (
                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-rk-700 text-[10px] font-bold leading-none text-white">
                    &#10003;
                  </span>
                ) : null}
                <span className="text-sm font-semibold text-slate-900">
                  {Number(iso.slice(8, 10))}
                </span>
                <span className="text-[11px] leading-tight text-slate-600">
                  {!day || !day.published
                    ? t('bb_cap_cell_unplanned')
                    : day.max_camps === 0
                      ? t('bb_cap_cell_closed')
                      : t('bb_cap_cell_booked', { n: day.confirmed, max: day.max_camps })}
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
            {t('bb_cap_leg_confirmed')}
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle ring-1 ring-inset ring-rk-700" />
            {t('bb_cap_leg_pending')}
          </span>
          <span>{t('bb_cap_leg_colours')}</span>
        </div>
      </div>

      {pick ? (
        <CapacityBulkBar
          dates={dates}
          byDate={byDate}
          selected={sel}
          suggested={suggested}
          today={today}
          onSelect={setSel}
          onDone={(msg) => {
            setBanner(msg);
            setSel(new Set());
            qc.invalidateQueries({ queryKey: ['bb-capacity'] });
            qc.invalidateQueries({ queryKey: ['bb-camps'] });
          }}
        />
      ) : null}

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
  const { t } = useT();
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

  if (loading) return <div className="rk-card text-sm text-slate-500">{t('bb_loading')}</div>;

  if (!open) {
    const dowNames = t('camp_weekdays_short');
    const closed = (settings?.weekly_closed_days || [])
      .map((n) => dowNames[n])
      .filter(Boolean)
      .join(', ');
    return (
      <div className="rk-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="text-sm text-slate-700">
            {settings ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  <strong className="text-slate-900">{settings.staff_total ?? '--'}</strong>{' '}
                  {t('bb_set_staff')}
                </span>
                <span className="text-slate-400">|</span>
                <span>
                  <strong className="text-slate-900">{settings.staff_per_camp ?? '--'}</strong>{' '}
                  {t('bb_set_per_camp')}
                </span>
                <span className="text-slate-400">|</span>
                <span>
                  {t('bb_set_suggests_a')}
                  <strong className="text-slate-900">{suggested ?? '--'}</strong>
                  {t('bb_set_suggests_b')}
                </span>
                <span className="text-slate-400">|</span>
                <span>
                  {t('bb_set_usually_a')}
                  <strong className="text-slate-900">{settings.default_max_camps}</strong>
                  {t('bb_set_usually_b')}
                </span>
                {closed ? (
                  <>
                    <span className="text-slate-400">|</span>
                    <span>{t('bb_set_closed', { days: closed })}</span>
                  </>
                ) : null}
                {settings.auto_accept_within_capacity ? (
                  <>
                    <span className="text-slate-400">|</span>
                    <span className="text-green-700">{t('bb_set_auto')}</span>
                  </>
                ) : null}
              </p>
            ) : (
              <>
                <p className="font-medium text-slate-900">{t('bb_set_prompt_1')}</p>
                <p className="mt-1">{t('bb_set_prompt_2')}</p>
              </>
            )}
          </div>
          <button type="button" className="rk-button-secondary shrink-0" onClick={startEdit}>
            {settings ? t('bb_set_edit') : t('bb_set_start')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rk-card">
      <h2 className="text-sm font-semibold text-slate-900">{t('bb_set_title')}</h2>
      <p className="mt-1 text-xs text-slate-500">{t('bb_set_help')}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="rk-label" htmlFor="cap-staff-total">
            {t('bb_set_f_total')}
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
            {t('bb_set_f_per')}
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
            {t('bb_set_f_default')}
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
          ? t('bb_set_calc', {
              n: Math.floor(Number(form.staff_total) / Number(form.staff_per_camp)),
            })
          : t('bb_set_calc_empty')}
      </p>

      <fieldset className="mt-4">
        <legend className="rk-label">{t('bb_set_dow_legend')}</legend>
        <div className="flex flex-wrap gap-2">
          {t('camp_weekdays_short').map((lbl, n) => (
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
        <p className="mt-1 text-xs text-slate-500">{t('bb_set_dow_help')}</p>
      </fieldset>

      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.auto_accept_within_capacity}
          onChange={(e) => setForm({ ...form, auto_accept_within_capacity: e.target.checked })}
        />
        <span>
          <span className="font-medium text-slate-900">{t('bb_set_auto_title')}</span>
          <br />
          <span className="text-xs text-slate-500">{t('bb_set_auto_help')}</span>
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
          {save.isPending ? t('bb_saving') : t('bb_set_save')}
        </button>
        <button type="button" className="rk-button-secondary" onClick={() => setOpen(false)}>
          {t('bb_cancel')}
        </button>
      </div>
    </div>
  );
}

// ── Several days at once ───────────────────────────────────────────────────
//
// The per-day editor above can already do everything to one day. This exists
// because the mistake this feature has to survive is made a MONTH at a time:
// "Plan this month" is deliberately additive - it never overwrites an existing
// row, so a BB that published September on the wrong default cannot fix a
// single day of it by pressing that button again. One modal per day, thirty
// times, is not a repair path.
//
// The three actions map exactly onto the three day-states, and the third is the
// one that was missing: max_camps null DELETEs the row, taking the day back to
// unplanned. That is the only undo for an accidental publish.
//
// ⚠ The upsert overwrites EVERY column it is sent (note and staff_committed
// included), so a bulk change to the number of camps has to carry each day's
// existing note and staff along with it. Sending a bare {date, max_camps}
// would quietly erase every "Diwali, 2 techs on leave" in the selection.
function CapacityBulkBar({ dates, byDate, selected, suggested, today, onSelect, onDone }) {
  const { t } = useT();
  const [camps, setCamps] = useState('');
  const [staff, setStaff] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [err, setErr] = useState(null);

  const chosen = useMemo(() => dates.filter((d) => selected.has(d)), [dates, selected]);
  const plannedCount = chosen.filter((d) => byDate.get(d)?.published).length;
  const bookedCount = chosen.filter((d) => (byDate.get(d)?.confirmed || 0) > 0).length;

  const write = useMutation({
    mutationFn: (days) => apiRequest('PUT', '/camps/bb/capacity', { days }),
    onSuccess: (res) => {
      const bits = [];
      if (res.written) {
        bits.push(t(res.written === 1 ? 'bb_bulk_upd_1' : 'bb_bulk_upd_n', { n: res.written }));
      }
      if (res.removed) {
        bits.push(t(res.removed === 1 ? 'bb_bulk_rem_1' : 'bb_bulk_rem_n', { n: res.removed }));
      }
      onDone(bits.length ? `${bits.join(t('bb_bulk_join'))}.` : t('bb_bulk_nothing'));
    },
    onError: (e) => setErr(errorMessage(e, 'change these days')),
  });

  const pickWhere = (fn) => onSelect(new Set(dates.filter((d) => d >= today && fn(byDate.get(d)))));

  const apply = (value) => {
    setErr(null);
    setConfirmWithdraw(false);
    if (!chosen.length) {
      setErr(t('bb_bulk_err_none'));
      return;
    }
    const staffText = String(staff).trim();
    const staffNum = staffText === '' ? null : Number(staffText);
    if (staffText !== '' && !(Number.isInteger(staffNum) && staffNum >= 0 && staffNum <= 500)) {
      setErr(t('bb_bulk_err_staff'));
      return;
    }
    write.mutate(
      chosen.map((date) => {
        const d = byDate.get(date);
        return {
          date,
          max_camps: value,
          staff_committed: staffText === '' ? (d?.staff_committed ?? null) : staffNum,
          note: d?.note ?? null,
        };
      }),
    );
  };

  const applyNumber = () => {
    const text = String(camps).trim();
    const n = Number(text);
    if (text === '' || !Number.isInteger(n) || n < 0 || n > 20) {
      setErr(t('bb_bulk_err_camps'));
      return;
    }
    apply(n);
  };

  const withdraw = () => {
    setErr(null);
    if (!chosen.length) {
      setErr(t('bb_bulk_err_none'));
      return;
    }
    if (!confirmWithdraw) {
      setConfirmWithdraw(true);
      return;
    }
    setConfirmWithdraw(false);
    write.mutate(chosen.map((date) => ({ date, max_camps: null })));
  };

  const quick = 'rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50';

  return (
    <div className="sticky bottom-4 z-30 rounded-lg border border-rk-200 bg-white p-4 shadow-lift">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold text-slate-900">
          {chosen.length
            ? t(chosen.length === 1 ? 'bb_bulk_chosen_1' : 'bb_bulk_chosen_n', {
                n: chosen.length,
              })
            : t('bb_bulk_chosen_none')}
        </p>
        {chosen.length ? (
          <p className="text-xs text-slate-500">
            {t('bb_bulk_breakdown', {
              planned: plannedCount,
              unplanned: chosen.length - plannedCount,
            })}
            {bookedCount ? t('bb_bulk_booked', { n: bookedCount }) : ''}
          </p>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <button type="button" className={quick} onClick={() => pickWhere((d) => !!d?.published)}>
          {t('bb_bulk_q_planned')}
        </button>
        <button type="button" className={quick} onClick={() => pickWhere((d) => !d?.published)}>
          {t('bb_bulk_q_unplanned')}
        </button>
        <button type="button" className={quick} onClick={() => pickWhere(() => true)}>
          {t('bb_bulk_q_rest')}
        </button>
        <button type="button" className={quick} onClick={() => onSelect(new Set())}>
          {t('bb_bulk_q_clear')}
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="rk-label" htmlFor="bulk-camps">
            {t('bb_bulk_f_camps')}
          </label>
          <input
            id="bulk-camps"
            type="number"
            min={0}
            max={20}
            className="rk-input"
            value={camps}
            onChange={(e) => setCamps(e.target.value)}
            placeholder={suggested ? String(suggested) : '1'}
          />
        </div>
        <div>
          <label className="rk-label" htmlFor="bulk-staff">
            {t('bb_bulk_f_staff')}
          </label>
          <input
            id="bulk-staff"
            type="number"
            min={0}
            max={500}
            className="rk-input"
            value={staff}
            onChange={(e) => setStaff(e.target.value)}
            placeholder={t('bb_bulk_staff_ph')}
          />
        </div>
      </div>

      <p className="mt-1 text-xs text-slate-500">{t('bb_bulk_help')}</p>

      {err ? <p className="mt-2 text-sm text-rk-700">{err}</p> : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className="rk-button-primary"
          disabled={write.isPending || !chosen.length}
          onClick={applyNumber}
        >
          {write.isPending ? t('bb_saving') : t('bb_bulk_set')}
        </button>
        <button
          type="button"
          className="rk-button-secondary"
          disabled={write.isPending || !chosen.length}
          onClick={() => apply(0)}
        >
          {t('bb_bulk_close')}
        </button>
        <button
          type="button"
          className={
            confirmWithdraw
              ? 'rk-button-primary'
              : 'rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50'
          }
          disabled={write.isPending || !chosen.length}
          onClick={withdraw}
        >
          {confirmWithdraw ? t('bb_bulk_withdraw_confirm') : t('bb_bulk_withdraw')}
        </button>
      </div>

      <p className="mt-2 text-xs text-slate-500">{t('bb_bulk_note')}</p>
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
  const { t } = useT();
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
      setErr(t('bb_day_err_range'));
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
        <h3 className="text-base font-semibold text-slate-900">{fmtDate(date, t)}</h3>
        <p className="mt-1 text-xs text-slate-500">
          {published
            ? t(day.max_camps === 1 ? 'bb_day_planned_1' : 'bb_day_planned_n', {
                n: day.max_camps,
              })
            : t('bb_day_unplanned')}
        </p>

        <p className="mt-2 text-sm text-slate-700">
          <OccupancyLine day={day} />
        </p>

        <label className="mt-4 block rk-label" htmlFor="cap-day-max">
          {t('bb_day_f_max')}
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
            {t('bb_day_closed_btn')}
          </button>
          {suggested ? (
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setMaxCamps(String(suggested))}
            >
              {t('bb_day_usual', { n: suggested })}
            </button>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">{t('bb_day_zero_help')}</p>

        {belowBooked ? (
          <p className="mt-2 text-sm text-amber-700">
            {t(confirmed === 1 ? 'bb_day_below_1' : 'bb_day_below_n', { c: confirmed, n })}
          </p>
        ) : null}

        <label className="mt-4 block rk-label" htmlFor="cap-day-staff">
          {t('bb_day_f_staff')}
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
          {t('bb_day_f_note')}
        </label>
        <input
          id="cap-day-note"
          type="text"
          maxLength={500}
          className="rk-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('bb_day_note_ph')}
        />
        <p className="mt-1 text-xs text-slate-500">{t('bb_day_note_help')}</p>

        {err ? <p className="mt-3 text-sm text-rk-700">{err}</p> : null}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="rk-button-secondary flex-1">
            {t('bb_cancel')}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={write.isPending}
            className="rk-button-primary flex-1"
          >
            {write.isPending ? t('bb_saving') : t('bb_day_save')}
          </button>
        </div>

        {published ? (
          <button
            type="button"
            onClick={withdraw}
            disabled={write.isPending}
            className="mt-3 w-full text-center text-xs font-medium text-slate-500 underline hover:text-rk-700"
          >
            {t('bb_day_remove')}
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
  const { t } = useT();
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
          {t('bb_brief_back')}
        </button>
        <p>{t('bb_loading')}</p>
      </div>
    );
  }

  if (campQ.isError || !camp) {
    return (
      <div className="rk-card">
        <button type="button" className="mb-3 text-sm text-rk-700 underline" onClick={onBack}>
          {t('bb_brief_back')}
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
        {t('bb_brief_back')}
      </button>

      <div className="rk-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900">{camp.name}</h3>
            <p className="mt-0.5 text-sm text-slate-600">
              {fmtDate(camp.scheduled_date, t)}
              {camp.start_time ? ` · ${String(camp.start_time).slice(0, 5)}` : ''}
              {camp.end_time ? `–${String(camp.end_time).slice(0, 5)}` : ''}
            </p>
            <p className="mt-0.5 text-sm text-slate-600">
              {camp.venue}
              {camp.address_line ? `, ${camp.address_line}` : ''}
              {camp.district_name ? ` · ${camp.district_name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill label={campStatusLabel(camp.status, t)} cls={st.cls} />
            <Pill label={t(resp.key)} cls={resp.cls} />
          </div>
        </div>

        {hostName || hostMobile ? (
          <div className="mt-3 border-t border-slate-200 pt-3 text-sm">
            <p className="text-slate-700">
              <span className="font-medium">{t('bb_brief_organiser')}</span>{' '}
              {hostName || t('bb_brief_no_name')}
            </p>
            {hostMobile ? (
              <a className="text-rk-700 underline" href={`tel:${hostMobile}`}>
                {hostMobile}
              </a>
            ) : null}
            <p className="mt-1 text-xs text-slate-500">
              {t('bb_brief_why_visible')}
            </p>
          </div>
        ) : null}
      </div>

      <div className="rk-card">
        <h4 className="text-sm font-semibold text-slate-900">{t('bb_brief_coming_title')}</h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-sand/60 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {t('bb_brief_organiser_said')}
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-900">{expected || '--'}</p>
          </div>
          <div
            className={
              'rounded-lg p-3 ' + (overEstimate ? 'bg-rk-50 ring-1 ring-rk-700' : 'bg-sand/60')
            }
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">
              {t('bb_brief_signed_up')}
            </p>
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
            {t('bb_brief_over', { n: signedUp - expected, signed: signedUp, expected })}
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-500">
            {t('bb_brief_keep_checking')}
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
          <h4 className="text-sm font-semibold text-slate-900">{t('bb_brief_groups_title')}</h4>
          {signedUp === 0 ? (
            <p className="mt-2 text-sm text-slate-500">{t('bb_brief_none_yet')}</p>
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
                  {t(groups.unknown === 1 ? 'bb_brief_unknown_1' : 'bb_brief_unknown_n', {
                    n: groups.unknown,
                  })}
                </p>
              ) : (
                <p className="mt-2 text-xs text-slate-500">
                  {t('bb_brief_all_verified')}
                </p>
              )}
            </>
          )}
        </div>

        <div className="rk-card">
          <h4 className="text-sm font-semibold text-slate-900">{t('bb_brief_kit_title')}</h4>
          {!kit ? (
            <p className="mt-2 text-sm text-slate-500">
              {t('bb_brief_kit_none')}
            </p>
          ) : (
            <>
              <ul className="mt-3 space-y-1 text-sm text-slate-700">
                <li>
                  <span className="font-semibold tabular-nums">{kit.bags}</span>{' '}
                  {t('bb_brief_kit_bags')}
                  <span className="text-slate-500">{t('bb_brief_kit_bags_note')}</span>
                </li>
                <li>
                  <span className="font-semibold tabular-nums">{kit.tubes}</span>{' '}
                  {t('bb_brief_kit_tubes')}
                  <span className="text-slate-500">{t('bb_brief_kit_tubes_note')}</span>
                </li>
                {kit.staff ? (
                  <li>
                    <span className="font-semibold tabular-nums">{kit.staff}</span>{' '}
                    {t('bb_brief_kit_staff')}
                    <span className="text-slate-500">{t('bb_brief_kit_staff_note')}</span>
                  </li>
                ) : null}
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                {t('bb_brief_kit_note')}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="rk-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold text-slate-900">{t('bb_brief_res_title')}</h4>
          <p className="text-xs text-slate-500">
            {t(donations.length === 1 ? 'bb_brief_res_1' : 'bb_brief_res_n', {
              n: donations.length,
            })}
            {awaitingScreening ? t('bb_brief_res_await_scr', { n: awaitingScreening }) : ''}
            {awaitingVerification ? t('bb_brief_res_await_ver', { n: awaitingVerification }) : ''}
          </p>
        </div>

        {donQ.isLoading ? (
          <p className="mt-2 text-sm text-slate-500">{t('bb_loading')}</p>
        ) : donQ.isError ? (
          <p className="mt-2 text-sm text-rk-700">
            {errorMessage(donQ.error, 'read the donations from this camp')}
          </p>
        ) : donations.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            {t('bb_brief_res_none')}
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">
              {t('bb_brief_res_help')}
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">{t('bb_brief_th_donor')}</th>
                    <th className="py-2 pr-3">{t('bb_brief_th_mobile')}</th>
                    <th className="py-2 pr-3">{t('bb_brief_th_group')}</th>
                    <th className="py-2 pr-3">{t('bb_brief_th_bag')}</th>
                    <th className="py-2 pr-3">{t('bb_brief_th_scr')}</th>
                  </tr>
                </thead>
                <tbody>
                  {donations.map((d) => {
                    const pill = screeningPill(d, t);
                    return (
                      <tr
                        key={d.donation_id}
                        className="cursor-pointer border-b border-slate-100 hover:bg-sand/50"
                        onClick={() => onScreenDonation(d.donation_id)}
                      >
                        <td className="py-2 pr-3 font-medium text-slate-900">
                          {d.full_name || t('bb_brief_no_record_name')}
                          {d.is_invalidated ? (
                            <span className="ml-2 text-xs font-semibold text-rk-700">
                              {t('bb_brief_discarded')}
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
function screeningPill(d, t) {
  if (!d.screening_id) {
    return { label: t('bb_scr_not_entered'), cls: 'bg-slate-100 text-slate-700' };
  }
  if (d.overall_clearance === 'CL') {
    return { label: t('bb_scr_cleared'), cls: 'bg-green-100 text-green-800' };
  }
  if (d.overall_clearance === 'IN') {
    return { label: t('bb_scr_not_usable'), cls: 'bg-rk-700/80 text-white' };
  }
  if (!d.verified_at) {
    return { label: t('bb_scr_await_ver'), cls: 'bg-amber-100 text-amber-800' };
  }
  return { label: t('bb_scr_entered'), cls: 'bg-slate-100 text-slate-700' };
}
