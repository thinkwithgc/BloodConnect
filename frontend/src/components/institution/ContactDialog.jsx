import { useEffect, useRef, useState } from 'react';
import { institutionErrorText } from './ReasonDialog';

/**
 * Correct the mobile number and email on one staff login.
 *
 * This exists because the roster had no way to record a contact detail at all.
 * Every other action on a row re-issues a link, clears a lock, moves admin
 * rights or retires the account — so a login minted without a mobile (which is
 * how a paired in-house blood bank's admin was created before the apply form
 * asked for its own contact) landed in a state the UI could not leave: "send the
 * setup link" answered with "there is nowhere to send it", and nothing on the
 * screen could put a number on file.
 *
 * It is deliberately NOT part of "re-issue setup link". That action is the
 * recovery path — it blanks the password to an unusable placeholder and mints a
 * new token — so correcting a typo'd phone number through it would sign the
 * person out of a working account. This dialog touches nothing but the two
 * contact columns; POST /institutions/:id/users/:userId/contact is credential-
 * neutral for the same reason.
 *
 * No written reason is required. `deactivate` and `admin-flag` demand one
 * because they move authority; a phone number does not. The audit row is still
 * written (change_reason: 'correct staff contact details'), so the change is on
 * the record either way.
 *
 * Props
 *   user      a roster row: { username, email, mobile_masked, has_mobile,
 *             credential_state, last_login_at }
 *   busy      the caller's mutation is in flight
 *   error     server error code from that mutation
 *   onSubmit({ mobile, email, sendLink })
 *             mobile/email are omitted when unchanged, so the server's CASE
 *             leaves the other column alone. mobile is null when cleared.
 *             sendLink asks the caller to fire reissue-setup afterwards.
 *   onCancel
 */
export function ContactDialog({ user, busy = false, error = null, onSubmit, onCancel }) {
  const [mobile, setMobile] = useState('');
  const [clearMobile, setClearMobile] = useState(false);
  const [email, setEmail] = useState(user?.email || '');
  const [sendLink, setSendLink] = useState(false);
  const firstRef = useRef(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const mobileTrimmed = mobile.trim();
  // Same test as InviteForm, so the two ways a number can enter the system
  // accept exactly the same shapes. The server re-normalises regardless.
  const mobileOk = /^(\+91)?[6-9]\d{9}$/.test(mobileTrimmed.replace(/[\s-]/g, ''));
  const emailTrimmed = email.trim();
  const emailOk = emailTrimmed === '' || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailTrimmed);
  const emailChanged = emailTrimmed !== (user?.email || '');

  const willSetMobile = !clearMobile && mobileTrimmed !== '';
  const changed = willSetMobile || clearMobile || emailChanged;
  const canSubmit = changed && (!willSetMobile || mobileOk) && emailOk && !busy;

  // Offered only where it is the obvious next step: the account has never been
  // used, so a link is what it is waiting for. On a working login it would be a
  // trap — re-issuing blanks the password.
  const offerSend =
    !user?.last_login_at ||
    user?.credential_state === 'setup_expired' ||
    user?.credential_state === 'setup_pending';

  const submit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    const payload = {};
    if (clearMobile) payload.mobile = null;
    else if (mobileTrimmed !== '') payload.mobile = mobileTrimmed;
    if (emailChanged) payload.email = emailTrimmed === '' ? null : emailTrimmed;
    onSubmit({ ...payload, sendLink: sendLink && offerSend && willSetMobile });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Edit contact details"
    >
      <form
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-lg"
        onSubmit={submit}
      >
        <h3 className="text-lg font-semibold text-stone-900">Edit contact details</h3>
        <p className="mt-1 text-sm text-slate-600">
          For <span className="font-mono text-slate-900">{user?.username}</span>. This changes
          only where notifications and setup links are sent — it never changes the password, the
          2FA enrolment or what this login can do.
        </p>

        <div className="mt-4">
          <label className="rk-label" htmlFor="cd-mobile">
            Mobile number
          </label>
          <input
            id="cd-mobile"
            ref={firstRef}
            className="rk-input"
            inputMode="tel"
            autoComplete="off"
            placeholder="+919876543210"
            value={mobile}
            disabled={busy || clearMobile}
            onChange={(e) => setMobile(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            {user?.has_mobile
              ? `Currently ${user.mobile_masked}. Leave blank to keep it.`
              : 'Nothing on file. Setup links cannot be sent until a number is recorded.'}{' '}
            Needs to be a 10-digit Indian mobile starting 6-9.
          </p>
          {willSetMobile && !mobileOk ? (
            <p className="mt-1 text-xs text-amber-700">
              That does not look like a 10-digit Indian mobile.
            </p>
          ) : null}
          {user?.has_mobile ? (
            <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={clearMobile}
                disabled={busy}
                onChange={(e) => setClearMobile(e.target.checked)}
              />
              Remove the number instead of replacing it
            </label>
          ) : null}
        </div>

        <div className="mt-4">
          <label className="rk-label" htmlFor="cd-email">
            Email
          </label>
          <input
            id="cd-email"
            className="rk-input"
            type="email"
            autoComplete="off"
            placeholder="admin@hospital.example"
            value={email}
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Optional, and not a way in — staff sign in with the username above, so changing this
            cannot lock anyone out. Each login needs its own address.
          </p>
          {!emailOk ? (
            <p className="mt-1 text-xs text-amber-700">That does not look like an email address.</p>
          ) : null}
        </div>

        {offerSend ? (
          <label className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={sendLink}
              disabled={busy || !willSetMobile}
              onChange={(e) => setSendLink(e.target.checked)}
            />
            <span>
              Send the setup link to this number straight away.
              {willSetMobile
                ? ' A new link is issued and any earlier one stops working.'
                : ' Enter a number above to enable this.'}
            </span>
          </label>
        ) : null}

        {error ? <p className="mt-3 text-sm text-rk-700">✗ {institutionErrorText(error)}</p> : null}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rk-button-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="rk-button-primary" disabled={!canSubmit}>
            {busy ? 'Saving…' : 'Save contact details'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default ContactDialog;
