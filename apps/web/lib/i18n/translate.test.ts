import { describe, expect, it } from 'vitest';
import { parseLocale } from './locale';
import { mn } from './mn';
import { plainT, translate } from './translate';

const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');

describe('translate', () => {
  it('returns the English sentence for en, with placeholders filled', () => {
    expect(translate('en', 'Hello, {firstName}', { firstName: 'Bat' })).toBe('Hello, Bat');
    expect(plainT('{from}–{to} of {total}', { from: 1, to: 20, total: 45 })).toBe('1–20 of 45');
  });

  it('uses the Mongolian sentence for mn', () => {
    expect(translate('mn', 'Save roles')).toBe('Үүрэг хадгалах');
    expect(translate('mn', 'Hello, {firstName}', { firstName: 'Бат' })).toBe('Сайн байна уу, Бат');
  });

  it('falls back to English for a sentence with no translation', () => {
    expect(translate('mn', 'A sentence nobody translated')).toBe('A sentence nobody translated');
  });

  it('leaves an unknown placeholder visible rather than blank', () => {
    expect(translate('en', 'Hi {name}', {})).toBe('Hi {name}');
  });

  it('keeps every placeholder of the English key in its Mongolian sentence', () => {
    const broken = Object.entries(mn).filter(
      ([en, mnText]) => placeholders(en) !== placeholders(mnText),
    );
    expect(broken).toEqual([]);
  });

  it('defaults an unknown or missing cookie to Mongolian', () => {
    expect(parseLocale(undefined)).toBe('mn');
    expect(parseLocale('fr')).toBe('mn');
    expect(parseLocale('en')).toBe('en');
  });
});
