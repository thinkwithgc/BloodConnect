import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

// Mirrors institutions.onboarding_status. Both transitions are manual admin
// actions: verify the licences here, then record the paper-signed MoU and
// activate from the detail page (that step needs a form, not a row button).
const FILTERS = [
  { id: 'PE', label: 'Pending license review' },
  { id: 'VE', label: 'Licence verified · awaiting paper MoU' },
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
      // Row flips PE → VE; move the filter with it so the admin can go straight
      // on to activation rather than staring at an emptied PE list.
      setStatus('VE');
    },
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
              const isBusy = busyId === r.id && verify.isPending;
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
                      <Link
                        to={`/admin/onboarding/${r.id}`}
                        className="rk-button-primary inline-block text-xs"
                      >
                        Approve &amp; activate
                      </Link>
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
        PE → VE: click the applicant name for the full submission, then Verify to confirm both
        licences (hospital registration + CDSCO if in-house BB). VE → AC: the MoU is signed
        offline on paper — once you hold the signed copy, open the applicant and use Approve
        &amp; activate to record it (date, signatory, optional scan). That provisions the admin
        logins and WhatsApps a password-setup link; for paired applications the blood-bank
        admin's setup link surfaces on the hospital dashboard.
      </p>
    </section>
  );
}
