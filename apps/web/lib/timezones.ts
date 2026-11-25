/** IANA time zones this browser knows, with a short fallback list. */
export function timezoneOptions(): string[] {
  try {
    const zones = Intl.supportedValuesOf('timeZone');
    return zones.includes('UTC') ? zones : ['UTC', ...zones];
  } catch {
    return ['Asia/Ulaanbaatar', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York'];
  }
}

export function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Ulaanbaatar';
  } catch {
    return 'Asia/Ulaanbaatar';
  }
}
