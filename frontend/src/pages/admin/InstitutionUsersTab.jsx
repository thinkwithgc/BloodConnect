import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';
import { SetupLinkCard } from '../../components/institution/SetupLinkCard.jsx';
import {
  StaffRosterTable,
  STATE_META,
  ATTENTION_STATES,
} from '../../components/institution/StaffRoster.jsx';
import {
  ReasonDialog,
  institutionErrorText,
} from '../../components/institution/ReasonDialog.jsx';
import { InviteForm } from '../../components/institution/InviteForm.jsx';

/**
 * Cross-institution staff-login directory — the one screen that answers
 * "is anyone stuck?".
 *
 * Every other view of a staff account is institution-scoped, which is exactly
 * the blind spot that let an activated hospital sit with an undelivered
 * password-setup link and nobody able to see it: the hospital could not sign in
 * to ask, and the NGO had no list to look at. A `setup_expired` or
 * `setup_pending` row that has never signed in is the fingerprint of a
 * SETUP_LINK send that silently failed (the notification chokepoint returns
 * success:false without throwing when a template env var is unset).
 *
 * Actions post to the same institution-scoped endpoints the hospital's own Team
 * tab uses — there is one set of write paths, not an admin copy. That includes
 * ADDING a login: the NGO has to be able to provision the first account itself,
 * because until it can, an institution whose only admin never received their
 * setup link is deadlocked — they cannot sign in to invite anyone, and every
 * other invite path in the app requires an institution admin already signed in.
 */

const ROLE_FILTERS = [
  { id: '', label: 'All roles' },
  { id: 'hospital', label: 'Hospital' },
  { id: 'blood_bank', label: 'Blood bank' },
  { id: 'dho', label: 'DHO' },
];

