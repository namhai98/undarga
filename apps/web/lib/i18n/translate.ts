import type { Locale } from './locale';
import { mn } from './mn';

export type Vars = Record<string, string | number | null | undefined>;

/** What `useT()` / `getT()` return; model helpers take one so they can speak either language. */
export type Translate = (text: string, vars?: Vars) => string;

/** English with placeholders filled — the default for helpers called without a `t`. */
export const plainT: Translate = (text, vars) => translate('en', text, vars);

/**
 * The interface is written in English, and the English sentence is the key:
 * `t('Save changes')`. A missing translation shows the English rather than a
 * key, so nothing is ever blank. `{name}` placeholders are filled from `vars`.
 */
export function translate(locale: Locale, text: string, vars?: Vars): string {
  const template = locale === 'mn' ? (mn[text] ?? text) : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key] ?? '') : match,
  );
}
