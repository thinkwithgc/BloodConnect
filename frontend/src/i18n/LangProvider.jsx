// One language state for the whole app.
//
// Before this existed, useT() held its own useState at every call site, so
// setLang() in <Header/> re-rendered Header and nothing else — every other
// component kept the stale language until it happened to remount. That was
// invisible while almost nothing was translated; it is fatal once a whole
// form is.
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import { detectInitialLang, setLang as persistLang, SUPPORTED, tFor } from './strings.js';

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(() => {
    const initial = detectInitialLang();
    persistLang(initial);
    return initial;
  });

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const value = useMemo(
    () => ({
      lang,
      supported: SUPPORTED,
      t: tFor(lang),
      setLang: (next) => {
        persistLang(next);
        setLangState(next);
      },
    }),
    [lang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLangContext() {
  return useContext(LangContext);
}
