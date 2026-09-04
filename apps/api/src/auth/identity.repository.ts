import { Injectable } from '@nestjs/common';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * The only file in the auth module that touches the privileged connection.
 *
 * ---------------------------------------------------------------------------
 * WHY AUTHENTICATION CANNOT BE TENANT-SCOPED
 * ---------------------------------------------------------------------------
 *
 * `user_account`, `user_session` and `platform_session` carry no `company_id`,
 * and they must be readable *before* a company is known — looking up a user by
 * email is what identifies the caller in the first place. RLS on those tables
 * denies the tenant connection outright (001_hardening.sql 8d), precisely so
 * that nothing inside a tenant request can read a credential.
 *
 * That leaves authentication needing its own connection, which is this file.
 * The containment is the same shape as TenantDirectoryService:
 *
 *   - It is allowlisted in .eslintrc.js by exact path, not by directory.
 *   - Every query filters by a primary key or a unique credential the caller
 *     already presented. There is no method that lists or searches users.
 *   - It returns credential material to the auth service and nothing else; no
 *     business data is reachable from here.
 *
 * Adding a method to this class is a security review, not a refactor.
 */
@Injectable()
export class IdentityRepository {
  constructor(private readonly prisma: PlatformPrismaService) {}

  // -------------------------------------------------------------------------
  // Staff realm
  // -------------------------------------------------------------------------

