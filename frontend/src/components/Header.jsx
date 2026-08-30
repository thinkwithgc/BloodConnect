import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { useT } from '../i18n/useT.js';
import { LANG_LABELS } from '../i18n/strings.js';
import { Wordmark } from './Wordmark.jsx';

export function Header({ subtitle }) {
  const { t, lang, setLang, supported } = useT();
  const { isAuthenticated, logout } = useAuth();

  return (
    <header className="border-b border-rk-100 bg-white">
      <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
        <Link to="/" className="flex items-center gap-2.5">
          <Wordmark className="text-xl" />
          {subtitle ? (
            <span className="border-l border-stone-200 pl-2.5 text-xs text-stone-500">
              {subtitle}
            </span>
          ) : null}
        </Link>
        <div className="flex items-center gap-2">
          <select
            aria-label={t('lp_nav_lang_label')}
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-sm"
          >
            {supported.map((l) => (
              <option key={l} value={l}>
                {LANG_LABELS[l] || l.toUpperCase()}
              </option>
            ))}
          </select>
          {isAuthenticated ? (
            <button type="button" onClick={logout} className="rk-button-secondary text-sm">
              {t('logout')}
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
