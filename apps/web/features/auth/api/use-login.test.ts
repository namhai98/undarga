import { describe, expect, it } from 'vitest';
import { destinationFor, isSafeReturnPath } from './use-login';

describe('isSafeReturnPath', () => {
  /**
   * `?next=` comes from the URL and is therefore attacker-controlled.
   *
   * Without this check, `/login?next=https://evil.example` turns the login
   * screen into an open redirect — a credible phishing primitive precisely
   * because the first hop is a domain the victim already trusts, and because
   * they arrive at the attacker's page having just typed a password.
   */
  it.each([
    ['/dashboard', true],
    ['/settings/members', true],
    ['/dashboard?tab=1', true],
    // Absolute URLs, in every disguise.
    ['https://evil.example', false],
    ['http://evil.example', false],
    // Protocol-relative: browsers treat this as absolute.
    ['//evil.example', false],
    ['///evil.example', false],
    ['javascript:alert(1)', false],
    ['dashboard', false],
    ['', false],
  ])('%s -> %s', (path, expected) => {
    expect(isSafeReturnPath(path)).toBe(expected);
  });
});

describe('destinationFor', () => {
  const membership = (id: string) => ({ companyId: id });

  it('explains rather than dumping a companyless user into the app', () => {
    expect(destinationFor({ memberships: [] })).toBe('/no-company');
  });

  it('sends a single-company user straight in', () => {
    expect(destinationFor({ memberships: [membership('c1')] })).toBe('/dashboard');
  });

  it('asks a multi-company user to choose', () => {
    // The API does pick a default, so this could be skipped. It should not be:
    // somebody who administers two salons and silently lands in whichever one
    // sorts first will edit the wrong one.
    expect(destinationFor({ memberships: [membership('c1'), membership('c2')] })).toBe(
      '/select-company',
    );
  });

  it('honours a safe return path', () => {
    expect(destinationFor({ memberships: [membership('c1')] }, '/settings/members')).toBe(
      '/settings/members',
    );
  });

  it('ignores an unsafe one', () => {
    expect(destinationFor({ memberships: [membership('c1')] }, 'https://evil.example')).toBe(
      '/dashboard',
    );
  });

  it('does not let a return path skip the company picker', () => {
    // Landing on a company-scoped page before choosing a company would resolve
    // against whichever one the API defaulted to.
    expect(
      destinationFor({ memberships: [membership('c1'), membership('c2')] }, '/dashboard'),
    ).toBe('/select-company');
  });
});
