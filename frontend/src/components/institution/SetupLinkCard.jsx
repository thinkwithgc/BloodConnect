import { useState } from 'react';

/**
 * A freshly-issued password-setup link, and what to do with it.
 *
 * The backend stores only SHA-256(token), so the plaintext URL in the response
 * that renders this card is the ONLY copy in existence. That is the whole reason
 * this component exists: when the WhatsApp send fails (the chokepoint returns
 * success:false without throwing if a WHATSAPP_TEMPLATE_* var is unset), this
 * card is the sole path from "institution activated" to "someone can sign in".
 *
 * Hidden behind a Reveal by default — an operator screen-sharing an onboarding
 * call should not broadcast a live credential — but never truncated, because a
 * partial URL cannot be re-derived from anywhere.
 *
 * Props mirror the API response keys so callers can spread a response directly:
 *   <SetupLinkCard label="Hospital admin" username={d.ho_admin_username}
 *                  url={d.ho_admin_setup_url} expiresAt={d.ho_setup_expires_at}
 *                  whatsappSent={d.whatsapp_sent} nextStep={d.next_step} />
 */
export function SetupLinkCard({
  label,
  username,
  url,
  expiresAt,
  whatsappSent,
  nextStep,
  // Some links are deliberately never WhatsApp'd (the paired blood-bank admin
  // is created with mobile = NULL — see services/onboarding/activate.js), so
  // "did not send" would be a false alarm rather than a problem to fix.
  deliveryNotAttempted = false,
}) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!url) return null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is blocked without a secure context or user gesture. Revealing
      // the URL leaves manual selection as the fallback, which still works.
      setShown(true);
    }
  }

  const failed = !deliveryNotAttempted && whatsappSent === false;

  return (
    <div
      className={
        'rounded-md border p-3 text-sm ' +
        (failed ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-sand/60')
      }
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-slate-900">{label}</p>
        {username ? (
          <p className="font-mono text-xs text-slate-600">
            username <span className="font-semibold text-slate-900">{username}</span>
          </p>
        ) : null}
      </div>

      {deliveryNotAttempted ? (
        <p className="mt-1 text-xs text-slate-600">
          Not sent by WhatsApp — share this link directly with the person who will use it.
        </p>
      ) : whatsappSent ? (
        <p className="mt-1 text-xs text-green-700">✓ Setup link sent over WhatsApp.</p>
      ) : (
        <p className="mt-1 text-xs font-medium text-amber-800">
          ⚠ WhatsApp did NOT send — share this URL out-of-band.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'Hide link' : 'Reveal link'}
        </button>
        <button
          type="button"
          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          onClick={copy}
        >
          {copied ? '✓ Copied' : 'Copy link'}
        </button>
        {expiresAt ? (
          <span className="text-xs text-slate-500">
            Expires {new Date(expiresAt).toLocaleString('en-IN')}
          </span>
        ) : null}
      </div>

      {shown ? (
        <p className="mt-2 break-all rounded bg-white p-2 font-mono text-[11px] text-slate-800">
          {url}
        </p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          Hidden. This is a live credential — reveal it only when you are ready to send it.
        </p>
      )}

      {nextStep ? <p className="mt-2 text-xs text-stone-600">{nextStep}</p> : null}

      <p className="mt-2 text-xs text-slate-500">
        Single-use. This is the only copy — if it is lost, re-issue from the users roster (which
        invalidates this one).
      </p>
    </div>
  );
}
