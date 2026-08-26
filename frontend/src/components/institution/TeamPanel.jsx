import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';
import { SetupLinkCard } from './SetupLinkCard.jsx';
import { StaffRosterTable, STATE_META } from './StaffRoster.jsx';

/**
 * "Team" tab for a hospital or blood-bank portal: who at this institution can
 * sign in, and — for an institution admin — invite, unlock, re-issue a setup
 * link, or retire a colleague.
 *
 * Reads GET /institutions/me/users rather than /:id/users because a staff portal
 * never learns its own institution UUID (the JWT carries it; the client persists
 * only token / role / user_id). The response returns institution_id, which is
 * what the action URLs below are built from — so the id used for a mutation is
 * always the one the server itself resolved from the session.
 *
 * Renders read-only when the API reports can_manage:false, i.e. for a technician
 * rather than an institution admin. That is a server decision, not a client one:
 * every action endpoint re-checks is_institution_admin from the row.
 */
export function TeamPanel() {
  const qc = useQueryClient();
  const [issued, setIssued] = useState(null); // last setup link, invite or re-issue
  const [busyId, setBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const rosterQ = useQuery({
    queryKey: ['institution', 'me', 'users'],
    queryFn: () => apiRequest('GET', '/institutions/me/users'),
    staleTime: 10_000,
  });

  const institutionId = rosterQ.data?.institution_id;
  const canManage = Boolean(rosterQ.data?.can_manage);
  const users = rosterQ.data?.users || [];

  const refresh = () => qc.invalidateQueries({ queryKey: ['institution', 'me', 'users'] });

  const act = useMutation({
    mutationFn: ({ kind, user, body }) =>
      apiRequest('POST', `/institutions/${institutionId}/users/${user.id}/${kind}`, body),
    onSuccess: (data, vars) => {
      setBusyId(null);
      setActionError(null);
      if (vars.kind === 'reissue-setup') {
        setIssued({
          label: `Setup link for ${data.username}`,
          username: data.username,
          url: data.setup_url,
          expiresAt: data.setup_expires_at,
          whatsappSent: data.whatsapp_sent,
          nextStep: data.next_step,
        });
      }
      refresh();
    },
    onError: (err) => {
      setBusyId(null);
      setActionError(err?.response?.data?.error || 'action_failed');
    },
  });

  function onAction(kind, user) {
    setActionError(null);
    if (kind === 'deactivate') {
      const reason = window.prompt(
        `Deactivate ${user.username}? They will no longer be able to sign in.\n\nReason (kept on the record):`,
      );
      if (reason === null) return;
      const trimmed = reason.trim();
      if (trimmed && trimmed.length < 3) {
        setActionError('reason_too_short');
        return;
      }
      setBusyId(user.id);
      act.mutate({ kind: 'deactivate', user, body: trimmed ? { reason: trimmed } : {} });
      return;
    }
    if (kind === 'reissue') {
      if (
        !window.confirm(
          `Re-issue a password-setup link for ${user.username}?\n\nThis invalidates any link already sent and clears their current password.`,
        )
      ) {
        return;
      }
      setBusyId(user.id);
      act.mutate({ kind: 'reissue-setup', user, body: {} });
      return;
    }
    setBusyId(user.id);
    act.mutate({ kind, user, body: {} });
  }

  return (
    <div className="space-y-4">
      <AttentionBanner users={users} />

      {canManage ? (
        <InviteForm institutionId={institutionId} onIssued={setIssued} onDone={refresh} />
      ) : (
        <div className="rk-card text-sm text-slate-600">
          You can see your team here. Inviting colleagues and re-issuing sign-in links is limited to
          your institution's admin account.
        </div>
      )}

      {issued ? (
        <div className="space-y-2">
          <SetupLinkCard {...issued} />
          <button
            type="button"
            className="text-xs text-slate-500 hover:underline"
            onClick={() => setIssued(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {actionError ? <p className="text-sm text-rk-700">Action failed: {actionError}</p> : null}

      {rosterQ.isLoading ? <div className="rk-card">Loading team…</div> : null}
      {rosterQ.error ? (
        <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
          {rosterQ.error?.response?.data?.error || 'load_failed'}
        </div>
      ) : null}

      {rosterQ.data ? (
        <StaffRosterTable
          users={users}
          canManage={canManage}
          busyId={busyId}
          onAction={onAction}
        />
      ) : null}
    </div>
  );
}

/**
 * Surfaces the states that mean somebody cannot sign in right now. Without this,
 * a colleague whose setup link never arrived is a support call rather than a
 * visible row — which is the failure this whole panel was built for.
 */
function AttentionBanner({ users }) {
  const stuck = users.filter((u) =>
    ['locked', 'setup_expired', 'setup_pending'].includes(u.credential_state),
  );
  if (!stuck.length) return null;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="font-semibold">
        {stuck.length} account{stuck.length === 1 ? '' : 's'} cannot sign in yet
      </p>
      <ul className="mt-1 space-y-0.5 text-xs">
        {stuck.map((u) => (
          <li key={u.id}>
            <span className="font-mono font-medium">{u.username}</span> —{' '}
            {STATE_META[u.credential_state]?.hint || u.credential_state}
          </li>
        ))}
      </ul>
    </div>
  );
}

function InviteForm({ institutionId, onIssued, onDone }) {
  const [open, setOpen] = useState(false);
  const [suffix, setSuffix] = useState('');
  const [mobile, setMobile] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      apiRequest('POST', `/institutions/${institutionId}/users`, {
        ...(suffix.trim() ? { username_suffix: suffix.trim().toLowerCase() } : {}),
        mobile: mobile.trim(),
        ...(isAdmin ? { is_institution_admin: true } : {}),
      }),
    onSuccess: (data) => {
      onIssued({
        label: `Setup link for ${data.username}`,
        username: data.username,
        url: data.setup_url,
        expiresAt: data.setup_expires_at,
        whatsappSent: data.whatsapp_sent,
        nextStep: data.next_step,
      });
      setSuffix('');
      setMobile('');
      setIsAdmin(false);
      setOpen(false);
      onDone();
    },
  });

  // Mirrors username_suffix in the invite schema (routes/institutions.js) — the
  // full username is `<shortname>_<suffix>`, derived server-side.
  const suffixOk = !suffix.trim() || /^[a-z0-9][a-z0-9_-]{0,19}$/.test(suffix.trim().toLowerCase());
  const mobileOk = /^(\+91)?[6-9]\d{9}$/.test(mobile.trim().replace(/[\s-]/g, ''));
  const canSubmit = suffixOk && mobileOk && !invite.isPending;

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Everyone who signs in for this institution has their own login. Never share one account.
        </p>
        <button type="button" className="rk-button-primary" onClick={() => setOpen(true)}>
          Invite a colleague
        </button>
      </div>
    );
  }

  return (
    <form
      className="rk-card max-w-xl space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) invite.mutate();
      }}
    >
      <h3 className="text-sm font-semibold text-slate-900">Invite a colleague</h3>
      <p className="text-xs text-slate-600">
        They get a WhatsApp with a single-use link to set their own password — you never choose it
        for them. If the WhatsApp does not send, the link is shown here once so you can pass it on.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="rk-label" htmlFor="invite-mobile">
            Their mobile
          </label>
          <input
            id="invite-mobile"
            className="rk-input"
            inputMode="tel"
            placeholder="+919876543210"
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            required
          />
          {mobile && !mobileOk ? (
            <p className="mt-1 text-xs text-rk-700">
              Needs to be a 10-digit Indian mobile starting 6-9.
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              One staff login per number — the setup link is sent here.
            </p>
          )}
        </div>
        <div>
          <label className="rk-label" htmlFor="invite-suffix">
            Username suffix <span className="text-slate-400">(optional)</span>
          </label>
          <input
            id="invite-suffix"
            className="rk-input"
            placeholder="tech, lab, counter2"
            value={suffix}
            onChange={(e) => setSuffix(e.target.value)}
          />
          {suffix && !suffixOk ? (
            <p className="mt-1 text-xs text-rk-700">
              Lowercase letters, digits, - and _ only (max 20).
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Their username becomes your shortname + this. Defaults to “user”.
            </p>
          )}
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={isAdmin}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
        <span>
          Make them an institution admin
          <span className="block text-xs text-slate-500">
            Admins can invite, unlock and retire colleagues. Keep at least two so you are never
            locked out — the last admin cannot be deactivated.
          </span>
        </span>
      </label>

      {invite.error ? (
        <p className="text-sm text-rk-700">
          {inviteErrorText(invite.error?.response?.data?.error)}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          className="rk-button-secondary"
          onClick={() => setOpen(false)}
          disabled={invite.isPending}
        >
          Cancel
        </button>
        <button type="submit" className="rk-button-primary" disabled={!canSubmit}>
          {invite.isPending ? 'Inviting…' : 'Send invite'}
        </button>
      </div>
    </form>
  );
}

function inviteErrorText(code) {
  switch (code) {
    case 'mobile_already_in_staff_cluster':
      return 'That number already has a staff login. One number, one account — use a different number, or re-issue the setup link on the existing account.';
    case 'username_taken':
    case 'username_unavailable':
      return 'That username is taken. Try a different suffix.';
    case 'institution_not_active':
      return 'This institution is not active yet, so a login would be refused at sign-in.';
    case 'not_institution_admin':
      return 'Only your institution admin can invite colleagues.';
    case 'invalid_mobile_format':
      return 'That does not look like an Indian mobile number.';
    default:
      return `Invite failed: ${code || 'unknown'}`;
  }
}
