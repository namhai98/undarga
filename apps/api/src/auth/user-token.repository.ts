import { Injectable } from '@nestjs/common';
import type { UserTokenPurpose } from '@prisma/client';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * One-time account tokens: email verification and password reset.
 *
 * On the platform connection because `user_token` is closed to tenant
 * connections outright (001_hardening.sql 8d) and because both flows run before
 * any company is known — a password reset belongs to the person, not to
 * whichever company they happen to work in.
 *
 * It lives in `src/auth/`, which is not blanket-allowlisted for
 * PlatformPrismaService; the exact path is listed in
 * packages/eslint-config/nest.js alongside IdentityRepository, for the same
 * reason and under the same rule: adding a method here is a security review.
 */
@Injectable()
export class UserTokenRepository {
  constructor(private readonly prisma: PlatformPrismaService) {}

  /**
   * Issue a token, retiring any earlier live one for the same purpose.
   *
   * Retiring the old one is the point. Without it, clicking "resend" three
   * times leaves three working reset links, and revoking the visible one closes
   * nothing — the user believes there is one credential outstanding when there
   * are three.
   */
  async issue(input: {
    userAccountId: string;
    purpose: UserTokenPurpose;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.userToken.updateMany({
        where: {
          userAccountId: input.userAccountId,
          purpose: input.purpose,
          consumedAt: null,
        },
        // Marked consumed rather than deleted, so the audit trail keeps the
        // fact that a token existed and was superseded.
        data: { consumedAt: new Date() },
      });

      return tx.userToken.create({
        data: {
          userAccountId: input.userAccountId,
          purpose: input.purpose,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
    });
  }

  /**
   * Look a token up by hash. Takes the HASH, never the plaintext.
   *
   * Returns the account's status alongside, so the caller can refuse a
   * disabled or deleted account without a second query — and without the
   * caller needing a method that can look up accounts by anything else.
   */
  async findByTokenHash(tokenHash: string) {
    return this.prisma.userToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        userAccountId: true,
        purpose: true,
        expiresAt: true,
        consumedAt: true,
        userAccount: {
          select: { id: true, email: true, status: true, deletedAt: true },
        },
      },
    });
  }

  /**
   * Consume a token, atomically.
   *
   * A compare-and-swap on `consumed_at`: false means somebody else got there
   * first. That is what makes single use real rather than aspirational —
   * checking `consumedAt` in the service and then updating would leave a window
   * in which two concurrent requests both pass the check.
   */
  async consume(tokenId: string): Promise<boolean> {
    const { count } = await this.prisma.userToken.updateMany({
      where: { id: tokenId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    return count > 0;
  }

  /** Retire every live token of a purpose — used after a successful reset. */
  async consumeAllFor(userAccountId: string, purpose: UserTokenPurpose): Promise<void> {
    await this.prisma.userToken.updateMany({
      where: { userAccountId, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
  }

  /** How many live tokens exist, for the per-account issue-rate check. */
  async countRecent(userAccountId: string, purpose: UserTokenPurpose, since: Date) {
    return this.prisma.userToken.count({
      where: { userAccountId, purpose, createdAt: { gte: since } },
    });
  }
}
