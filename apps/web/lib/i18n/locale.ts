/** The languages the interface speaks. Mongolian first: it is the home market. */
export const LOCALES = ['mn', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'mn';

/** Read on the server (root layout) and written by the language switcher. */
export const LOCALE_COOKIE = 'undarga_locale';

export function parseLocale(value: string | undefined | null): Locale {
  return LOCALES.includes(value as Locale) ? (value as Locale) : DEFAULT_LOCALE;
}

export const LOCALE_NAMES: Record<Locale, string> = { mn: 'Монгол', en: 'English' };
