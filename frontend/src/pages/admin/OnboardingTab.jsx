import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

// Mirrors institutions.onboarding_status. The eSign webhook flips VE → AC
// automatically when MoU comes back signed; this UI exposes the manual
// admin levers (verify license, kick off eSign).
const FILTERS = [
  { id: 'PE', label: 'Pending license review' },
  { id: 'VE', label: 'License verified · awaiting MoU' },
  { id: 'AC', label: 'Active' },
  { id: 'SU', label: 'Suspended' },
];

const KIND_LABEL = { HO: 'Hospital', BB: 'Blood bank' };

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(v);
  }
}

// Mobile is encrypted at rest but plaintext in transit on the admin response.
// Mask all but last 4 digits for the UI, the same way hospital-facing
// donor mobiles are masked elsewhere.
function maskMobile(m) {
  if (!m) return '—';
  const s = String(m).replace(/\s+/g, '');
  if (s.length < 5) return '••••';
  return `${s.slice(0, -10)}••••••${s.slice(-4)}`;
}

export function OnboardingTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('PE');
  const [busyId, setBusyId] = useState(null);

  const listQ = useQuery({
    queryKey: ['admin', 'onboarding', status],
    queryFn: () => apiRequest('GET', `/onboarding/applications?status=${status}`),
    staleTime: 15_000,
  });

  const verify = useMutation({
    mutationFn: (id) => apiRequest('POST', `/onboarding/verify/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] });
      // Row flips PE → VE; move the filter with it so the admin can immediately
      // Send-MoU rather than staring at an emptied PE list.
      setStatus('VE');
    },
  });

  const generateMou = useMutation({
    mutationFn: (id) => apiRequest('POST', `/onboarding/generate-mou/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'onboarding'] }),
    // Deliberately stay on the VE filter after Send-MoU — the row only leaves
    // VE when the eSign webhook flips it to AC, and the detail page (or a
    // React Query refetch on window focus) picks that up asynchronously.
  });

  const rows = listQ.data?.applications || [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatus(f.id)}
            className={
              'rounded-full border px-3 py-1 text-sm font-medium ' +
              (status === f.id
                ? 'border-rk-700 bg-rk-50 text-rk-900'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50')
            }
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-sm text-slate-500">
          {listQ.isFetching ? '…' : `${rows.length} shown`}
        </span>
      </div>

      {listQ.error ? (
        <div className="rk-card text-rk-700">
          {listQ.error?.response?.data?.error || 'load_failed'}
        </div>
      ) : null}

      {generateMou.data ? (
        <div className="rk-card border border-amber-300 bg-amber-50 text-sm">
          <p className="font-semibold text-amber-900">
            {generateMou.data.cached
              ? 'Existing eSign request returned (no new document created)'
              : 'eSign request created'}
          </p>
          <p className="mt-1 text-amber-900">
            Provider: <span className="font-mono">{generateMou.data.provider}</span> · Doc ID:{' '}
            <span className="font-mono">{generateMou.data.doc_id}</span>
          </p>
          {generateMou.data.sign_url ? (
            <a
              href={generateMou.data.sign_url}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-amber-800 underline"
            >
              Open sign URL →
            </a>
          ) : null}
          <p className="mt-2 text-xs text-amber-800">
            The signatory will receive this URL on WhatsApp from Leegality. The URL persists on
            the detail page — a refresh won't lose it.
          </p>
        </div>
      ) : null}

      <div className="rk-card overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Applicant</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-left">Contact</th>
              <th className="px-3 py-2 text-left">Applied</th>
              <th className="px-3 py-2 text-left">License verified</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const isBusy = busyId === r.id && (verify.isPending || generateMou.isPending);
              return (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <Link
                      to={`/admin/onboarding/${r.id}`}
                      className="font-medium text-slate-900 hover:text-rk-700 hover:underline"
                    >
                      {r.legal_name}
                    </Link>
                    <div className="font-mono text-[10px] text-slate-400">@{r.shortname}</div>
                  </td>
                  <td className="px-3 py-2">
                    {KIND_LABEL[r.kind] || r.kind}
                    {r.has_inhouse_blood_bank ? (
                      <span
                        className="ml-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                        title="Hospital with in-house blood bank — paired application"
                      >
                        +BB
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <div className="text-slate-800">{r.primary_contact_name}</div>
                    <div className="font-mono text-xs text-slate-500">
                      {maskMobile(r.primary_contact_mobile)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {fmtDate(r.onboarding_started_at)}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{fmtDate(r.license_verified_at)}</td>
                  <td className="px-3 py-2 text-right">
                    {status === 'PE' ? (
                      <button
                        type="button"
                        className="rk-button-primary text-xs"
                        onClick={() => {
                          setBusyId(r.id);
                          verify.mutate(r.id);
                        }}
                        disabled={isBusy}
                      >
                        {isBusy ? '…' : 'Verify license'}
                      </button>
                    ) : null}
                    {status === 'VE' ? (
                      <button
                        type="button"
                        className="rk-button-primary text-xs"
                        onClick={() => {
                          setBusyId(r.id);
                          generateMou.mutate(r.id);
                        }}
                        disabled={isBusy}
                      >
                        {isBusy ? '…' : 'Send MoU for eSign'}
                      </button>
                    ) : null}
                    {status === 'AC' ? (
                      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                        Active
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !listQ.isLoading ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-sm text-slate-500">
                  No applications in this status.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        PE → VE: click applicant name for full submission detail, then Verify to confirm both
        licences (hospital registration + CDSCO if in-house BB). VE → AC: Send MoU triggers an
        Aadhaar eSign request via Leegality; refresh-safe (URL persists on the detail page).
        The eSign webhook then auto-provisions admin logins and flips status to AC — for paired
        applications, the blood-bank admin's credentials surface on the hospital dashboard.
      </p>
    </section>
  );
}
