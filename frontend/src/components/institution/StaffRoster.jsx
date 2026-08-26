/**
 * The staff roster table, shared by both surfaces that list institution logins:
 *
 *   pages/admin/InstitutionUsersTab.jsx   NGO admin, every institution
 *   components/institution/TeamPanel.jsx  a hospital / blood bank, its own team
 *
 * Both read the same `credential_state` computed by
 * backend/src/services/users/directory.js, so the meaning of a badge is defined
 * once on each side of the wire. Actions are raised to the caller via onAction —
 * the two surfaces post to the same endpoints but differ in what they do with
 * the result (the NGO tab also offers a 2FA reset, which is admin-only).
 */

/**
 * One entry per state in CREDENTIAL_STATES. `hint` is the operator-facing
 * "so what?" — the reason this screen exists is that `setup_expired` on an
 * account that never signed in is the fingerprint of a silently-failed
 * SETUP_LINK send, and nothing else on the platform surfaces that.
 */
export const STATE_META = {
  deactivated: {
    label: 'Deactivated',
    cls: 'bg-slate-200 text-slate-700',
    hint: 'Retired. Sign-in is refused. Reactivate, then re-issue a setup link.',
  },
  locked: {
    label: 'Locked',
    cls: 'bg-rk-100 text-rk-900',
    hint: 'Too many failed sign-ins. Unlock, or wait for the lockout to lapse.',
  },
  setup_expired: {
    label: 'Setup link expired',
    cls: 'bg-rk-100 text-rk-900',
    hint: 'A link was sent and never used before it lapsed. Re-issue it.',
  },
  setup_pending: {
    label: 'Setup pending',
    cls: 'bg-amber-100 text-amber-900',
    hint: 'A live link is outstanding and no password is set yet. Re-issue if it was lost.',
  },
  never_signed_in: {
    label: 'Never signed in',
    cls: 'bg-amber-100 text-amber-900',
    hint: 'Password is set but the account has never been used.',
  },
  active: {
    label: 'Active',
    cls: 'bg-green-100 text-green-800',
    hint: 'Has signed in and nothing is blocking.',
  },
};

/** States an operator should act on, in the order they should be dealt with. */
export const ATTENTION_STATES = ['locked', 'setup_expired', 'setup_pending'];

export function StaffStateBadge({ state }) {
  const meta = STATE_META[state] || { label: state, cls: 'bg-slate-100 text-slate-700', hint: '' };
  return (
    <span
      className={'rounded-full px-2 py-0.5 text-xs font-medium ' + meta.cls}
      title={meta.hint}
    >
      {meta.label}
    </span>
  );
}

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

function ActionButton({ children, onClick, disabled, tone = 'plain' }) {
  const cls =
    tone === 'danger'
      ? 'border-rk-300 text-rk-800 hover:bg-rk-50'
      : 'border-slate-300 text-slate-700 hover:bg-slate-50';
  return (
    <button
      type="button"
      className={
        'rounded border bg-white px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ' +
        cls
      }
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * @param {object}   p
 * @param {object[]} p.users        Rows from either roster endpoint.
 * @param {boolean}  p.canManage    False renders read-only (a technician viewing
 *                                  their own team, per can_manage from the API).
 * @param {string}   [p.selfUserId] Hides self-destructive actions.
 * @param {string}   [p.busyId]     Row with a mutation in flight.
 * @param {boolean}  [p.showInstitution] Adds the institution column (NGO view).
 * @param {boolean}  [p.showReset2fa]    Adds the admin-only 2FA reset.
 * @param {(kind: string, user: object) => void} p.onAction
 */
export function StaffRosterTable({
  users,
  canManage,
  selfUserId,
  busyId,
  showInstitution = false,
  showReset2fa = false,
  onAction,
}) {
  if (!users?.length) {
    return (
      <div className="rk-card text-sm text-slate-600">
        No staff accounts yet. Invite the first one above.
      </div>
    );
  }

  return (
    <div className="rk-card overflow-x-auto p-0">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2">User</th>
            {showInstitution ? <th className="px-3 py-2">Institution</th> : null}
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">2FA</th>
            <th className="px-3 py-2">Last sign-in</th>
            {canManage ? <th className="px-3 py-2">Actions</th> : null}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {users.map((u) => {
            const busy = busyId === u.id;
            const isSelf = selfUserId && u.id === selfUserId;
            // DHO logins have no institution row, so the institution-scoped
            // action endpoints have nowhere to address. They are listed for
            // visibility (a DHO whose link never arrived is the same problem)
            // but acted on through the staff-security screen instead.
            const actionable = Boolean(u.institution_id);
            return (
              <tr key={u.id} className={u.deactivated_at ? 'bg-slate-50/60' : undefined}>
                <td className="px-3 py-2">
                  <div className="font-mono font-medium text-slate-900">{u.username}</div>
                  <div className="text-xs text-slate-500">
                    {u.is_institution_admin ? (
                      <span className="mr-1 rounded bg-rk-50 px-1 py-0.5 font-medium text-rk-800">
                        admin
                      </span>
                    ) : null}
                    {u.mobile_masked || (u.has_mobile ? '—' : 'no mobile on file')}
                    {isSelf ? <span className="ml-1 text-slate-400">(you)</span> : null}
                  </div>
                </td>
                {showInstitution ? (
                  <td className="px-3 py-2">
                    <div className="text-slate-900">{u.institution_display_name || '—'}</div>
                    <div className="font-mono text-xs text-slate-500">
                      {u.institution_shortname ? `@${u.institution_shortname}` : u.role}
                      {u.institution_onboarding_status &&
                      u.institution_onboarding_status !== 'AC' ? (
                        <span className="ml-1 text-amber-700">
                          ({u.institution_onboarding_status})
                        </span>
                      ) : null}
                    </div>
                  </td>
                ) : null}
                <td className="px-3 py-2">
                  <StaffStateBadge state={u.credential_state} />
                  {u.deactivation_reason ? (
                    <div className="mt-1 max-w-xs text-xs text-slate-500">
                      {u.deactivation_reason}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-xs">
                  {u.totp_enabled ? (
                    <span className="text-green-700">✓ enrolled</span>
                  ) : (
                    <span className="text-slate-500">not enrolled</span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs text-slate-600">
                  {fmtDateTime(u.last_login_at)}
                </td>
                {canManage ? (
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1.5">
                      {u.deactivated_at ? (
                        <ActionButton
                          onClick={() => onAction('reactivate', u)}
                          disabled={busy || !actionable}
                        >
                          Reactivate
                        </ActionButton>
                      ) : (
                        <>
                          <ActionButton
                            onClick={() => onAction('reissue', u)}
                            disabled={busy || !actionable}
                          >
                            Re-issue setup link
                          </ActionButton>
                          {u.credential_state === 'locked' ? (
                            <ActionButton
                              onClick={() => onAction('unlock', u)}
                              disabled={busy || !actionable}
                            >
                              Unlock
                            </ActionButton>
                          ) : null}
                          {showReset2fa && u.totp_enabled ? (
                            <ActionButton onClick={() => onAction('reset2fa', u)} disabled={busy}>
                              Reset 2FA
                            </ActionButton>
                          ) : null}
                          <ActionButton
                            tone="danger"
                            onClick={() => onAction('deactivate', u)}
                            disabled={busy || isSelf || !actionable}
                          >
                            Deactivate
                          </ActionButton>
                        </>
                      )}
                    </div>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
