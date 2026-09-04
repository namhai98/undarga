import { AppConfig } from '../config';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { AuthService } from './auth.service';
import { IdentityRepository } from './identity.repository';
import { PasswordService } from './password.service';
import { SessionDenyList } from './session-deny-list';
import { TokenHashService } from './token-hash.service';
import { TokenService } from './token.service';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';

const memberships = [
  { companyId: COMPANY_A, companySlug: 'a', companyName: 'A', isOwner: true, companyUserId: 'cu-a' },
  {
    companyId: COMPANY_B,
    companySlug: 'b',
    companyName: 'B',
    isOwner: false,
    companyUserId: 'cu-b',
  },
];

/**
 * Only the refresh path is covered here, and only the part that decides which
 * company the rotated token points at. Credential handling is exercised
 * end-to-end against a real database in test/identity.e2e-spec.ts, where it is
 * worth the setup cost; this branch is pure logic and is not.
 */
describe('AuthService.refreshStaff — active company', () => {
  let service: AuthService;
  let rotate: jest.Mock;
  let signStaffAccess: jest.Mock;
  let session: {
    id: string;
    userAccountId: string;
    familyId: string;
    replacedById: string | null;
    revokedAt: Date | null;
    expiresAt: Date;
    activeCompanyId: string | null;
  };

  beforeEach(() => {
    session = {
      id: 'session-1',
      userAccountId: 'user-1',
      familyId: 'family-1',
      replacedById: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      activeCompanyId: null,
    };

    rotate = jest.fn(async () => ({ id: 'session-2' }));
    signStaffAccess = jest.fn(() => 'access-token');

    const identity = {
      findStaffSessionByHash: async () => session,
      findStaffById: async () => ({
        id: 'user-1',
        email: 'u@example.com',
        fullName: 'U',
        status: 'ACTIVE',
      }),
      rotateStaffSession: rotate,
    } as unknown as IdentityRepository;

    const directory = {
      listMembershipsForUser: async () => memberships,
    } as unknown as TenantDirectoryService;

    service = new AuthService(
      identity,
      directory,
      {} as PasswordService,
      { signStaffAccess, accessTtlSeconds: 900 } as unknown as TokenService,
      {
        hash: (v: string) => `hash:${v}`,
        generate: () => 'next-refresh',
      } as unknown as TokenHashService,
      { revoke: jest.fn() } as unknown as SessionDenyList,
      { auth: { refreshTokenTtlDays: 30 } } as unknown as AppConfig,
    );
  });

  // The bug this replaces: refreshStaff took memberships[0] unconditionally, so
  // switching to company B and then letting the access token expire silently
  // moved the user back to company A. Invisible until a company switcher
  // existed in the UI, and then reported as "it keeps logging me into the wrong
  // company".
  it('keeps the company the session was switched to', async () => {
    session.activeCompanyId = COMPANY_B;

    const result = await service.refreshStaff('token');

    expect(result.activeCompanyId).toBe(COMPANY_B);
    expect(signStaffAccess).toHaveBeenCalledWith(expect.objectContaining({ companyUserId: 'cu-b' }));
    // And it must persist, or the next rotation loses it again.
    expect(rotate).toHaveBeenCalledWith(expect.objectContaining({ activeCompanyId: COMPANY_B }));
  });

  it('falls back to the default when the session names no company', async () => {
    const result = await service.refreshStaff('token');
    expect(result.activeCompanyId).toBe(COMPANY_A);
  });

  it('drops a remembered company the user is no longer a member of', async () => {
    // Membership revoked between rotations. The stored value is a hint, never
    // an authorization fact — it must not survive re-validation.
    session.activeCompanyId = '018f0000-0000-7000-8000-0000000000ff';

    const result = await service.refreshStaff('token');

    expect(result.activeCompanyId).toBe(COMPANY_A);
    expect(rotate).toHaveBeenCalledWith(expect.objectContaining({ activeCompanyId: COMPANY_A }));
  });
});
