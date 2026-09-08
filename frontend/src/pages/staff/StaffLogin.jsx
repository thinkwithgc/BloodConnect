import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';

import { Header } from '../../components/Header.jsx';
import { apiRequest } from '../../lib/api.js';
import { errorMessage } from '../../lib/errorMessage.js';
import { USERNAME_RE } from '../../lib/usernameRe.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { useT } from '../../i18n/useT.js';

const loginSchema = z.object({
  username: z.string().regex(USERNAME_RE),
  password: z.string().min(8),
  totp_code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});

export function StaffLogin() {
  const { t } = useT();
  const { setSession } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ username: '', password: '', totp_code: '' });
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  function update(k, v) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const payload = {
      username: form.username.trim().toLowerCase(),
      password: form.password,
      ...(form.totp_code ? { totp_code: form.totp_code } : {}),
    };
    const parsed = loginSchema.safeParse(payload);
    if (!parsed.success) {
      setError(
        'Enter both your username and password. Usernames are all lowercase, for example “irwin-hospital_admin”.',
      );
      return;
    }
    setPending(true);
    try {
      const r = await apiRequest('POST', '/auth/institutional/login', parsed.data);
      setSession(r);
      // No authenticator yet → the token we just stored is a restricted
      // enrolment token; send them to mandatory 2FA setup.
      if (r.totp_setup_required) {
        navigate('/staff/setup-2fa', { replace: true });
        return;
      }
      const dest =
        r.role === 'hospital'
          ? '/hospital'
          : r.role === 'blood_bank'
            ? '/bb'
            : r.role === 'ngo_admin' || r.role === 'super_admin'
              ? '/admin'
              : r.role === 'coordinator'
                ? '/coordinator'
                : r.role === 'dho'
                  ? '/dho'
                  : '/';
      navigate(dest, { replace: true });
    } catch (err) {
      if (err?.response?.data?.error === 'totp_required') setNeedTotp(true);
      setError(errorMessage(err, 'sign in'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-full">
      <Header />
      <main className="mx-auto max-w-md px-4 py-10">
        <form className="rk-card space-y-4" onSubmit={submit}>
          <div>
            <h1 className="text-xl font-semibold text-rk-700">{t('role_staff')}</h1>
            <p className="mt-1 text-sm text-slate-500">
              Sign in with your assigned username and password.
            </p>
          </div>

          <div>
            <label className="rk-label" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className="rk-input lowercase"
              value={form.username}
              onChange={(e) => update('username', e.target.value.toLowerCase())}
              required
              pattern={USERNAME_RE.source}
              placeholder="e.g. irwin_admin"
            />
          </div>

          <div>
            <label className="rk-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="rk-input"
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              required
              minLength={8}
            />
          </div>

          {needTotp ? (
            <div>
              <label className="rk-label" htmlFor="totp">
                Authenticator code
              </label>
              <input
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="rk-input tracking-[0.5em] text-center"
                value={form.totp_code}
                onChange={(e) => update('totp_code', e.target.value.replace(/\D/g, ''))}
              />
            </div>
          ) : null}

          <button type="submit" className="rk-button-primary w-full" disabled={pending}>
            {pending ? '…' : 'Sign in'}
          </button>

          {error ? <p className="text-sm text-rk-700">{error}</p> : null}

          <p className="border-t border-slate-100 pt-3 text-center text-xs text-slate-500">
            <Link to="/login" className="font-medium text-rk-700 hover:underline">
              {t('login_go_mobile')}
            </Link>
          </p>
        </form>
      </main>
    </div>
  );
}
