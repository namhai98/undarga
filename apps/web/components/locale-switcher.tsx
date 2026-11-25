'use client';

import { LOCALE_COOKIE, LOCALE_NAMES, LOCALES, useLocale, type Locale, useT } from '@/lib/i18n';

/**
 * Монгол / English. Stored in a cookie for a year; the page reloads so the
 * server renders the new language too.
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const t = useT();
  const locale = useLocale();

  const choose = (next: Locale) => {
    if (next === locale) return;
    saveLocale(next);
  };

  return (
    <div
      className={`flex items-center gap-1 text-xs ${className ?? ''}`}
      role="group"
      aria-label={t('Language')}
    >
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          onClick={() => choose(l)}
          className={
            l === locale
              ? 'text-foreground rounded px-1.5 py-0.5 font-semibold'
              : 'text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5'
          }
        >
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
}

/** Outside the component: writing a cookie is a side effect, not render state. */
function saveLocale(next: Locale) {
  document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  window.location.reload();
}
