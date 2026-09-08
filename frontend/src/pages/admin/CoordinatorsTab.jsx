import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';
import { USERNAME_RE } from '../../lib/usernameRe.js';

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
];

export function CoordinatorsTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('pending');
  const [showInvite, setShowInvite] = useState(false);

  const listQ = useQuery({
    queryKey: ['admin', 'coordinators', filter],
    queryFn: () =>
      apiRequest('GET', `/admin/coordinators${filter ? `?status=${filter}` : ''}`),
    staleTime: 15_000,
  });

  const verify = useMutation({
    mutationFn: (id) => apiRequest('POST', `/admin/coordinators/${id}/verify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'coordinators'] }),
  });

  const suspend = useMutation({
    mutationFn: ({ id, reason }) =>
      apiRequest('POST', `/admin/coordinators/${id}/suspend`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'coordinators'] }),
  });

  const rows = listQ.data?.coordinators || [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id || 'all'}
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
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowInvite(true)}
          className="rk-button-primary ml-auto text-sm"
        >
          + Invite coordinator
        </button>
        <span className="text-sm text-slate-500">
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
              <th className="px-3 py-2 text-left">Coordinator</th>
              <th className="px-3 py-2 text-left">District</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Reliability</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-2">
                  <div className="font-medium">{c.display_name}</div>
                  <div className="font-mono text-[10px] text-slate-400">{c.id}</div>
                </td>
                <td className="px-3 py-2">{c.district_id}</td>
                <td className="px-3 py-2">
                  <StatusBadge c={c} />
                </td>
                <td className="px-3 py-2 text-right">{c.reliability_score}/100</td>
                <td className="px-3 py-2 text-right">
                  {c.id_verified_at ? null : (
                    <button
                      type="button"
                      className="rk-button-primary text-xs"
                      onClick={() => verify.mutate(c.id)}
                      disabled={verify.isPending}
                    >
                      Verify
                    </button>
                  )}
                  {c.is_active ? (
                    <button
                      type="button"
                      className="ml-2 text-xs text-rk-700 hover:underline"
                      onClick={() => {
                        const reason = window.prompt('Suspension reason (5+ chars)?');
                        if (reason && reason.length >= 5) {
                          suspend.mutate({ id: c.id, reason });
                        }
                      }}
                      disabled={suspend.isPending}
                    >
                      Suspend
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !listQ.isLoading ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-500">
                  No coordinators in this filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {showInvite ? <InviteCoordinatorModal onClose={() => setShowInvite(false)} /> : null}
    </section>
  );
}

function InviteCoordinatorModal({ onClose }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    full_name: '',
    display_name: '',
    username: '',
    mobile: '+91',
    email: '',
    state_id: '',
    district_id: '',
    taluka_id: '',
    is_district_lead: false,
  });
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const statesQ = useQuery({
    queryKey: ['geo', 'states'],
    queryFn: () => apiRequest('GET', '/geography/states'),
    staleTime: 24 * 3600_000,
  });
  const districtsQ = useQuery({
    queryKey: ['geo', 'districts', form.state_id],
    queryFn: () => apiRequest('GET', `/geography/districts?state_id=${form.state_id}`),
    enabled: !!form.state_id,
    staleTime: 24 * 3600_000,
  });
  const talukasQ = useQuery({
    queryKey: ['geo', 'talukas', form.district_id],
    queryFn: () => apiRequest('GET', `/geography/talukas?district_id=${form.district_id}`),
    enabled: !!form.district_id,
    staleTime: 24 * 3600_000,
  });

  const invite = useMutation({
    mutationFn: () => {
      const body = {
        full_name: form.full_name.trim(),
        mobile: form.mobile.trim(),
        state_id: Number(form.state_id),
        district_id: Number(form.district_id),
        is_district_lead: !!form.is_district_lead,
      };
      if (form.display_name.trim()) body.display_name = form.display_name.trim();
      if (form.username.trim()) body.username = form.username.trim();
      if (form.email.trim()) body.email = form.email.trim();
      if (form.taluka_id) body.taluka_id = Number(form.taluka_id);
      return apiRequest('POST', '/admin/coordinators', body);
    },
    onSuccess: (data) => {
      setSuccess(data);
      qc.invalidateQueries({ queryKey: ['admin', 'coordinators'] });
    },
    onError: (err) => {
      const b = err?.response?.data || {};
      if (b.error === 'check_violation') {
        setError(`Database rejected: ${b.constraint} (${b.detail || ''})`);
      } else if (b.detail) {
        setError(`${b.error}: ${b.detail}`);
      } else {
        setError(b.error || 'invite_failed');
      }
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg max-h-[90vh] overflow-y-auto">
        {success ? (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold text-stone-900">Coordinator invited ✓</h3>
            <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <p className="font-medium">{success.username}</p>
              <p className="font-mono text-xs">{success.mobile}</p>
              {success.whatsapp_sent ? (
                <p className="mt-2 text-xs">
                  ✓ Activation WhatsApp sent. wamid:{' '}
                  <code className="text-[10px]">{success.whatsapp_message_id}</code>
                </p>
              ) : (
                <p className="mt-2 text-xs text-amber-700">
                  ⚠ WhatsApp did NOT send. Share this URL out-of-band:
                </p>
              )}
              <p className="mt-2 break-all rounded bg-white p-2 font-mono text-[11px]">
                {success.activation_url}
              </p>
              <p className="mt-2 text-xs text-stone-600">{success.next_step}</p>
            </div>
            <button type="button" className="rk-button-primary w-full" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              invite.mutate();
            }}
            className="space-y-3"
          >
            <h3 className="text-lg font-semibold text-stone-900">Invite NGO coordinator</h3>
            <p className="text-xs text-slate-500">
              Coordinator is staff-cluster auth (username + password + TOTP). They activate
              via the WhatsApp link, then sign in at <code>/staff/login</code>.
            </p>

            <label className="block">
              <span className="rk-label">Full name (required)</span>
              <input
                type="text"
                className="rk-input w-full"
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                required
                minLength={2}
              />
            </label>

            <label className="block">
              <span className="rk-label">Display name (optional)</span>
              <input
                type="text"
                className="rk-input w-full"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              />
            </label>

            <label className="block">
              <span className="rk-label">Username (optional — auto-derived from full name)</span>
              <input
                type="text"
                className="rk-input w-full font-mono"
                value={form.username}
                onChange={(e) =>
                  setForm({ ...form, username: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })
                }
                pattern={USERNAME_RE.source}
                placeholder="e.g. priya_coord"
              />
            </label>

            <label className="block">
              <span className="rk-label">Mobile (required)</span>
              <input
                type="tel"
                className="rk-input w-full font-mono"
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                required
                pattern="^\+91\d{10}$"
                placeholder="+91XXXXXXXXXX"
              />
            </label>

            <label className="block">
              <span className="rk-label">Email (optional)</span>
              <input
                type="email"
                className="rk-input w-full"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </label>

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="rk-label">State</span>
                <select
                  className="rk-input w-full"
                  value={form.state_id}
                  onChange={(e) =>
                    setForm({ ...form, state_id: e.target.value, district_id: '', taluka_id: '' })
                  }
                  required
                >
                  <option value="">—</option>
                  {(statesQ.data?.states || []).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="rk-label">District</span>
                <select
                  className="rk-input w-full"
                  value={form.district_id}
                  onChange={(e) => setForm({ ...form, district_id: e.target.value, taluka_id: '' })}
                  required
                  disabled={!form.state_id}
                >
                  <option value="">—</option>
                  {(districtsQ.data?.districts || []).map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="rk-label">Taluka</span>
                <select
                  className="rk-input w-full"
                  value={form.taluka_id}
                  onChange={(e) => setForm({ ...form, taluka_id: e.target.value })}
                  disabled={!form.district_id}
                >
                  <option value="">—</option>
                  {(talukasQ.data?.talukas || []).map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={form.is_district_lead}
                onChange={(e) => setForm({ ...form, is_district_lead: e.target.checked })}
              />
              Mark as district lead (escalation handover anchor)
            </label>

            {error ? <p className="text-sm text-rk-700">{error}</p> : null}

            <div className="flex gap-2 pt-2">
              <button type="button" className="rk-button-secondary flex-1" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="rk-button-primary flex-1" disabled={invite.isPending}>
                {invite.isPending ? '…' : 'Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ c }) {
  const cls =
    c.suspended_at != null
      ? 'bg-rk-700 text-white'
      : c.id_verified_at == null
        ? 'bg-amber-500 text-white'
        : c.is_active
          ? 'bg-green-100 text-green-800'
          : 'bg-slate-200 text-slate-700';
  const label =
    c.suspended_at != null
      ? 'Suspended'
      : c.id_verified_at == null
        ? 'Pending'
        : c.is_active
          ? 'Active'
          : 'Inactive';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>;
}
