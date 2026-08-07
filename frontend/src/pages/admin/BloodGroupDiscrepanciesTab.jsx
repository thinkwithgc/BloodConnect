import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';
import { useAuth } from '../../auth/AuthContext.jsx';

// Blood-group HITL discrepancy resolution — PR (b) admin surface.
// See migration 309 for the state-machine spec and
// backend/src/routes/admin.js for the API contract:
//   GET  /admin/donors/blood-group-discrepancies
//   POST /admin/donors/:id/resolve-blood-group-discrepancy
//
// Reads open to ngo_admin + super_admin. Resolution WRITE is gated
// server-side: rare-blood donors require super_admin — we mirror that
// gate client-side so the UI is honest about who can click submit.

function fmtDateTime(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(v);
  }
}

function maskMobile(m) {
  if (!m) return '—';
  const s = String(m).replace(/\s+/g, '');
  if (s.length < 5) return '••••';
  return `${s.slice(0, -8)}••••${s.slice(-4)}`;
}

function ResolveModal({ row, onClose }) {
  const qc = useQueryClient();
  const { role } = useAuth();
  const isSuperAdmin = role === 'super_admin';
  const [chosenId, setChosenId] = useState(null);
  const [notes, setNotes] = useState('');

  const canSubmit =
    chosenId !== null &&
    notes.trim().length >= 20 &&
    (!row.is_rare_blood || isSuperAdmin);

  const resolve = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/admin/donors/${row.id}/resolve-blood-group-discrepancy`, {
        chosen_value_id: chosenId,
        notes: notes.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'blood-group-discrepancies'] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-12 w-full max-w-2xl space-y-4 rounded-xl bg-white p-6 shadow-lift">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">
            Resolve blood-group discrepancy
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Donor: <strong>{row.full_name || '—'}</strong> · {maskMobile(row.mobile)} · DOB{' '}
            {row.date_of_birth ? String(row.date_of_birth).slice(0, 10) : '—'}
          </p>
        </div>

        {row.is_rare_blood ? (
          <div className="rounded-md border border-rk-700/40 bg-rk-700/5 p-3 text-sm text-rk-700">
            <strong>Rare-blood donor.</strong> Resolution requires super_admin sign-off — a
            mismatch on a rare group has much higher clinical impact than a routine A+/B+
            mix-up.
            {!isSuperAdmin ? (
              <div className="mt-1 text-xs">
                You're signed in as <code>{role}</code>. Ask a super_admin to resolve.
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Which value is authoritative?
          </div>
          <label className="flex items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
            <input
              type="radio"
              className="mt-0.5"
              name="chosen"
              checked={chosenId === row.existing_value_id}
              onChange={() => setChosenId(row.existing_value_id)}
            />
            <div className="flex-1">
              <div className="font-mono text-lg font-bold text-slate-900">
                {row.existing_value}
              </div>
              <div className="text-xs text-slate-500">
                Attested by <strong>{row.existing_source_display_name || '—'}</strong>
                {row.existing_source_shortname ? (
                  <span className="ml-1 font-mono text-[10px] text-slate-400">
                    @{row.existing_source_shortname}
                  </span>
                ) : null}
                <span className="mx-1">·</span>
                {fmtDateTime(row.existing_at)}
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
            <input
              type="radio"
              className="mt-0.5"
              name="chosen"
              checked={chosenId === row.disputed_value_id}
              onChange={() => setChosenId(row.disputed_value_id)}
            />
            <div className="flex-1">
              <div className="font-mono text-lg font-bold text-slate-900">
                {row.disputed_value}
              </div>
              <div className="text-xs text-slate-500">
                Disputed by <strong>{row.disputed_source_display_name || '—'}</strong>
                {row.disputed_source_shortname ? (
                  <span className="ml-1 font-mono text-[10px] text-slate-400">
                    @{row.disputed_source_shortname}
                  </span>
                ) : null}
                <span className="mx-1">·</span>
                raised {fmtDateTime(row.discrepancy_raised_at)}
              </div>
            </div>
          </label>
        </div>

        <div>
          <label className="block">
            <span className="rk-label">
              Resolution notes <span className="text-slate-400">(min 20 chars)</span>
            </span>
            <textarea
              className="rk-input"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Confirmed with lab technician at PDMMC via phone. Original report was mis-transcribed at Sangamtirth; PDMMC's typing sheet is the authoritative source."
            />
            <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
              <span>Written to audit_log · read-only once submitted.</span>
              <span className={notes.trim().length < 20 ? 'text-rk-700' : ''}>
                {notes.trim().length} / 20
              </span>
            </div>
          </label>
        </div>

        {resolve.error ? (
          <p className="text-xs text-rk-700">
            {resolve.error?.response?.data?.error || 'resolve_failed'}
          </p>
        ) : null}

        <div className="flex items-center justify-between">
          <div className="text-xs text-slate-500">
            Locking is <strong>permanent</strong> — the DB refuses future writes to this
            donor's blood group.
          </div>
          <div className="flex gap-2">
            <button type="button" className="rk-button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="rk-button-primary"
              disabled={!canSubmit || resolve.isPending}
              onClick={() => resolve.mutate()}
            >
              {resolve.isPending ? '…' : 'Resolve & lock'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BloodGroupDiscrepanciesTab() {
  const [openRow, setOpenRow] = useState(null);
  const q = useQuery({
    queryKey: ['admin', 'blood-group-discrepancies'],
    queryFn: () => apiRequest('GET', '/admin/donors/blood-group-discrepancies'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const rows = q.data?.discrepancies || [];

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-slate-600">
          Donors with a pending blood-group discrepancy (a second blood bank attested a
          different verified value via the vendor push API). Choose which value is
          authoritative — the donor's group locks permanently after resolution.
        </p>
        <div className="text-xs text-slate-500">
          {q.isFetching ? '…' : `${rows.length} pending`}
        </div>
      </div>

      {q.error ? (
        <div className="rk-card text-rk-700">
          {q.error?.response?.data?.error || 'load_failed'}
        </div>
      ) : null}

      <div className="rk-card overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Donor</th>
              <th className="px-3 py-2 text-left">Existing value</th>
              <th className="px-3 py-2 text-left">Disputed value</th>
              <th className="px-3 py-2 text-left">Raised</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2 font-medium text-slate-900">
                    {r.full_name || '—'}
                    {r.is_rare_blood ? (
                      <span className="rounded-full bg-rk-700/10 px-1.5 py-0.5 text-[10px] font-semibold text-rk-700">
                        RARE
                      </span>
                    ) : null}
                  </div>
                  <div className="font-mono text-[11px] text-slate-500">{maskMobile(r.mobile)}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-base font-semibold text-slate-900">
                    {r.existing_value || '—'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {r.existing_source_display_name || '—'}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono text-base font-semibold text-rk-700">
                    {r.disputed_value || '—'}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {r.disputed_source_display_name || '—'}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs text-slate-700">
                  {fmtDateTime(r.discrepancy_raised_at)}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    className="rk-button-primary text-xs"
                    onClick={() => setOpenRow(r)}
                  >
                    Resolve
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && !q.isLoading ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">
                  No pending discrepancies.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {openRow ? <ResolveModal row={openRow} onClose={() => setOpenRow(null)} /> : null}

      <p className="text-xs text-slate-500">
        Matching engine skips donors in this queue (state=DP) until resolved. Resolution
        locks the value — no future vendor push or manual edit can overwrite it. The
        immutability lock is enforced by a database trigger; even a super_admin cannot
        bypass without a schema migration.
      </p>
    </section>
  );
}
