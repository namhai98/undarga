/**
 * Money formatting.
 *
 * Amounts cross the wire as STRINGS of minor units — `"5000000"`, not
 * `50000.00` and not the number `5000000`. A JS number holds integers exactly
 * only to 2^53, and minor units reach that sooner than it looks; rounding a
 * customer's balance is not an acceptable failure mode.
 *
 * Shared because the API decides the scale (`currency.minor_unit`) and the web
 * app renders it. If the two disagreed about where the decimal point goes,
 * every price on the site would be wrong by a factor of a hundred.
 *
 * Formatting only — no arithmetic. All money maths happens server-side, in the
 * domain layer, against a double-entry ledger.
 */

export interface Money {
  /** Integer minor units, as a string. */
  amountMinor: string;
  /** ISO 4217, e.g. "MNT". */
  currencyCode: string;
}

export interface CurrencyFormat {
  /** ISO 4217 exponent: 2 for MNT and USD, 0 for JPY, 3 for KWD. */
  minorUnit: number;
  symbol?: string;
}

/** Minor units to a major-unit decimal string. `("5000000", 2)` -> `"50000.00"`. */
export function minorToDecimalString(amountMinor: string, minorUnit: number): string {
  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).replace(/\D/g, '') || '0';

  if (minorUnit <= 0) return `${negative ? '-' : ''}${stripLeadingZeros(digits)}`;

  const padded = digits.padStart(minorUnit + 1, '0');
  const whole = stripLeadingZeros(padded.slice(0, -minorUnit));
  const fraction = padded.slice(-minorUnit);

  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * Localised display string.
 *
 * Goes through the decimal string rather than `Number(amountMinor)` so a large
 * amount is never silently rounded on its way to the screen.
 */
export function formatMoney(money: Money, format: CurrencyFormat, locale = 'en-US'): string {
  const decimal = minorToDecimalString(money.amountMinor, format.minorUnit);

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currencyCode,
      minimumFractionDigits: format.minorUnit,
      maximumFractionDigits: format.minorUnit,
    }).format(Number(decimal));
  } catch {
    // Unknown currency code, or an environment without full ICU data.
    const symbol = format.symbol ? `${format.symbol} ` : `${money.currencyCode} `;
    return `${symbol}${decimal}`;
  }
}

function stripLeadingZeros(value: string): string {
  const trimmed = value.replace(/^0+/, '');
  return trimmed === '' ? '0' : trimmed;
}

/**
 * The inverse: a typed decimal amount to minor units. `("500.5", 2)` -> `"50050"`.
 *
 * Lives here rather than in the form that needs it, because this and
 * `minorToDecimalString` must agree about where the decimal point goes. Two
 * copies in two packages is precisely how a price ends up wrong by a factor of
 * a hundred in one direction only.
 *
 * Returns `null` for anything that is not a plain amount — an empty box, a
 * thousands separator, a second decimal point, more decimal places than the
 * currency has. A caller shows a validation message; nothing here guesses.
 */
export function decimalToMinorString(value: string, minorUnit: number): string | null {
  const trimmed = value.trim();
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '-') return null;

  const negative = trimmed.startsWith('-');
  const [whole = '', fraction = ''] = (negative ? trimmed.slice(1) : trimmed).split('.');
  if (whole === '' && fraction === '') return null;
  if (fraction.length > minorUnit) return null;

  const digits = stripLeadingZeros(`${whole || '0'}${fraction.padEnd(minorUnit, '0')}`);
  return `${negative && digits !== '0' ? '-' : ''}${digits}`;
}
