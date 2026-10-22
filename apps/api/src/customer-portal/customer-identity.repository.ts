import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlatformPrismaService } from '../database/platform-prisma.service';

/**
 * `customer_identity` — the person behind a company's customer record.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS ON THE PLATFORM CONNECTION (allowlisted in nest.js)
 * ---------------------------------------------------------------------------
 *
 * Identities are global, and the tenant role is denied INSERT and UPDATE on
 * them outright (001_hardening.sql), the same way `user_account` is closed to
 * it. Signing a customer in for the first time has to create one. This file
 * does exactly two things with the privileged connection: find-or-create an
 * identity for an email address the caller has JUST PROVED they control (a
 * one-time code sent to it), and read whether a linked identity is usable.
 * Everything about the customer's company record stays on the tenant
 * connection, under RLS.
 */
@Injectable()
export class CustomerIdentityRepository {
  constructor(private readonly prisma: PlatformPrismaService) {}

  /** The identity for a verified email: found, or created as verified. */
  async findOrCreateVerified(
    email: string,
    fullName: string | null,
  ): Promise<{ id: string; status: string }> {
    const now = new Date();
    const existing = await this.prisma.customerIdentity.findUnique({
      where: { email },
      select: { id: true, status: true, deletedAt: true, emailVerifiedAt: true },
    });
    if (existing) {
      if (existing.deletedAt) return { id: existing.id, status: 'DISABLED' };
      await this.prisma.customerIdentity.update({
        where: { id: existing.id },
        data: { lastLoginAt: now, ...(existing.emailVerifiedAt ? {} : { emailVerifiedAt: now }) },
      });
      return { id: existing.id, status: existing.status };
    }
    try {
      const created = await this.prisma.customerIdentity.create({
        data: { email, fullName, emailVerifiedAt: now, lastLoginAt: now },
        select: { id: true, status: true },
      });
      return created;
    } catch (error) {
      // Two first sign-ins racing for the same address: the winner's row is it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await this.prisma.customerIdentity.findUniqueOrThrow({
          where: { email },
          select: { id: true, status: true },
        });
        return raced;
      }
      throw error;
    }
  }

  /** Whether an identity already linked to a customer record may sign in. */
  async usable(identityId: string): Promise<boolean> {
    const identity = await this.prisma.customerIdentity.findFirst({
      where: { id: identityId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (identity) {
      await this.prisma.customerIdentity.update({
        where: { id: identityId },
        data: { lastLoginAt: new Date() },
      });
    }
    return identity !== null;
  }
}
