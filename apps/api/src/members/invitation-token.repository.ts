import { Injectable } from '@nestjs/common';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * The one lookup that cannot be tenant-scoped: an invitation by its token.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 *
 * Accepting an invitation happens before the caller has a session, and long
 * before a company is resolved — the invitation is what NAMES the company. So
 * the query is `WHERE token_hash = ?` with no `company_id` predicate, which is
 * exactly the shape `assertTenantScoped` refuses on the tenant connection, and
 * rightly so.
 *
 * The containment is the same shape as IdentityRepository:
 *
 *   - Allowlisted in packages/eslint-config/nest.js by exact path.
 *   - One method. It filters on a 256-bit HMAC the caller had to present, so
 *     it cannot be used to enumerate anything.
 *   - It returns the invitation, its roles and the minimum company fields the
 *     accept screen needs. No business data is reachable from here, and the
 *     company it yields is then entered through `runInCompany`, under RLS,
 *     like any other tenant work.
 *
 * Adding a method to this class is a security review, not a refactor.
 */
@Injectable()
export class InvitationTokenRepository {
  constructor(private readonly prisma: PlatformPrismaService) {}

  /**
   * Resolve a token hash to its invitation.
   *
   * Takes the HASH, never the plaintext: the caller hashes with
   * TokenHashService first, so the secret does not travel any further into the
   * data layer than it must.
   */
  async findByTokenHash(tokenHash: string) {
    return this.prisma.companyInvitation.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        companyId: true,
        email: true,
        expiresAt: true,
        acceptedAt: true,
        revokedAt: true,
        companyUserId: true,
        roles: { select: { role: { select: { id: true, key: true, name: true } } } },
        company: {
          select: {
            id: true,
            slug: true,
            displayName: true,
            status: true,
            deletedAt: true,
          },
        },
      },
    });
  }
}
