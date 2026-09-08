import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { Header } from '../../components/Header.jsx';
import { apiRequest } from '../../lib/api.js';
import { USERNAME_RE } from '../../lib/usernameRe.js';
import { useT } from '../../i18n/useT.js';

/**
 * Magic-link account setup for institutional staff.
 *
 * Lands here from the institutional_setup_link WhatsApp template:
 *   https://raktify.choudhari.ngo/setup/<token>
 *
 * Flow:
 *   1. Mount → GET /auth/setup/:token → fetches user/institution display info.
 *      404 = invalid token, 410 = expired or used (already consumed).
 *   2. User picks their USERNAME — pre-filled with the provisional
 *      `<shortname>_…` name the platform derived, which they may keep or
 *      replace — and sets a password.
 *   3. POST /auth/setup/:token → backend renames + sets the password atomically.
 *   4. Redirect to /staff/login with a success flash.
 *
 * A rejected username is a FIELD error, never a token error: the UPDATE that
 * would have burned the token is the same statement that failed, so the link
 * stays usable and the person simply tries another name. Which is why 409 /
 * 400 must not fall into the 410 / 404 branches below — those replace the
 * whole screen with a terminal ErrorCard.
 */

// The three tones the note under the username field can take. All three colours
// already appear in this file (the password rules use the first two); the design
// system is LOCKED, so no new token is introduced here.
const NOTE_TONE = {
  bad: 'text-rk-700',
  ok: 'text-emerald-700',
  muted: 'text-stone-500',
};
const NOTE_MARK = { bad: '✗ ', ok: '✓ ', muted: '' };

