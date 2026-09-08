import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';

import { apiRequest } from '../../lib/api.js';

/**
 * Invite one staff login into one institution.
 *
 * Shared deliberately. It is mounted by the institution's own Team tab (its
 * admin inviting a colleague) and by the NGO's Institution-staff-logins tab
 * (the NGO provisioning on their behalf), and both post to the same
 * POST /institutions/:id/users. A second copy would be two places to keep the
 * username rules and the "we never choose their password" promise correct.
 *
 * NO PASSWORD IS EVER TYPED BY THE INVITER. The endpoint mints a single-use
 * setup token and WhatsApps it; the URL comes back in the response so the
 * caller can pass it on by hand when the send fails silently — which it does
 * whenever a WHATSAPP_TEMPLATE_* env var is unset, because the notification
 * chokepoint returns success:false rather than throwing.
 *
 * @param {object} p
 * @param {string} p.institutionId  Target institution. Must be onboarding_status 'AC'.
 * @param {(issued: object) => void} p.onIssued  Receives the setup link to render once.
 * @param {() => void} p.onDone     Refetch the roster.
 * @param {boolean} [p.defaultOpen]  Start expanded. The Team tab starts collapsed
 *   (its job is the roster, not the form); the NGO tab passes true because picking
 *   the institution was already the deliberate step and a second click to reveal
 *   the fields reads like the action failed.
 */
export function InviteForm({ institutionId, onIssued, onDone, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
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
      setOpen(defaultOpen);
      onDone();
    },
  });

  // Mirrors username_suffix in the invite schema (routes/institutions.js) — the
  // full username is `<shortname>_<suffix>`, derived server-side. That derived
  // name is only PROVISIONAL now: the invitee renames over it at the magic-link
  // setup screen, so this field decides the SUGGESTION they see, not the name
  // they end up logging in with.
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
        They get a WhatsApp with a single-use link to choose their own username and password — you
        never pick either for them. If the WhatsApp does not send, the link is shown here once so
        you can pass it on.
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
              Only the username we suggest to them: your shortname + this, or “user” if you leave it
              blank. They can pick a different one when they claim the account.
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
          onClick={() => {
            setSuffix('');
            setMobile('');
            setIsAdmin(false);
            setOpen(defaultOpen);
          }}
          disabled={invite.isPending}
        >
          {defaultOpen ? 'Clear' : 'Cancel'}
        </button>
        <button type="submit" className="rk-button-primary" disabled={!canSubmit}>
          {invite.isPending ? 'Inviting…' : 'Send invite'}
        </button>
      </div>
    </form>
  );
}

export function inviteErrorText(code) {
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
