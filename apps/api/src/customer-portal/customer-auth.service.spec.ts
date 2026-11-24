import { SignInCodeInvalidError } from '../common/errors';
import { CustomerAuthService } from './customer-auth.service';

/**
 * The sign-in code's guess limit under concurrency. Parallel guesses all read
 * the same row, so the limit only holds if every write counts in the database
 * and every success is conditional on the row as it is at write time. Over
 * HTTP the race is too narrow to hit reliably; here the interleaving is forced.
 */
describe('CustomerAuthService.verify — guess limit', () => {
  const COMPANY = 'company-1';
  const live = {
    id: 'code-1',
    codeHash: 'hash',
    attempts: 0,
    consumedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
  };

  function build(opts: { matches: boolean; consumeCount?: number }) {
    const updateMany = jest.fn().mockResolvedValue({ count: opts.consumeCount ?? 1 });
    const tx = {
      company: { findFirstOrThrow: jest.fn().mockResolvedValue({ displayName: 'Salon' }) },
      companyCustomer: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cust-1',
          firstName: 'Saraa',
          lastName: null,
          email: 'saraa@example.com',
          customerIdentityId: 'ident-1',
        }),
      },
      customerLoginCode: { findFirst: jest.fn().mockResolvedValue(live), updateMany },
    };
    const db = { runInCompany: jest.fn((_id: string, fn: (t: typeof tx) => unknown) => fn(tx)) };
    const identities = { usable: jest.fn().mockResolvedValue(true) };
    const service = new CustomerAuthService(
      db as never,
      { findCompanyIdBySlug: jest.fn().mockResolvedValue(COMPANY) } as never,
      { authorizePublic: jest.fn().mockResolvedValue({}) } as never,
      identities as never,
      {} as never,
      { matches: jest.fn().mockReturnValue(opts.matches), hash: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      { recordForCompany: jest.fn() } as never,
    );
    return { service, updateMany, identities };
  }

  it('counts a wrong guess in the database, never from the value it read', async () => {
    const { service, updateMany } = build({ matches: false });
    await expect(service.verify('slug', 'saraa@example.com', '000000', {})).rejects.toBeInstanceOf(
      SignInCodeInvalidError,
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: live.id, companyId: COMPANY, consumedAt: null },
      data: { attempts: { increment: 1 } },
    });
    // The burn is decided by the stored count, too.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ attempts: { gte: 5 }, consumedAt: null }),
      }),
    );
  });

  it('refuses the right code when parallel guesses burnt it after it was read', async () => {
    // Read as live; by the time we write, five wrong guesses have used it up.
    const { service, updateMany, identities } = build({ matches: true, consumeCount: 0 });
    await expect(service.verify('slug', 'saraa@example.com', '123456', {})).rejects.toBeInstanceOf(
      SignInCodeInvalidError,
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: live.id, companyId: COMPANY, consumedAt: null, attempts: { lt: 5 } },
      data: { consumedAt: expect.any(Date) },
    });
    // No session was opened for it.
    expect(identities.usable).not.toHaveBeenCalled();
  });
});
