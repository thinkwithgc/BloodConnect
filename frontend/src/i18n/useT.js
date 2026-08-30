import { useCallback, useEffect, useMemo, useState } from 'react';

import { useLangContext } from './LangProvider.jsx';
import { detectInitialLang, setLang as persistLang, SUPPORTED, tFor } from './strings.js';

// Fallback for anything rendered outside <LangProvider> (tests, a stray root).
// Language changes here reach only this component — which is exactly the bug
// LangProvider exists to fix, so the provider path is always the real one.
function useLocalLang() {
  const [lang, setLangState] = useState(() => {
    const initial = detectInitialLang();
    persistLang(initial);
    return initial;
  });

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useMemo(() => tFor(lang), [lang]);

  const setLang = useCallback((next) => {
    persistLang(next);
    setLangState(next);
  }, []);

  return { t, lang, setLang, supported: SUPPORTED };
}

export function useT() {
  const ctx = useLangContext();
  const local = useLocalLang();
  return ctx || local;
}
