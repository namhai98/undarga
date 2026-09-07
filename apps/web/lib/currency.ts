import type { CurrencyFormat } from '@undarga/shared';

/**
 * How many decimal places a currency has.
 *
 * ---------------------------------------------------------------------------
 * THIS BELONGS ON THE API AND IS NOT THERE YET
 * ---------------------------------------------------------------------------
 *
 * The `currency` table already stores `minor_unit`, which is the authority. No
 * endpoint serves it, so the browser has no way to ask — and `formatMoney`
 * cannot render an amount without knowing where the decimal point goes.
 *
 * The gap is filled here rather than by guessing 2 inline at each call site,
 * so there is one place to delete when the API exposes it. The table covers
 * every currency this product is sold in plus the exponents that are not 2 and
 * are commonly hit; anything unknown falls back to 2, which is right for the
 * overwhelming majority and wrong in a visible, reportable way rather than
 * silently.
 */
const MINOR_UNITS: Record<string, number> = {
  MNT: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  CNY: 2,
  RUB: 2,
  KRW: 0,
  JPY: 0,
  VND: 0,
  KWD: 3,
  BHD: 3,
};

const SYMBOLS: Record<string, string> = {
  MNT: '₮',
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
};

export function currencyFormat(currencyCode: string): CurrencyFormat {
  return {
    minorUnit: MINOR_UNITS[currencyCode] ?? 2,
    symbol: SYMBOLS[currencyCode],
  };
}
