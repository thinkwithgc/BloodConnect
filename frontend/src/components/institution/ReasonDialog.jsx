import { useEffect, useRef, useState } from 'react';

/**
 * The one modal for every action that demands a written justification.
 *
 * These actions replaced `window.prompt`, which was wrong for the job in three
 * ways: it cannot enforce the server's minimum length, it cannot tell the
 * operator that minimum exists, and it cannot say that what they type is written
 * to an append-only audit row under their own username. A retired blood bank or
 * a revoked staff login is answered months later by an inspection reading that
 * sentence, so the box has to say so while it is being typed.
 *
 * The server is the gate: `requireReason` (backend/src/middleware/auth.js)
 * re-checks the minimum and returns 400 reason_required / reason_too_short. This
 * component only makes the requirement visible before the round trip.
 *
 * Props
 *   title          heading, e.g. "Archive Irwin Hospital"
 *   description    what the action does, in plain words. Rendered above the box.
 *   consequence    optional stronger warning, shown in an amber panel.
 *   actionLabel    submit button text ("Archive institution")
 *   tone           'danger' for anything that removes access; default 'primary'
 *   minLength      server's minimum. 10 for most, 20 for archive.
 *   confirmPhrase  when set, the operator must also type this exact string
 *                  (the institution's shortname) before submit enables.
 *   busy / error   driven by the caller's mutation
 *   onSubmit(reason) / onCancel
 */
