import { decimalToMinorString, minorToDecimalString } from '@undarga/shared';
import { describe, expect, it } from 'vitest';
import { currencyFormat } from './currency';

/**
 * The two halves of the money boundary.
 *
 * `@undarga/shared` has no test script of its own — its package.json says the
 * formatting is covered by the web unit tests, and this is where that happens.
 * The pairing matters more than either function: a price typed into a form and
 * read back out of the API must be the same number, and it is the round trip
 * that catches a disagreement about where the decimal point goes.
 */
describe('decimalToMinorString', () => {
  it.each([
    ['500', 2, '50000'],
    ['500.5', 2, '50050'],
    ['500.55', 2, '50055'],
    ['0', 2, '0'],
    ['0.01', 2, '1'],
    ['.5', 2, '50'],
    ['50000', 0, '50000'],
    ['1.234', 3, '1234'],
  ])('converts %s at %i places to %s', (input, minorUnit, expected) => {
    expect(decimalToMinorString(input, minorUnit)).toBe(expected);
  });

  it('does not round a value past 2^53', () => {
    // 90071992547409.91 in minor units is 9007199254740991 — one above what a
    // JS number holds exactly. `Number(v) * 100` gets this wrong; string
    // arithmetic does not.
    expect(decimalToMinorString('90071992547409.92', 2)).toBe('9007199254740992');
  });

  it.each([
    ['an empty box', '', 2],
    ['a lone minus', '-', 2],
    ['a thousands separator', '1,000', 2],
    ['two decimal points', '1.0.0', 2],
    ['letters', '50 MNT', 2],
    ['more places than the currency has', '1.005', 2],
    ['any decimals in a zero-decimal currency', '1.5', 0],
  ])('refuses %s rather than guessing', (_label, input, minorUnit) => {
    expect(decimalToMinorString(input, minorUnit)).toBeNull();
  });

  it('round-trips against minorToDecimalString', () => {
    for (const minor of ['0', '1', '99', '4500', '50000', '123456789012345']) {
      const decimal = minorToDecimalString(minor, 2);
      expect(decimalToMinorString(decimal, 2)).toBe(minor);
    }
  });
});

describe('currencyFormat', () => {
  it('knows the currencies with an exponent that is not 2', () => {
    expect(currencyFormat('JPY').minorUnit).toBe(0);
    expect(currencyFormat('KWD').minorUnit).toBe(3);
  });

  it('falls back to 2 for a currency it has not been told about', () => {
    // Wrong for a handful of currencies and right for most. The real fix is the
    // API serving `currency.minor_unit`, which `lib/currency.ts` says.
    expect(currencyFormat('ZZZ').minorUnit).toBe(2);
  });
});
