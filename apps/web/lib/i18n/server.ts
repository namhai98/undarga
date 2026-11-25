import { cookies } from 'next/headers';
import { LOCALE_COOKIE, parseLocale } from './locale';
import { translate, type Vars } from './translate';

/** For Server Components: the same `t` as `useT()`, from the locale cookie. */
export async function getT(): Promise<(text: string, vars?: Vars) => string> {
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return (text, vars) => translate(locale, text, vars);
}
