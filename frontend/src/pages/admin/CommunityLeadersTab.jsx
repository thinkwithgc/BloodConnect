import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'suspended', label: 'Suspended' },
];

/**
 * Community-leader management (Phase 1).
 *
 * What it does today:
 *   • List all community leaders with status + impact counters
 *   • Invite a new leader (form modal)
 *   • Suspend / reactivate
 *
 * What it does NOT do yet (Phase 2 / 3):
 *   • Show the leader's communities list
 *   • Edit profile fields from admin side
 *   • Bulk operations
 *
 * Invitation is intentionally low-friction: enter mobile + name + light
 * metadata → backend creates platform_users + community_leaders rows →
 * admin tells the leader out-of-band ("I've added you, log in at
 * raktify.choudhari.ngo/login with your mobile"). No setup token + no
 * automatic WhatsApp template. The leader's existing WhatsApp group stays
 * THEIR comms channel; we don't insert ourselves into it.
 */
export function CommunityLeadersTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [showInvite, setShowInvite] = useState(false);
  const [drillLeader, setDrillLeader] = useState(null); // { id, display_name } | null

  const listQ = useQuery({
    queryKey: ['admin', 'community-leaders', filter],
    queryFn: () => apiRequest('GET', `/admin/community-leaders?status=${filter}`),
    staleTime: 15_000,
  });

  const suspend = useMutation({
    mutationFn: ({ id, reason }) =>
      apiRequest('POST', `/admin/community-leaders/${id}/suspend`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'community-leaders'] }),
  });

  const reactivate = useMutation({
    mutationFn: (id) => apiRequest('POST', `/admin/community-leaders/${id}/reactivate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'community-leaders'] }),
  });

  const rows = listQ.data?.leaders || [];

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
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
          + Invite leader
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
              <th className="px-3 py-2 text-left">Leader</th>
              <th className="px-3 py-2 text-left">Mobile</th>
              <th className="px-3 py-2 text-left">Region</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-right">Communities</th>
              <th className="px-3 py-2 text-right">Donors</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="font-medium text-rk-700 hover:underline"
                    onClick={() => setDrillLeader({ id: l.id, display_name: l.display_name })}
                  >
                    {l.display_name}
                  </button>
                  {l.invitation_notes ? (
                    <div className="text-xs text-slate-500">{l.invitation_notes}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{l.mobile}</td>
                <td className="px-3 py-2 text-slate-600">
                  {[l.district_name, l.state_name].filter(Boolean).join(', ') || '—'}
                </td>
                <td className="px-3 py-2">
                  <StatusBadge l={l} />
                  {l.suspension_reason ? (
                    <div className="mt-0.5 text-xs text-rk-700">{l.suspension_reason}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right">{l.communities_count}</td>
                <td className="px-3 py-2 text-right">{l.total_donor_count}</td>
                <td className="px-3 py-2 text-right">
                  {l.is_active ? (
                    <button
                      type="button"
                      className="text-xs text-rk-700 hover:underline"
                      onClick={() => {
                        const reason = window.prompt('Suspension reason (3+ chars)?');
                        if (reason && reason.length >= 3) {
                          suspend.mutate({ id: l.id, reason });
                        }
                      }}
                      disabled={suspend.isPending}
                    >
                      Suspend
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rk-button-primary text-xs"
                      onClick={() => reactivate.mutate(l.id)}
                      disabled={reactivate.isPending}
                    >
                      Reactivate
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !listQ.isLoading ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-slate-500">
                  No community leaders in this filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {showInvite ? <InviteModal onClose={() => setShowInvite(false)} /> : null}
      {drillLeader ? (
        <LeaderDrillDownModal leader={drillLeader} onClose={() => setDrillLeader(null)} />
      ) : null}
    </section>
  );
}

function LeaderDrillDownModal({ leader, onClose }) {
  const q = useQuery({
    queryKey: ['admin', 'leader-drilldown', leader.id],
    queryFn: () =>
      apiRequest('GET', `/admin/communities?owner_id=${encodeURIComponent(leader.id)}`),
    staleTime: 30_000,
  });
  const communities = q.data?.communities || [];
  const owned = communities.filter((c) => c.relation === 'owner');
  const coLed = communities.filter((c) => c.relation === 'co_leader');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-xl bg-white p-5 shadow-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-lg font-semibold text-stone-900">{leader.display_name}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {q.isLoading ? (
          <p className="mt-3 text-sm text-stone-500">Loading…</p>
        ) : (
          <div className="mt-3 space-y-4">
            <DrillSection title={`Owns (${owned.length})`} rows={owned} emptyMessage="Doesn't own any communities yet." />
            <DrillSection title={`Co-leads (${coLed.length})`} rows={coLed} emptyMessage="Not a co-leader on any communities." />
          </div>
        )}
      </div>
    </div>
  );
}

function DrillSection({ title, rows, emptyMessage }) {
  return (
    <div>
      <h4 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{title}</h4>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500">{emptyMessage}</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <div className="font-medium text-stone-900">{c.name}</div>
                <div className="text-xs text-stone-500">
                  {[c.taluka_name, c.district_name, c.state_name].filter(Boolean).join(' · ')} ·{' '}
                  {c.donor_count} donors · {c.moderator_count} co-leaders
                </div>
              </div>
              <span
                className={
                  'rounded-full px-2 py-0.5 text-xs font-medium ' +
                  (c.is_active ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-700')
                }
              >
                {c.is_active ? 'Active' : 'Suspended'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ l }) {
  if (l.suspended_at) {
    return (
      <span className="rounded-full bg-rk-700 px-2 py-0.5 text-xs font-medium text-white">
        Suspended
      </span>
    );
  }
  if (l.last_login_at) {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        Active
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
      Invited
    </span>
  );
}

function InviteModal({ onClose }) {
  const qc = useQueryClient();
  // Default: English (migration 320). preferred_language is the WhatsApp
  // language, not the UI language, and an admin inviting a leader is guessing
  // it -- so the safe guess is the one language every template is approved in.
  // community_leader_signin has Meta-approved MR + HI + EN, so switching this
  // select to Marathi or Hindi still delivers; it just has to be a real answer.
  // Any explicit pick here overrides the column default at send time.
  const [form, setForm] = useState({
    mobile: '+91',
    full_name: '',
    display_name: '',
    preferred_language: 'en',
    email: '',
    invitation_notes: '',
  });
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const invite = useMutation({
    mutationFn: () => {
      const body = {
        mobile: form.mobile.trim(),
        full_name: form.full_name.trim(),
        display_name: form.display_name.trim() || form.full_name.trim(),
        preferred_language: form.preferred_language,
      };
      if (form.email.trim()) body.email = form.email.trim();
      if (form.invitation_notes.trim()) body.invitation_notes = form.invitation_notes.trim();
      return apiRequest('POST', '/admin/community-leaders', body);
    },
    onSuccess: (data) => {
      setSuccess(data);
      qc.invalidateQueries({ queryKey: ['admin', 'community-leaders'] });
    },
    onError: (err) => {
      const body = err?.response?.data || {};
      // Surface the real reason instead of a bare error code. CHECK
      // constraint failures (23514) flow through with constraint name +
      // detail; other DB errors get the detail string from the API.
      if (body.error === 'check_violation') {
        setError(`Database rejected: ${body.constraint || 'check'} (${body.detail || ''})`);
      } else if (body.detail) {
        setError(`${body.error || 'failed'}: ${body.detail}`);
      } else {
        setError(body.error || 'invite_failed');
      }
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-lg">
        {success ? (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold text-stone-900">Leader invited ✓</h3>
            <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
              <p className="font-medium">{success.display_name}</p>
              <p className="font-mono text-xs">{success.mobile}</p>
              {success.whatsapp_sent ? (
                <p className="mt-2 text-xs">
                  ✓ WhatsApp invitation accepted by Meta. wamid:{' '}
                  <code className="text-[10px]">{success.whatsapp_message_id}</code>
                </p>
              ) : (
                <p className="mt-2 text-xs text-amber-700">
                  ⚠ Row created but WhatsApp did NOT send — template may still be in Meta
                  approval, or billing/delivery issue. Tell the leader out-of-band.
                </p>
              )}
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
            <h3 className="text-lg font-semibold text-stone-900">Invite community leader</h3>
            <p className="text-xs text-slate-500">
              Tell the leader out-of-band that they've been added; they log in at <code>/login</code>{' '}
              with their mobile + OTP.
            </p>

            <label className="block">
              <span className="rk-label">Mobile (required)</span>
              <input
                type="tel"
                className="rk-input w-full font-mono"
                value={form.mobile}
                onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                placeholder="+91XXXXXXXXXX"
                required
                pattern="^\+91\d{10}$"
              />
            </label>

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
              <span className="rk-label">Display name (optional — defaults to full name)</span>
              <input
                type="text"
                className="rk-input w-full"
                value={form.display_name}
                onChange={(e) => setForm({ ...form, display_name: e.target.value })}
                placeholder="Public name on community profiles"
              />
            </label>

            <label className="block">
              <span className="rk-label">Preferred language</span>
              <select
                className="rk-input w-full"
                value={form.preferred_language}
                onChange={(e) => setForm({ ...form, preferred_language: e.target.value })}
              >
                <option value="mr">मराठी (Marathi)</option>
                <option value="hi">हिंदी (Hindi)</option>
                <option value="en">English</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">
                Welcome WhatsApp + all future Raktify messages will use this language.
              </p>
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

            <label className="block">
              <span className="rk-label">Invitation notes (internal — for admin reference)</span>
              <textarea
                className="rk-input w-full"
                rows={2}
                value={form.invitation_notes}
                onChange={(e) => setForm({ ...form, invitation_notes: e.target.value })}
                placeholder="e.g. Marwadi Yuva Manch Amravati chapter lead — contacted via Anjali"
                maxLength={500}
              />
            </label>

            {error ? <p className="text-sm text-rk-700">{error}</p> : null}

            <div className="flex gap-2 pt-2">
              <button type="button" className="rk-button-secondary flex-1" onClick={onClose}>
                Cancel
              </button>
              <button
                type="submit"
                className="rk-button-primary flex-1"
                disabled={invite.isPending}
              >
                {invite.isPending ? '…' : 'Invite'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
