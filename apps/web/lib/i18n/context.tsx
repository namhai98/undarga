'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';
import type { Locale } from './locale';
import { translate, type Translate, type Vars } from './translate';

/**
 * English by default, so a component rendered without the provider — a unit
 * test — reads exactly as written. The app wraps everything in LocaleProvider
 * with the locale the server read from the cookie, so the server and the
 * browser render the same words and hydration matches.
 */
const LocaleContext = createContext<Locale>('en');

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** `const t = useT(); t('Save changes')`, `t('{count} people', { count })`. */
export function useT(): Translate {
  const locale = useContext(LocaleContext);
  return useCallback((text: string, vars?: Vars) => translate(locale, text, vars), [locale]);
}