export function SetupPassword() {
  const { t } = useT();
  const { token } = useParams();
  const navigate = useNavigate();

  const [state, setState] = useState({ kind: 'loading' });
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // The username the person is choosing, and the provisional one the platform
  // derived. Both are needed: `seeded` is what "unchanged" means, and an
  // unchanged value is never sent, never checked, and always allowed.
  const [username, setUsername] = useState('');
  const [seeded, setSeeded] = useState('');
  // null | { checking: true } | { available, reason }
  const [avail, setAvail] = useState(null);
  // A server-side field rejection (username_taken / _reserved / _format).
  const [usernameError, setUsernameError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await apiRequest('GET', `/auth/setup/${encodeURIComponent(token)}`);
        if (!alive) return;
        setState({ kind: 'ready', data });
        // Pre-fill the provisional name as a SUGGESTION. It already embeds the
        // institution shortname, which is the institution hint — the person may
        // keep it or replace it with something they can actually remember.
        setUsername(data.username || '');
        setSeeded(data.username || '');
      } catch (err) {
        if (!alive) return;
        const status = err?.response?.status;
        const code = err?.response?.data?.error || 'unknown';
        if (status === 404) setState({ kind: 'invalid' });
        else if (status === 410) setState({ kind: code === 'used' ? 'used' : 'expired' });
        else setState({ kind: 'error', message: err?.message || 'unknown' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  const usernameNormalised = username.trim().toLowerCase();
  const usernameFormatOk = USERNAME_RE.test(usernameNormalised);
  const usernameUnchanged = usernameNormalised === seeded;
  // An unchanged name is the row's own current name — always allowed, never checked.
  const usernameOk = usernameUnchanged || (usernameFormatOk && avail?.available === true);

  useEffect(() => {
    // Nothing to check: the field still holds the row's own provisional name, or
    // the local regex already rejects it. Either way, no request — the debounced
    // field would otherwise burn the limiter on names the DB would refuse anyway.
    if (usernameUnchanged || !usernameFormatOk) {
      setAvail(null);
      return;
    }
    let alive = true;
    setAvail({ checking: true });
    const timer = setTimeout(async () => {
      try {
        const r = await apiRequest(
          'GET',
          `/auth/setup/${encodeURIComponent(token)}/username-available?u=${encodeURIComponent(usernameNormalised)}`,
        );
        if (alive) setAvail(r);
      } catch {
        // A failed check must never BLOCK the submit: the server re-validates on
        // POST and answers 409 with the token intact, so let it through silently.
        if (alive) setAvail({ available: true, reason: 'unverified' });
      }
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [token, usernameNormalised, usernameUnchanged, usernameFormatOk]);

  // One mutually-exclusive status line under the field, so it reads like the
  // password rules above it and never stacks two contradictions.
  let usernameNote = null;
  if (usernameError) usernameNote = { tone: 'bad', text: t(`setup_${usernameError}`) };
  else if (username.length > 0 && !usernameFormatOk)
    usernameNote = { tone: 'bad', text: t('setup_username_format') };
  else if (usernameUnchanged) usernameNote = null;
  else if (avail?.checking) usernameNote = { tone: 'muted', text: t('setup_username_checking') };
  else if (avail?.reason === 'taken') usernameNote = { tone: 'bad', text: t('setup_username_taken') };
  else if (avail?.reason === 'reserved')
    usernameNote = { tone: 'bad', text: t('setup_username_reserved') };
  else if (avail?.reason === 'ok')
    usernameNote = { tone: 'ok', text: t('setup_username_available') };

  // Client-side password validity. Backend re-validates with the same rules.
  const passwordIssues = [];
  if (pwd.length > 0) {
    if (pwd.length < 12) passwordIssues.push(t('setup_pwd_min'));
    if (!/[A-Za-z]/.test(pwd)) passwordIssues.push(t('setup_pwd_letter'));
    if (!/[0-9]/.test(pwd)) passwordIssues.push(t('setup_pwd_digit'));
  }
  const passwordMatches = pwd.length > 0 && pwd === confirm;
  const canSubmit =
    pwd.length >= 12 && passwordIssues.length === 0 && passwordMatches && usernameOk;

  async function onSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await apiRequest('POST', `/auth/setup/${encodeURIComponent(token)}`, {
        password: pwd,
        confirm_password: confirm,
        // Only when it actually changed. Absent = keep the provisional name,
        // which is exactly what a password reset through this same route does.
        ...(usernameUnchanged ? {} : { username: usernameNormalised }),
      });
      // Success — kick them to staff login with a flag the login page can show.
      navigate('/staff/login?setup=success');
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.response?.data?.error || 'unknown';
      // FIELD errors first. These must NOT reach the 410/404 branches, which
      // replace the whole screen — a rejected name leaves the link usable.
      if (status === 409 && (code === 'username_taken' || code === 'username_reserved')) {
        setUsernameError(code);
        setAvail({ available: false, reason: code === 'username_taken' ? 'taken' : 'reserved' });
      } else if (status === 400 && code === 'username_format') {
        setUsernameError(code);
      } else if (status === 410) setState({ kind: code === 'used' ? 'used' : 'expired' });
      else if (status === 404) setState({ kind: 'invalid' });
      else setSubmitError(code);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-full bg-cream font-sans text-stone-800">
      <Header subtitle={t('setup_subtitle')} />
      <main className="mx-auto max-w-md px-4 py-10">
        {state.kind === 'loading' && (
          <p className="text-stone-500">{t('setup_loading')}</p>
        )}

        {state.kind === 'invalid' && (
          <ErrorCard
            title={t('setup_invalid_title')}
            body={t('setup_invalid_body')}
          />
        )}
        {state.kind === 'expired' && (
          <ErrorCard
            title={t('setup_expired_title')}
            body={t('setup_expired_body')}
          />
        )}
        {state.kind === 'used' && (
          <ErrorCard
            title={t('setup_used_title')}
            body={t('setup_used_body')}
          />
        )}
        {state.kind === 'error' && (
          <ErrorCard
            title={t('setup_error_title')}
            body={`${t('setup_error_body')} (${state.message})`}
          />
        )}

        {state.kind === 'ready' && (
          <form onSubmit={onSubmit} className="space-y-5">
            <header className="space-y-1">
              <h1 className="text-xl font-semibold text-stone-900">
                {t('setup_welcome')}{state.data.signatory_name ? `, ${state.data.signatory_name}` : ''}
              </h1>
              <p className="text-sm text-stone-600">
                {t('setup_intro_for')}{' '}
                <strong className="text-stone-900">{state.data.institution_name}</strong>
              </p>
            </header>

            <label className="block">
              <span className="rk-label">{t('setup_username')}</span>
              <input
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value.toLowerCase());
                  setUsernameError(null);
                }}
                className="rk-input w-full lowercase"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                pattern={USERNAME_RE.source}
                required
              />
              <span className="mt-1.5 block text-xs text-stone-500">
                {t('setup_username_hint')}
              </span>
              {usernameUnchanged && username.length > 0 && (
                <span className="mt-1.5 block text-xs text-stone-500">
                  {t('setup_intro_username')}
                </span>
              )}
              {usernameNote && (
                <span className={`mt-1.5 block text-xs ${NOTE_TONE[usernameNote.tone]}`}>
                  {NOTE_MARK[usernameNote.tone]}
                  {usernameNote.text}
                </span>
              )}
            </label>

            <label className="block">
              <span className="rk-label">{t('setup_password')}</span>
              <input
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                className="rk-input w-full"
                autoComplete="new-password"
                minLength={12}
                required
              />
              {pwd.length > 0 && passwordIssues.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-xs text-rk-700">
                  {passwordIssues.map((issue, i) => (
                    <li key={i}>• {issue}</li>
                  ))}
                </ul>
              )}
              {pwd.length >= 12 && passwordIssues.length === 0 && (
                <span className="mt-1.5 block text-xs text-emerald-700">
                  ✓ {t('setup_pwd_ok')}
                </span>
              )}
            </label>

            <label className="block">
              <span className="rk-label">{t('setup_confirm')}</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="rk-input w-full"
                autoComplete="new-password"
                required
              />
              {confirm.length > 0 && !passwordMatches && (
                <span className="mt-1.5 block text-xs text-rk-700">
                  {t('setup_pwd_mismatch')}
                </span>
              )}
            </label>

            {submitError && (
              <p className="text-sm text-rk-700">
                {t('setup_submit_error')}: {submitError}
              </p>
            )}

            <button
              type="submit"
              disabled={!canSubmit || submitting}
              className="rk-btn rk-btn-primary w-full"
            >
              {submitting ? t('setup_submitting') : t('setup_submit')}
            </button>

            <p className="text-center text-xs text-stone-500">
              {t('setup_already_set')}{' '}
              <Link to="/staff/login" className="text-rk-700 underline">
                {t('setup_login_link')}
              </Link>
            </p>
          </form>
        )}
      </main>
    </div>
  );
}

function ErrorCard({ title, body }) {
  const { t } = useT();
  return (
    <div className="rounded-lg border border-rk-200 bg-rk-50 p-5">
      <h2 className="mb-1 text-base font-semibold text-rk-800">{title}</h2>
      <p className="text-sm text-stone-700">{body}</p>
      <p className="mt-3 text-xs text-stone-600">
        {t('setup_contact_admin')}
      </p>
      <Link
        to="/staff/login"
        className="mt-4 inline-block text-sm text-rk-700 underline"
      >
        {t('setup_back_to_login')}
      </Link>
    </div>
  );
}