  async findStaffByEmail(email: string) {
    return this.prisma.userAccount.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        passwordHash: true,
        status: true,
        lockedUntil: true,
        failedLoginCount: true,
      },
    });
  }

  async findStaffById(userAccountId: string) {
    return this.prisma.userAccount.findFirst({
      where: { id: userAccountId, deletedAt: null },
      select: { id: true, email: true, fullName: true, status: true },
    });
  }

  async recordStaffLoginSuccess(userAccountId: string): Promise<void> {
    await this.prisma.userAccount.update({
      where: { id: userAccountId },
      data: { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
    });
  }

  /**
   * Count a failed attempt and lock the account after a threshold.
   *
   * Lockout is per account rather than per IP because the credential is what is
   * being attacked. It is a blunt instrument — an attacker can lock a known
   * account out — so the window is short and it is a stopgap until per-IP rate
   * limiting lands at the edge.
   */
  async recordStaffLoginFailure(userAccountId: string, threshold = 10): Promise<void> {
    const updated = await this.prisma.userAccount.update({
      where: { id: userAccountId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });

    if (updated.failedLoginCount >= threshold) {
      await this.prisma.userAccount.update({
        where: { id: userAccountId },
        data: { lockedUntil: new Date(Date.now() + 15 * 60_000), failedLoginCount: 0 },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Account creation — invitation and provisioning paths
  // -------------------------------------------------------------------------

  /**
   * What the invitation-accept path is allowed to learn about an address.
   *
   * Deliberately narrower than `findStaffByEmail`: that method returns the
   * password hash, and accept is reachable from a PUBLIC route. Pulling a
   * credential into a public code path is how it ends up in a log line or an
   * error payload. `hasPassword` is the only thing the flow actually needs —
   * enough to choose between "set a password" and "sign in first" — and it
   * cannot be turned back into the hash.
   *
   * Soft-deleted accounts are returned rather than filtered out, so the caller
   * can refuse them explicitly instead of silently creating a duplicate.
   */
  async findStaffAccountForInvite(email: string) {
    const account = await this.prisma.userAccount.findFirst({
      where: { email },
      select: { id: true, email: true, status: true, deletedAt: true, passwordHash: true },
    });

    if (!account) return null;

    const { passwordHash, ...rest } = account;
    return { ...rest, hasPassword: passwordHash !== null };
  }

  /**
   * Create a fully active staff account, used when someone accepts an
   * invitation for an address that has no account yet.
   *
   * `emailVerifiedAt` stays null on purpose. A link distributed by hand proves
   * nothing about who controls the address — only that whoever accepted had
   * the link. Verification is a separate flow and arrives with email in phase 6.
   */
  async createActiveStaffAccount(input: {
    email: string;
    fullName: string;
    passwordHash: string;
    locale?: string;
  }) {
    return this.prisma.userAccount.create({
      data: {
        email: input.email,
        fullName: input.fullName,
        passwordHash: input.passwordHash,
        locale: input.locale,
        status: 'ACTIVE',
      },
      select: { id: true, email: true, fullName: true, status: true },
    });
  }

  /**
   * Find or create the placeholder account a provisioned company's owner will
   * accept into.
   *
   * Created with no password and `INVITED` status: the account exists so the
   * invitation can point at a membership, but it cannot be signed into until
   * the owner accepts and sets a password. Idempotent by email, because the
   * owner of a new company may already be a member of another one — and
   * because it makes provisioning safe to retry.
   */
  async findOrCreateInvitedStaffAccount(input: { email: string; fullName: string }) {
    const existing = await this.prisma.userAccount.findFirst({
      where: { email: input.email, deletedAt: null },
      select: { id: true, email: true, fullName: true, status: true },
    });

    if (existing) return { account: existing, created: false };

    const account = await this.prisma.userAccount.create({
      data: { email: input.email, fullName: input.fullName, status: 'INVITED' },
      select: { id: true, email: true, fullName: true, status: true },
    });

    return { account, created: true };
  }

  // -------------------------------------------------------------------------
  // Staff sessions — family rotation with reuse detection
  // -------------------------------------------------------------------------

  async createStaffSession(input: {
    userAccountId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    activeCompanyId?: string | null;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.userSession.create({
      data: {
        userAccountId: input.userAccountId,
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        expiresAt: input.expiresAt,
        activeCompanyId: input.activeCompanyId ?? null,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 512),
      },
      select: { id: true, familyId: true },
    });
  }

  async findStaffSessionByHash(tokenHash: string) {
    return this.prisma.userSession.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userAccountId: true,
        familyId: true,
        replacedById: true,
        revokedAt: true,
        expiresAt: true,
        activeCompanyId: true,
      },
    });
  }

  async rotateStaffSession(input: {
    previousSessionId: string;
    userAccountId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    activeCompanyId?: string | null;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.userSession.create({
        data: {
          userAccountId: input.userAccountId,
          tokenHash: input.tokenHash,
          familyId: input.familyId,
          expiresAt: input.expiresAt,
          activeCompanyId: input.activeCompanyId ?? null,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent?.slice(0, 512),
        },
        select: { id: true },
      });

      await tx.userSession.update({
        where: { id: input.previousSessionId },
        data: { revokedAt: new Date(), replacedById: next.id },
      });

      return next;
    });
  }

  /**
   * Kill an entire session family.
   *
   * Called when an already-rotated refresh token is presented again. That means
   * either a benign race or a stolen token, and the two are indistinguishable
   * from here — so the whole family dies and the user signs in again. Losing a
   * session to a race is a minor annoyance; honouring a stolen token is not.
   */
  async revokeStaffSessionFamily(familyId: string): Promise<string[]> {
    const sessions = await this.prisma.userSession.findMany({
      where: { familyId, revokedAt: null },
      select: { id: true },
    });

    await this.prisma.userSession.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return sessions.map((s) => s.id);
  }

  async revokeStaffSession(sessionId: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // -------------------------------------------------------------------------
  // Platform realm
  // -------------------------------------------------------------------------

  async findPlatformUserByEmail(email: string) {
    return this.prisma.platformUser.findFirst({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        passwordHash: true,
        status: true,
        mfaEnrolledAt: true,
      },
    });
  }

  async createPlatformSession(input: {
    platformUserId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    ipAddress?: string;
    userAgent?: string;
  }) {
    return this.prisma.platformSession.create({
      data: {
        platformUserId: input.platformUserId,
        tokenHash: input.tokenHash,
        familyId: input.familyId,
        expiresAt: input.expiresAt,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent?.slice(0, 512),
      },
      select: { id: true },
    });
  }

  async revokePlatformSession(sessionId: string): Promise<void> {
    await this.prisma.platformSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async recordPlatformLogin(platformUserId: string): Promise<void> {
    await this.prisma.platformUser.update({
      where: { id: platformUserId },
      data: { lastLoginAt: new Date() },
    });
  }
}
