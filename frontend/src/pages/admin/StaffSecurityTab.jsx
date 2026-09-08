import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';
import { USERNAME_RE } from '../../lib/usernameRe.js';

// Admin recovery for staff 2FA. When a staff member loses or changes the phone
// that holds their authenticator, an admin clears their enrolment here — the
// account is unlocked and, on next login, routed back through 2FA setup.
export function StaffSecurityTab() {
  const [username, setUsername] = useState('');
  const [msg, setMsg] = useState('');

  const reset = useMutation({
    mutationFn: (u) => apiRequest('POST', '/auth/institutional/reset-2fa', { username: u }),
    onSuccess: (d) => setMsg(`✓ 2FA reset for ${d.username} (${d.role}). They re-enrol on next login.`),
    onError: (err) => setMsg('✗ ' + (err?.response?.data?.error || 'reset_failed')),
  });

  function submit(e) {
    e.preventDefault();
    setMsg('');
    const u = username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
      setMsg('✗ Enter a valid username.');
      return;
    }
    reset.mutate(u);
  }

  return (
    <section className="rk-card max-w-lg space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-rk-700">Reset staff 2FA</h2>
        <p className="mt-1 text-sm text-slate-600">
          Use this when a staff member gets a new phone and can&apos;t generate their authenticator
          code. It clears their 2FA and unlocks the account; their password is unchanged. They set
          up a new authenticator the next time they log in.
        </p>
      </div>
      <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit}>
        <div className="flex-1">
          <label className="rk-label" htmlFor="reset-2fa-user">
            Staff username
          </label>
          <input
            id="reset-2fa-user"
            className="rk-input lowercase"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="e.g. irwin_admin"
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
        </div>
        <button type="submit" className="rk-button-primary shrink-0" disabled={reset.isPending}>
          {reset.isPending ? '…' : 'Reset 2FA'}
        </button>
      </form>
      {msg ? (
        <p className={'text-sm ' + (msg.startsWith('✓') ? 'text-green-700' : 'text-rk-700')}>
          {msg}
        </p>
      ) : null}
    </section>
  );
}
