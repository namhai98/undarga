import { base32Decode, base32Encode, matchTotp, otpauthUri, stepAt, totpCode } from './totp';

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B, SHA-1 seed "12345678901234567890", last six digits.
  const seed = Buffer.from('12345678901234567890');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('matches the RFC test vector at t=%i', (t, code) => {
    expect(totpCode(seed, Math.floor(t / 30))).toBe(code);
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from('hello, authenticator');
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('accepts one step of drift either way, and nothing further', () => {
    const secret = base32Encode(seed);
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(matchTotp(secret, totpCode(secret, step), now)).toBe(step);
    expect(matchTotp(secret, totpCode(secret, step - 1), now)).toBe(step - 1);
    expect(matchTotp(secret, totpCode(secret, step + 1), now)).toBe(step + 1);
    expect(matchTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
    expect(matchTotp(secret, 'abc123', now)).toBeNull();
  });

  it('builds an otpauth URI an app can read', () => {
    const uri = otpauthUri('Undarga', 'ops@example.com', 'JBSWY3DPEHPK3PXP');
    expect(uri).toBe(
      'otpauth://totp/Undarga%3Aops%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Undarga&algorithm=SHA1&digits=6&period=30',
    );
  });
});