export function InstitutionUsersTab() {
  // Read from the URL so OnboardingDetail can deep-link straight at one
  // institution's accounts ("?tab=institution-users&institution_id=…").
  const [params, setParams] = useSearchParams();
  const institutionFilter = params.get('institution_id') || '';

  const [role, setRole] = useState('');
  const [state, setState] = useState('');
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [issued, setIssued] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [actionNote, setActionNote] = useState(null);
  // The reason-gated action waiting on its justification: { kind, user }.
  const [pending, setPending] = useState(null);

  const qc = useQueryClient();

  const listQ = useQuery({
    queryKey: ['admin', 'institution-users', { institutionFilter, role, state, q }],
    queryFn: () => {
      const sp = new URLSearchParams();
      if (institutionFilter) sp.set('institution_id', institutionFilter);
      if (role) sp.set('role', role);
      if (state) sp.set('state', state);
      if (q.trim()) sp.set('q', q.trim());
      const qs = sp.toString();
      return apiRequest('GET', `/admin/institution-users${qs ? `?${qs}` : ''}`);
    },
    staleTime: 10_000,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'institution-users'] });

  const act = useMutation({
    mutationFn: ({ kind, user, body }) =>
      apiRequest('POST', `/institutions/${user.institution_id}/users/${user.id}/${kind}`, body),
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
        setActionNote(null);
      } else {
        setActionNote(`${vars.user.username}: ${data.status}`);
      }
      refresh();
    },
    onError: (err) => {
      setBusyId(null);
      setActionError(err?.response?.data?.error || 'action_failed');
    },
  });

  // Keyed by username, not id — that is the contract of the existing
  // POST /auth/institutional/reset-2fa (used by the Staff security tab).
  const reset2fa = useMutation({
    mutationFn: (user) =>
      apiRequest('POST', '/auth/institutional/reset-2fa', { username: user.username }),
    onSuccess: (data) => {
      setBusyId(null);
      setActionError(null);
      setActionNote(`${data.username}: authenticator cleared — they re-enrol on next sign-in.`);
      refresh();
    },
    onError: (err) => {
      setBusyId(null);
      setActionError(err?.response?.data?.error || 'reset_2fa_failed');
    },
  });

  function onAction(kind, user) {
    setActionError(null);
    setActionNote(null);

    if (kind === 'reset2fa') {
      if (
        !window.confirm(
          `Clear the authenticator enrolment for ${user.username}?\n\nThey will be walked through 2FA setup again on their next sign-in. Their password is unchanged.`,
        )
      ) {
        return;
      }
      setBusyId(user.id);
      reset2fa.mutate(user);
      return;
    }

    // Reason-gated. The server requires >= 10 characters and writes the text to
    // an append-only audit row, which a prompt can neither enforce nor explain.
    if (kind === 'deactivate' || kind === 'admin-flag') {
      setPending({ kind, user });
      return;
    }

    if (kind === 'reissue') {
      if (
        !window.confirm(
          `Re-issue a password-setup link for ${user.username}?\n\nThis invalidates any link already sent and clears their current password. The new link is shown once, here.`,
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

  const counts = listQ.data?.state_counts || {};
  const needsAttention = listQ.data?.needs_attention ?? 0;
  const users = listQ.data?.users || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Institution staff logins</h2>
          <p className="text-sm text-slate-600">
            Every hospital, blood-bank and DHO account, and whether the person can actually sign in.
          </p>
        </div>
        {institutionFilter ? (
          <button
            type="button"
            className="rk-button-secondary"
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete('institution_id');
              setParams(next, { replace: true });
            }}
          >
            Clear institution filter
          </button>
        ) : null}
      </div>

      {needsAttention > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <p className="font-semibold">
            {needsAttention} account{needsAttention === 1 ? '' : 's'} need attention
          </p>
          <p className="mt-1 text-xs">
            An expired setup link on an account that never signed in usually means the WhatsApp
            never arrived. Re-issue it and share the URL directly.
          </p>
        </div>
      ) : null}

      <AddLoginSection
        preselectId={institutionFilter}
        onIssued={(next) => {
          setIssued(next);
          setActionNote(null);
          setActionError(null);
        }}
        onDone={refresh}
      />

      {/* State pills. Counts are over the whole directory, not the current
          filter, so the numbers stay meaningful while drilled in. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={pillCls(state === '')}
          onClick={() => setState('')}
        >
          All {listQ.data ? `(${sum(counts)})` : ''}
        </button>
        {ATTENTION_STATES.concat(['never_signed_in', 'active', 'deactivated']).map((s) => (
          <button
            key={s}
            type="button"
            className={pillCls(state === s)}
            onClick={() => setState(state === s ? '' : s)}
            title={STATE_META[s]?.hint}
          >
            {STATE_META[s]?.label || s} {counts[s] != null ? `(${counts[s]})` : ''}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="rk-label" htmlFor="iu-role">
            Role
          </label>
          <select
            id="iu-role"
            className="rk-input"
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            {ROLE_FILTERS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[16rem] flex-1">
          <label className="rk-label" htmlFor="iu-q">
            Search
          </label>
          <input
            id="iu-q"
            className="rk-input"
            placeholder="username, institution name or shortname"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>

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

      {actionNote ? <p className="text-sm text-green-700">✓ {actionNote}</p> : null}
      {actionError ? (
        <p className="text-sm text-rk-700">✗ {institutionErrorText(actionError)}</p>
      ) : null}

      {listQ.isLoading ? <div className="rk-card">Loading…</div> : null}
      {listQ.error ? (
        <div className="rk-card border border-rk-700/30 bg-rk-700/5 text-rk-700">
          {listQ.error?.response?.data?.error || 'load_failed'}
        </div>
      ) : null}

      {listQ.data ? (
        <>
          <p className="text-xs text-slate-500">
            Showing {users.length} of {listQ.data.total} matching account
            {listQ.data.total === 1 ? '' : 's'}.
          </p>
          <StaffRosterTable
            users={users}
            canManage
            busyId={busyId}
            showInstitution
            showReset2fa
            onAction={onAction}
          />
        </>
      ) : null}

      {pending ? (
        <ReasonDialog
          title={
            pending.kind === 'deactivate'
              ? `Deactivate ${pending.user.username}`
              : pending.user.is_institution_admin
                ? `Remove admin rights from ${pending.user.username}`
                : `Make ${pending.user.username} an admin`
          }
          description={
            pending.kind === 'deactivate'
              ? `They will no longer be able to sign in at ${pending.user.institution_display_name || 'this institution'}. Nothing they recorded is removed — their name stays on every donation and screening they entered, which is why this retires the login rather than deleting it.`
              : pending.user.is_institution_admin
                ? 'They keep their login but can no longer invite colleagues, re-issue sign-in links or retire accounts at their institution.'
                : 'They will be able to invite colleagues, re-issue sign-in links and retire accounts at their institution.'
          }
          actionLabel={pending.kind === 'deactivate' ? 'Deactivate login' : 'Save'}
          tone={pending.kind === 'deactivate' ? 'danger' : 'primary'}
          busy={act.isPending}
          error={actionError}
          onCancel={() => {
            setPending(null);
            setActionError(null);
          }}
          onSubmit={(reason) => {
            setBusyId(pending.user.id);
            const body =
              pending.kind === 'admin-flag'
                ? { reason, is_institution_admin: !pending.user.is_institution_admin }
                : { reason };
            act.mutate(
              { kind: pending.kind, user: pending.user, body },
              { onSuccess: () => setPending(null) },
            );
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Add a staff login to a chosen institution.
 *
 * Only active institutions are offered. POST /institutions/:id/users refuses
 * anything else with 409 institution_not_active — a login for a pending or
 * archived institution is rejected at sign-in anyway, so listing one here would
 * only be a dead end. Hospitals and blood banks only: ROLE_FOR_KIND in
 * routes/institutions.js maps HO and BB to a staff role and nothing else does,
 * and a DHO carries no institution row at all.
 *
 * Kept collapsed until an institution is picked so the directory — whose job is
 * "is anyone stuck?" — does not open on a form.
 */
function AddLoginSection({ preselectId, onIssued, onDone }) {
  const listQ = useQuery({
    queryKey: ['admin', 'institutions', 'active-for-invite'],
    queryFn: () => apiRequest('GET', '/institutions?status=AC'),
    staleTime: 60_000,
  });

  const options = (listQ.data?.institutions || []).filter((i) => i.kind === 'HO' || i.kind === 'BB');
  const [target, setTarget] = useState('');

  // Follow the deep link (OnboardingDetail arrives with ?institution_id=…), but
  // only once the list has loaded and only if that institution can take a login.
  const preselectable = preselectId && options.some((i) => i.id === preselectId);
  const chosen = target || (preselectable ? preselectId : '');
  const chosenInst = options.find((i) => i.id === chosen) || null;

  return (
    <section className="space-y-2 rounded-md border border-stone-200 bg-white p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[18rem] flex-1">
          <label className="rk-label" htmlFor="iu-invite-inst">
            Add a login to
          </label>
          <select
            id="iu-invite-inst"
            className="rk-input"
            value={chosen}
            onChange={(e) => setTarget(e.target.value)}
            disabled={listQ.isLoading || options.length === 0}
          >
            <option value="">
              {listQ.isLoading ? 'Loading institutions…' : 'Choose a hospital or blood bank…'}
            </option>
            {options.map((i) => (
              <option key={i.id} value={i.id}>
                {i.display_name || i.legal_name} — @{i.shortname}
                {i.kind === 'BB' ? ' (blood bank)' : ''}
              </option>
            ))}
          </select>
        </div>
        {chosenInst ? (
          <Link
            to={`/admin/institutions/${chosenInst.id}`}
            className="pb-2 text-xs text-rk-700 hover:underline"
          >
            open its record →
          </Link>
        ) : null}
      </div>

      {preselectId && !preselectable && !listQ.isLoading ? (
        <p className="text-xs text-amber-700">
          The institution this page was opened for is not active, so it cannot take a new login yet.
          Activate it from Onboarding first.
        </p>
      ) : null}

      {listQ.error ? (
        <p className="text-xs text-rk-700">
          {institutionErrorText(listQ.error?.response?.data?.error || 'load_failed')}
        </p>
      ) : null}

      {chosen ? (
        // Keyed so switching institution clears a half-typed mobile rather than
        // carrying it to the wrong hospital.
        <InviteForm
          key={chosen}
          institutionId={chosen}
          onIssued={onIssued}
          onDone={onDone}
          defaultOpen
        />
      ) : (
        <p className="text-xs text-slate-500">
          Normally an institution's own admin invites their colleagues from their Team tab. Do it
          here when they have nobody able to sign in yet.
        </p>
      )}
    </section>
  );
}

function pillCls(active) {
  return (
    'rounded-full border px-3 py-1 text-sm font-medium ' +
    (active
      ? 'border-rk-700 bg-rk-50 text-rk-900'
      : 'border-slate-300 text-slate-600 hover:bg-slate-50')
  );
}

function sum(counts) {
  return Object.values(counts).reduce((a, b) => a + (b || 0), 0);
}
