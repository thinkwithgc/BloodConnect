import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

const STATUS = {
  PE: { label: 'Pending review', cls: 'bg-amber-100 text-amber-800' },
  PL: { label: 'Planned', cls: 'bg-sky-100 text-sky-800' },
  LV: { label: 'Live', cls: 'bg-green-100 text-green-800' },
  CO: { label: 'Completed', cls: 'bg-slate-200 text-slate-800' },
  CA: { label: 'Cancelled', cls: 'bg-rk-700 text-white' },
  DC: { label: 'Declined', cls: 'bg-rk-700/80 text-white' },
};

const ORGANISER = {
  CC: 'Corporate',
  CO: 'Community',
  EI: 'Educational',
  EO: 'External org',
  MC: 'Medical college',
  OT: 'Other',
};

const FILTERS = [
  { id: 'PE',    label: 'Pending review' },
  { id: 'PL',    label: 'Planned' },
  { id: '',      label: 'Upcoming (PL + LV)' },
  { id: 'STALE', label: 'Stale (needs update)' },
  { id: 'CO',    label: 'Completed' },
  { id: 'CA',    label: 'Cancelled' },
  { id: 'DC',    label: 'Declined' },
];

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return String(v);
  }
}

export function CampsTab() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [selectedCamp, setSelectedCamp] = useState(null);
  const [reviewCamp, setReviewCamp] = useState(null);
  const [filter, setFilter] = useState('PE');
  const [statusAction, setStatusAction] = useState(null); // { camp, kind: 'complete' | 'cancel' }

  const listQ = useQuery({
    queryKey: ['admin', 'camps', filter],
    queryFn: () => {
      if (filter === 'STALE') return apiRequest('GET', '/camps?stale=true');
      return apiRequest('GET', filter ? `/camps?status=${filter}` : '/camps');
    },
    staleTime: 15_000,
  });

  const rows = listQ.data?.camps || [];
  const pendingCount = rows.length; // when filter=PE, this is the queue size

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id || 'upcoming'}
            type="button"
            onClick={() => setFilter(f.id)}
            className={
              'rounded-full border px-3 py-1 text-sm font-medium ' +
              (filter === f.id
                ? 'border-rk-700 bg-rk-50 text-rk-900'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50')
            }
          >
            {f.label}
            {f.id === 'PE' && filter !== 'PE' && pendingCount === 0 ? null : null}
          </button>
        ))}
        <button
          type="button"
          className="ml-auto rk-button-primary text-sm"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? 'Close' : '+ Schedule a camp'}
        </button>
      </div>

      {filter === 'PE' && rows.length > 0 ? (
        <p className="text-xs text-slate-500">
          {rows.length} camp{rows.length === 1 ? '' : 's'} awaiting NGO verification.
          Review submitter details before approving — once verified, the camp becomes
          public and donors can RSVP.
        </p>
      ) : null}

      {filter === 'STALE' && rows.length > 0 ? (
        <p className="text-xs text-slate-500">
          {rows.length} camp{rows.length === 1 ? '' : 's'} scheduled in the past but still
          marked <strong>Planned</strong> or <strong>Live</strong>. Mark each as{' '}
          <strong>Completed</strong> (with attendance metrics if known) or{' '}
          <strong>Cancelled</strong> (with a reason).
        </p>
      ) : null}

      {showForm ? (
        <CreateCampForm
          onCreated={() => {
            setShowForm(false);
            qc.invalidateQueries({ queryKey: ['admin', 'camps'] });
          }}
        />
      ) : null}

      <div className="rk-card overflow-x-auto p-0">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left">Camp</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">District</th>
              <th className="px-3 py-2 text-left">Organiser</th>
              <th className="px-3 py-2 text-right">Registered</th>
              <th className="px-3 py-2 text-right">Attended</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((c) => {
              const s = STATUS[c.status] || STATUS.PL;
              const isPending = c.status === 'PE';
              return (
                <tr key={c.id} className={isPending ? 'bg-amber-50/30' : ''}>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-500">
                      {c.venue} · {c.start_time?.slice(0, 5)}–{c.end_time?.slice(0, 5)}
                    </div>
                    {isPending && c.volunteer_training_requested ? (
                      <div className="mt-0.5 inline-block rounded bg-rk-50 px-1.5 py-0.5 text-[10px] font-medium text-rk-700">
                        Training requested
                        {c.expected_volunteer_count
                          ? ` · ${c.expected_volunteer_count} vols`
                          : ''}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{fmtDate(c.scheduled_date)}</td>
                  <td className="px-3 py-2 text-slate-700">{c.district_name}</td>
                  <td className="px-3 py-2">
                    <div className="text-slate-800">{c.organiser_name}</div>
                    <div className="text-xs text-slate-500">{ORGANISER[c.organiser_type]}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-900">
                    {c.registered_donor_count ?? 0}
                    {c.target_donor_count ? (
                      <span className="text-xs font-normal text-slate-500"> / {c.target_donor_count}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">{c.attended_donor_count ?? 0}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.cls}`}>
                      {s.label}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {isPending ? (
                      <button
                        type="button"
                        className="text-xs font-medium text-rk-700 hover:underline"
                        onClick={() => setReviewCamp(c)}
                      >
                        Review →
                      </button>
                    ) : (
                      <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                        {(c.status === 'PL' || c.status === 'LV') ? (
                          <>
                            <button
                              type="button"
                              className="text-xs font-medium text-green-700 hover:underline"
                              onClick={() => setStatusAction({ camp: c, kind: 'complete' })}
                              title="Mark this camp as completed"
                            >
                              Complete
                            </button>
                            <button
                              type="button"
                              className="text-xs font-medium text-rk-700 hover:underline"
                              onClick={() => setStatusAction({ camp: c, kind: 'cancel' })}
                              title="Mark this camp as cancelled"
                            >
                              Cancel
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          className="text-xs font-medium text-rk-700 hover:underline"
                          onClick={() => setSelectedCamp(c)}
                        >
                          Roster →
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && !listQ.isLoading ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-slate-500">
                  {filter === 'PE'
                    ? 'No camp applications awaiting review — great.'
                    : filter === 'STALE'
                      ? 'No stale camps — every past-dated camp has been completed or cancelled.'
                      : 'No camps in this filter.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {selectedCamp ? (
        <RosterPanel camp={selectedCamp} onClose={() => setSelectedCamp(null)} />
      ) : null}
      {statusAction ? (
        <StatusActionModal
          camp={statusAction.camp}
          kind={statusAction.kind}
          onClose={() => setStatusAction(null)}
          onDone={() => {
            setStatusAction(null);
            qc.invalidateQueries({ queryKey: ['admin', 'camps'] });
          }}
        />
      ) : null}
      {reviewCamp ? (
        <ReviewPanel
          camp={reviewCamp}
          onClose={() => setReviewCamp(null)}
          onActioned={() => {
            setReviewCamp(null);
            qc.invalidateQueries({ queryKey: ['admin', 'camps'] });
          }}
        />
      ) : null}
    </section>
  );
}

// StatusActionModal — mark a PL/LV camp as Completed (with optional
// attendance metrics) or Cancelled (with a required reason). Called from
// the row-level Complete / Cancel buttons in the camps table.
function StatusActionModal({ camp, kind, onClose, onDone }) {
  const isComplete = kind === 'complete';
  const [attended, setAttended] = useState(String(camp.attended_donor_count || ''));
  const [units, setUnits] = useState(String(camp.units_collected || ''));
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');

  const m = useMutation({
    mutationFn: () => {
      if (isComplete) {
        const body = {};
        if (attended.trim() !== '') body.attended_donor_count = Number(attended);
        if (units.trim() !== '') body.units_collected = Number(units);
        if (notes.trim() !== '') body.notes = notes.trim();
        return apiRequest('POST', `/camps/${camp.id}/complete`, body);
      }
      return apiRequest('POST', `/camps/${camp.id}/cancel`, {
        cancelled_reason: reason.trim(),
      });
    },
    onSuccess: onDone,
  });

  const canSubmit = isComplete ? true : reason.trim().length >= 3;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="mt-16 w-full max-w-lg space-y-4 rounded-xl bg-white p-6 shadow-lift">
        <h3 className="text-lg font-semibold text-slate-900">
          {isComplete ? 'Mark camp as completed' : 'Cancel camp'}
        </h3>
        <p className="text-sm text-slate-600">
          <strong>{camp.name}</strong> · {camp.venue} · {String(camp.scheduled_date).slice(0, 10)}
        </p>

        {isComplete ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="rk-label">Attended donors</span>
                <input
                  type="number"
                  min="0"
                  className="rk-input"
                  value={attended}
                  onChange={(e) => setAttended(e.target.value)}
                  placeholder={String(camp.registered_donor_count || 0)}
                />
              </label>
              <label className="block">
                <span className="rk-label">Units collected</span>
                <input
                  type="number"
                  min="0"
                  className="rk-input"
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                  placeholder="0"
                />
              </label>
            </div>
            <label className="block">
              <span className="rk-label">Notes (optional)</span>
              <input
                className="rk-input"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Marked complete after phone confirmation with organizer"
              />
            </label>
            <p className="text-xs text-slate-500">
              Leave attendance / units blank to keep the numbers the organizer entered via
              their magic-link dashboard (if any).
            </p>
          </>
        ) : (
          <label className="block">
            <span className="rk-label">
              Reason for cancellation <span className="text-rk-700">*</span>
            </span>
            <textarea
              className="rk-input"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Organizer's team unavailable due to unforeseen circumstances. Rescheduling planned for next month."
              required
            />
            <span className="mt-1 block text-xs text-slate-500">
              Written to audit trail. Also saved on the camp row (cancelled_reason).
            </span>
          </label>
        )}

        {m.error ? (
          <p className="text-xs text-rk-700">
            {m.error?.response?.data?.error === 'camp_not_yet_scheduled'
              ? 'Cannot mark a future-dated camp as completed. Use Cancel instead.'
              : m.error?.response?.data?.error === 'wrong_state'
                ? 'Camp already in a terminal state.'
                : m.error?.response?.data?.error || 'action_failed'}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <button type="button" className="rk-button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={isComplete ? 'rk-button-primary' : 'rk-button-primary bg-rk-700 hover:bg-rk-800'}
            disabled={!canSubmit || m.isPending}
            onClick={() => m.mutate()}
          >
            {m.isPending ? '…' : isComplete ? 'Mark completed' : 'Confirm cancellation'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewPanel({ camp, onClose, onActioned }) {
  const [reviewNotes, setReviewNotes] = useState('');
  const [declineReason, setDeclineReason] = useState('');
  const [showDecline, setShowDecline] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [copyState, setCopyState] = useState('');

  const verify = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/camps/${camp.id}/verify`, {
        review_notes: reviewNotes || undefined,
      }),
    onSuccess: (r) => setVerifyResult(r),
  });
  const decline = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/camps/${camp.id}/decline`, { reason: declineReason }),
    onSuccess: () => onActioned(),
  });

  function copyLink(url) {
    try {
      navigator.clipboard.writeText(url);
      setCopyState('Copied!');
      setTimeout(() => setCopyState(''), 1500);
    } catch {
      setCopyState('Copy failed — long-press the link.');
    }
  }

  // Verify-success screen: surface the magic link + a one-tap WhatsApp share.
  if (verifyResult) {
    const url = verifyResult.organizer_dashboard?.url || '';
    const waMsg = encodeURIComponent(
      `Hi ${camp.submitted_by_name || 'there'},\n\n` +
        `Your camp "${camp.name}" on ${camp.scheduled_date} is approved on Raktify.\n` +
        `Track RSVPs, send updates, and mark attendance here:\n${url}\n\n` +
        `(Bookmark this link — it's only for you.)`,
    );
    const waBase = camp.submitted_by_mobile
      ? `https://wa.me/${String(camp.submitted_by_mobile).replace(/[^0-9]/g, '')}`
      : 'https://wa.me/';
    return (
      <article className="rk-card border border-green-300 bg-green-50/40 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-green-900">Camp approved</h3>
            <p className="text-xs text-slate-600">
              {camp.name} · {fmtDate(camp.scheduled_date)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setVerifyResult(null);
              onActioned();
            }}
            className="rk-button-secondary text-xs"
          >
            Done
          </button>
        </div>
        <p className="text-sm text-slate-700">
          Share this magic link with{' '}
          <span className="font-semibold">{camp.submitted_by_name}</span>. It opens a
          scoped organizer dashboard — no Raktify login needed.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs">
          <input
            readOnly
            value={url}
            className="flex-1 truncate bg-transparent font-mono text-slate-700 outline-none"
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            className="rounded-md bg-rk-700 px-2 py-1 text-xs font-semibold text-white hover:bg-rk-800"
            onClick={() => copyLink(url)}
          >
            {copyState || 'Copy'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`${waBase}?text=${waMsg}`}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-green-600 px-3 py-1.5 text-xs font-semibold text-green-700 hover:bg-green-100"
          >
            Send via WhatsApp
          </a>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rk-button-secondary text-xs"
          >
            Preview dashboard
          </a>
        </div>
        <p className="text-xs text-slate-500">
          Link expires 30 days after the camp date. If the host loses access, ask them
          to contact you — you can re-issue from the camp row (coming soon).
        </p>
      </article>
    );
  }

  return (
    <article className="rk-card border border-amber-300 bg-amber-50/40 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{camp.name}</h3>
          <p className="text-xs text-slate-500">
            {fmtDate(camp.scheduled_date)} · {camp.venue} · {camp.district_name}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rk-button-secondary text-xs">
          Close
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-white p-3 text-sm sm:grid-cols-3">
        <dt className="text-slate-500">Submitted by</dt>
        <dd className="sm:col-span-2 font-medium text-slate-900">
          {camp.submitted_by_name}
          {camp.submitted_by_role ? (
            <span className="text-xs text-slate-500"> · {camp.submitted_by_role}</span>
          ) : null}
        </dd>
        <dt className="text-slate-500">Mobile</dt>
        <dd className="sm:col-span-2 font-mono text-sm text-slate-800">
          {camp.submitted_by_mobile}
        </dd>
        {camp.submitted_by_email ? (
          <>
            <dt className="text-slate-500">Email</dt>
            <dd className="sm:col-span-2">{camp.submitted_by_email}</dd>
          </>
        ) : null}
        <dt className="text-slate-500">Organiser</dt>
        <dd className="sm:col-span-2">
          {camp.organiser_name} ({ORGANISER[camp.organiser_type]})
        </dd>
        <dt className="text-slate-500">Time window</dt>
        <dd className="sm:col-span-2">
          {camp.start_time?.slice(0, 5)}–{camp.end_time?.slice(0, 5)}
        </dd>
        <dt className="text-slate-500">Target donors</dt>
        <dd className="sm:col-span-2">{camp.target_donor_count || 'not specified'}</dd>
        <dt className="text-slate-500">Volunteer training</dt>
        <dd className="sm:col-span-2">
          {camp.volunteer_training_requested ? (
            <span className="font-semibold text-rk-700">
              Requested
              {camp.expected_volunteer_count
                ? ` · ${camp.expected_volunteer_count} volunteers expected`
                : ''}
            </span>
          ) : (
            'Not requested'
          )}
        </dd>
        {camp.review_notes ? (
          <>
            <dt className="text-slate-500">Host notes</dt>
            <dd className="sm:col-span-2 italic text-slate-700">{camp.review_notes}</dd>
          </>
        ) : null}
      </dl>

      {showDecline ? (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="rk-label">Decline reason (visible internally)</span>
            <textarea
              className="rk-input min-h-[80px]"
              value={declineReason}
              onChange={(e) => setDeclineReason(e.target.value)}
              rows={3}
              placeholder="e.g. duplicate of a verified camp; venue not suitable; date conflicts with another camp in district"
              required
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rk-button-secondary text-xs"
              onClick={() => setShowDecline(false)}
            >
              Back
            </button>
            <button
              type="button"
              className="rounded-md bg-rk-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rk-800"
              disabled={decline.isPending || declineReason.length < 5}
              onClick={() => decline.mutate()}
            >
              {decline.isPending ? '…' : 'Decline application'}
            </button>
          </div>
          {decline.error ? (
            <p className="text-xs text-rk-700">
              {decline.error?.response?.data?.error || 'decline_failed'}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="rk-label">Review notes (optional)</span>
            <textarea
              className="rk-input"
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              rows={2}
              placeholder="e.g. spoke to host; venue confirmed; assigning Coord Anjali for training"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md border border-rk-300 px-3 py-1.5 text-xs font-semibold text-rk-700 hover:bg-rk-50"
              onClick={() => setShowDecline(true)}
            >
              Decline…
            </button>
            <button
              type="button"
              className="rk-button-primary text-xs"
              disabled={verify.isPending}
              onClick={() => verify.mutate()}
            >
              {verify.isPending ? '…' : 'Verify & approve'}
            </button>
          </div>
          {verify.error ? (
            <p className="text-xs text-rk-700">
              {verify.error?.response?.data?.error || 'verify_failed'}
            </p>
          ) : null}
        </div>
      )}
    </article>
  );
}

function CreateCampForm({ onCreated }) {
  const [states, setStates] = useState([]);
  const [districts, setDistricts] = useState([]);
  const [form, setForm] = useState({
    name: '',
    state_id: 0,
    district_id: 0,
    venue: '',
    address_line: '',
    pincode: '',
    scheduled_date: '',
    start_time: '09:00',
    end_time: '15:00',
    organiser_type: 'CO',
    organiser_name: '',
    target_donor_count: '',
  });
  const [err, setErr] = useState('');

  useEffect(() => {
    apiRequest('GET', '/geography/states').then((r) => setStates(r.states || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!form.state_id) {
      setDistricts([]);
      return;
    }
    apiRequest('GET', `/geography/districts?state_id=${form.state_id}`)
      .then((r) => setDistricts(r.districts || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.state_id]);

  const create = useMutation({
    mutationFn: () =>
      apiRequest('POST', '/camps', {
        ...form,
        state_id: Number(form.state_id),
        district_id: Number(form.district_id),
        target_donor_count: form.target_donor_count ? Number(form.target_donor_count) : undefined,
        pincode: form.pincode || undefined,
      }),
    onSuccess: () => onCreated(),
    onError: (e) => setErr(e?.response?.data?.error || 'create_failed'),
  });

  function set(k, v) {
    setForm((p) => ({ ...p, [k]: v }));
  }
  function submit(e) {
    e.preventDefault();
    setErr('');
    create.mutate();
  }

  return (
    <form onSubmit={submit} className="rk-card grid gap-3 sm:grid-cols-2">
      <h3 className="col-span-full text-sm font-semibold uppercase tracking-wide text-slate-500">
        Schedule a camp directly (staff-created, skips review)
      </h3>
      <label className="block">
        <span className="rk-label">Camp name</span>
        <input className="rk-input" value={form.name} onChange={(e) => set('name', e.target.value)} required />
      </label>
      <label className="block">
        <span className="rk-label">Organiser</span>
        <input className="rk-input" value={form.organiser_name} onChange={(e) => set('organiser_name', e.target.value)} required />
      </label>
      <label className="block">
        <span className="rk-label">Organiser type</span>
        <select className="rk-input" value={form.organiser_type} onChange={(e) => set('organiser_type', e.target.value)}>
          {Object.entries(ORGANISER).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="rk-label">Target donors</span>
        <input
          className="rk-input"
          inputMode="numeric"
          value={form.target_donor_count}
          onChange={(e) => set('target_donor_count', e.target.value.replace(/\D/g, ''))}
          placeholder="e.g. 50"
        />
      </label>
      <label className="block">
        <span className="rk-label">State</span>
        <select className="rk-input" value={form.state_id} onChange={(e) => set('state_id', e.target.value)} required>
          <option value={0}>— select —</option>
          {states.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="rk-label">District</span>
        <select className="rk-input" value={form.district_id} onChange={(e) => set('district_id', e.target.value)} disabled={!form.state_id} required>
          <option value={0}>— select —</option>
          {districts.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className="rk-label">Venue</span>
        <input className="rk-input" value={form.venue} onChange={(e) => set('venue', e.target.value)} required />
      </label>
      <label className="block sm:col-span-2">
        <span className="rk-label">Address</span>
        <input className="rk-input" value={form.address_line} onChange={(e) => set('address_line', e.target.value)} required />
      </label>
      <label className="block">
        <span className="rk-label">Date</span>
        <input type="date" className="rk-input" value={form.scheduled_date} onChange={(e) => set('scheduled_date', e.target.value)} required />
      </label>
      <label className="block">
        <span className="rk-label">Pincode</span>
        <input
          className="rk-input"
          inputMode="numeric"
          maxLength={6}
          value={form.pincode}
          onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))}
        />
      </label>
      <label className="block">
        <span className="rk-label">Start time</span>
        <input type="time" className="rk-input" value={form.start_time} onChange={(e) => set('start_time', e.target.value)} required />
      </label>
      <label className="block">
        <span className="rk-label">End time</span>
        <input type="time" className="rk-input" value={form.end_time} onChange={(e) => set('end_time', e.target.value)} required />
      </label>
      {err ? <p className="col-span-full text-sm text-rk-700">{err}</p> : null}
      <div className="col-span-full flex justify-end">
        <button type="submit" className="rk-button-primary text-sm" disabled={create.isPending}>
          {create.isPending ? '…' : 'Create camp'}
        </button>
      </div>
    </form>
  );
}

function RosterPanel({ camp, onClose }) {
  const q = useQuery({
    queryKey: ['admin', 'camp-roster', camp.id],
    queryFn: () => apiRequest('GET', `/camps/${camp.id}/registrations`),
  });
  const regs = q.data?.registrations || [];

  return (
    <article className="rk-card space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{camp.name}</h3>
          <p className="text-xs text-slate-500">
            {fmtDate(camp.scheduled_date)} · {camp.venue}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rk-button-secondary text-xs">
          Close
        </button>
      </div>
      {q.isLoading ? (
        <p className="text-sm text-slate-500">…</p>
      ) : regs.length === 0 ? (
        <p className="text-sm text-slate-500">No registrations yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {regs.map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2 text-sm">
              <span className="font-medium text-slate-900">{r.full_name}</span>
              <span className="text-xs text-slate-500">
                {r.blood_group_code || 'unverified'} · {fmtDate(r.registered_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