export function ReasonDialog({
  title,
  description,
  consequence,
  actionLabel = 'Confirm',
  tone = 'primary',
  minLength = 10,
  confirmPhrase,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const boxRef = useRef(null);

  useEffect(() => {
    boxRef.current?.focus();
  }, []);

  // Escape cancels — but never while the request is in flight, so a stray
  // keypress cannot leave the operator unsure whether the action went through.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const trimmed = reason.trim();
  const shortBy = minLength - trimmed.length;
  const reasonOk = trimmed.length >= minLength;
  const confirmOk = !confirmPhrase || confirm.trim() === confirmPhrase;
  const canSubmit = reasonOk && confirmOk && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <form
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-lg"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(trimmed);
        }}
      >
        <h3 className="text-lg font-semibold text-stone-900">{title}</h3>
        {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}

        {consequence ? (
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            {consequence}
          </p>
        ) : null}

        <div className="mt-4">
          <label className="rk-label" htmlFor="rd-reason">
            Reason for this change
          </label>
          <textarea
            id="rd-reason"
            ref={boxRef}
            className="rk-input"
            rows={3}
            maxLength={500}
            value={reason}
            disabled={busy}
            placeholder="e.g. Licence renewed — new certificate dated 12 Aug 2026 received by email from the hospital administrator."
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="mt-1 text-xs text-slate-500">
            Recorded permanently against your username and cannot be edited or removed
            afterwards. Write what a colleague reading this in a year would need to know —
            minimum {minLength} characters.
          </p>
          {trimmed.length > 0 && !reasonOk ? (
            <p className="mt-1 text-xs text-amber-700">
              {shortBy} more character{shortBy === 1 ? '' : 's'} needed.
            </p>
          ) : null}
        </div>

        {confirmPhrase ? (
          <div className="mt-3">
            <label className="rk-label" htmlFor="rd-confirm">
              Type <span className="font-mono text-rk-800">{confirmPhrase}</span> to confirm
            </label>
            <input
              id="rd-confirm"
              className="rk-input font-mono"
              autoComplete="off"
              value={confirm}
              disabled={busy}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-sm text-rk-700">✗ {institutionErrorText(error, { minLength })}</p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="rk-button-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            className={
              tone === 'danger'
                ? 'rk-button-secondary border-rk-700 text-rk-800 hover:bg-rk-50'
                : 'rk-button-primary'
            }
            disabled={!canSubmit}
          >
            {busy ? 'Working…' : actionLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * Server error codes for the institution-admin surface, in words an operator can
 * act on. Exported because the same codes come back outside a dialog too (the
 * details form, the roster actions) and there should be one place they are
 * translated. An unmapped code falls through verbatim rather than being swallowed
 * behind "something went wrong" — a raw code is still a lead.
 */
export function institutionErrorText(code, { minLength = 10 } = {}) {
  switch (code) {
    case 'reason_required':
      return 'A reason is required for this action.';
    case 'reason_too_short':
      return `The reason must be at least ${minLength} characters.`;
    case 'forbidden':
      return 'Your account is not permitted to do this.';
    case 'not_institution_admin':
      return 'Only an institution admin can manage staff logins.';
    // Three different failures that used to share one sentence. `not_found` and
    // `institution_not_found` come from a handler that looked for a row and did not
    // find it. `route_not_found` comes from the API's catch-all: the endpoint itself
    // is not there, which in practice means this tab is running against an older API
    // than it was built for — the two deploys leave from one push but not at one
    // speed. Telling that operator to go back to the register sent them looking for a
    // record that was never missing, so it now says what actually helps: reload.
    case 'route_not_found':
      return 'This page is newer than the server it just called. Reload the page (Ctrl+Shift+R) and try again — if it still fails after a minute, tell the NGO team.';
    case 'not_found':
      return 'That record is no longer at this address. Reload the list and re-open it.';
    case 'institution_not_found':
      return 'That institution is no longer on the register. Go back to the register and re-open it.';
    case 'load_failed':
      return 'Could not load this. Reload the page; if it keeps failing, tell the NGO team.';
    case 'invalid_input':
      return 'One of the values failed validation. Check the fields you changed.';

    // Lifecycle
    case 'institution_has_live_work':
      return 'Still has open blood requests or reserved/issued bags. Close or re-route them first — suspend the institution meanwhile if it must stop taking new work.';
    case 'already_archived':
      return 'Already archived.';
    case 'not_archived':
      return 'Not archived, so there is nothing to restore.';
    case 'not_found_or_already_suspended':
      return 'Already suspended.';
    case 'not_found_or_not_suspended':
      return 'Not suspended, so there is nothing to lift.';

    // Details form
    case 'licence_expiry_before_institution_created':
      return 'That expiry date is before this institution was onboarded, which the database refuses. Record the current certificate, not a lapsed one.';
    case 'blood_bank_requires_licence':
      return 'A blood bank must keep both a CDSCO licence number and its expiry date.';
    case 'no_fields_to_update':
      return 'Nothing was changed.';
    case 'check_violation':
      return 'The database refused this change because it breaks one of its safety rules, so nothing was saved. The rule is named below — send it to the NGO team if the change looks legitimate to you.';
    case 'district_not_in_state':
    case 'taluka_not_in_district':
    case 'village_not_in_taluka':
      return 'The location you picked does not sit inside the one above it. Re-pick from the top.';
    case 'unknown_state':
    case 'unknown_district':
    case 'unknown_taluka':
    case 'unknown_village':
      return 'That location is not in the reference data.';

    // Staff actions
    case 'mobile_already_in_staff_cluster':
      return 'That number already has a staff login. One number, one account — use a different number, or re-issue the setup link on the existing account.';
    case 'username_taken':
      return 'That username already exists. Choose a different suffix.';
    case 'invalid_mobile_format':
      return 'Not a valid Indian mobile: 10 digits starting 6, 7, 8 or 9 (with or without +91).';
    case 'no_mobile_on_file':
      return 'This login has no mobile number on file, so there is nowhere to send the setup link. Use “Edit contact” on this row to record one, then send the link.';

    // Contact details
    case 'email_already_in_use':
      return 'That email address is already on another login. Every login needs its own.';
    case 'invalid_email_format':
      return 'That does not look like an email address.';
    case 'nothing_to_update':
      return 'Nothing was changed — edit the mobile or the email before saving.';
    case 'not_found_or_not_deactivated':
      return 'Not deactivated, so there is nothing to restore.';
    case 'cannot_deactivate_self':
      return 'You cannot deactivate your own login.';
    case 'cannot_deactivate_last_institution_admin':
    case 'cannot_demote_last_institution_admin':
      return 'This is the only admin left. Promote someone else first, otherwise nobody can manage this institution.';
    case 'already_deactivated':
      return 'Already deactivated.';
    case 'already_admin':
      return 'They are already an admin.';
    case 'already_not_admin':
      return 'They are already not an admin.';
    case 'user_deactivated':
      return 'That login is retired, so its access cannot be changed. Re-activate it first.';
    case 'user_not_found':
      return 'That login is not at this institution any more — reload the roster.';
    case 'action_failed':
      return 'The action did not go through. Try again; if it keeps failing, note what you were doing and tell the NGO team.';
    case 'institution_not_active':
      return 'This institution is suspended or archived, so new logins cannot be issued.';

    default:
      return code;
  }
}
