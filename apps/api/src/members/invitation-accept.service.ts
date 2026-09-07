import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  InvitationEmailMismatchError,
  InvitationExpiredError,
  InvitationNotFoundError,
  InvitationSignInRequiredError,
  ValidationFailedError,
} from '../common/errors';
import { IdentityRepository } from '../auth/identity.repository';
import { PasswordService } from '../auth/password.service';
import { TokenHashService } from '../auth/token-hash.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { MembershipService } from '../tenancy/membership/membership.service';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { isCompanyUser } from '../tenancy/context/context.types';
import { InvitationTokenRepository } from './invitation-token.repository';
import type { AcceptInvitationDto, PreviewInvitationDto } from './dto/invitation.dto';

export interface InvitationPreview {
  companyName: string;
  companySlug: string;
  email: string;
  roles: Array<{ key: string; name: string }>;
  expiresAt: Date;
  /** Which form to render: sign in, or choose a password. */
  accountExists: boolean;
}

export interface AcceptedInvitation {
  companyId: string;
  companySlug: string;
  companyName: string;
  companyUserId: string;
  email: string;
  roles: Array<{ key: string; name: string }>;
  /** True when accepting created the account. The client should sign in next. */
  accountCreated: boolean;
}

/**
 * Accepting an invitation.
 *
 * ===========================================================================
 * THE THREE PROPERTIES THAT CAP THE DAMAGE OF A LEAKED LINK
 * ===========================================================================
 *
 * An invitation link is a bearer credential sent over a channel nobody
 * controls — pasted into chat, forwarded, screenshotted. The design assumes it
 * will leak, and limits what that is worth:
 *
 *   1. ACCEPTING NEVER ISSUES A SESSION. No tokens come back. The recipient
 *      signs in afterwards through the ordinary login route. A stolen link
 *      cannot be exchanged for access on its own.
 *
 *   2. ACCEPTING NEVER SETS A PASSWORD ON AN EXISTING ACCOUNT. If the address
 *      already has one, the caller must ALREADY be signed in as it. Otherwise
 *      a leaked link would be a password reset for somebody else's account.
 *
 *   3. THE MEMBERSHIP IS BOUND TO THE INVITED ADDRESS, not to whoever happens
 *      to be signed in. Without that, an administrator of company B who clicks
 *      a leaked link gets silently added to company A.
 *
 * What remains: whoever holds the link can create an account for an address
 * they may not own, and join one company as a non-owner with the roles the
 * inviter chose. That is the irreducible cost of link-based invitations, and
 * it is why the token is 256 bits, single-use, rotatable and short-lived.
 *
 * ===========================================================================
 * THE GUARD CHAIN DOES NOT HELP HERE
 * ===========================================================================
 *
 * These routes are `@Public()`, and PermissionGuard returns true immediately
 * for a public route — including for `@RequiresWrite()`. So the company-status
 * check that every other write endpoint gets for free has to be made in this
 * file, by hand. It is step 3 below. Removing it would let anyone accept into
 * a suspended or cancelled company.
 */
@Injectable()
export class InvitationAcceptService {
  private readonly logger = new Logger(InvitationAcceptService.name);

  constructor(
    private readonly tokens: InvitationTokenRepository,
    private readonly identity: IdentityRepository,
    private readonly passwords: PasswordService,
    private readonly hashes: TokenHashService,
    private readonly db: TenantPrismaService,
    private readonly memberships: MembershipService,
    private readonly context: RequestContextService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  /**
   * What the accept screen needs before the user commits to anything.
   *
   * Unauthenticated by necessity — the whole point is that the recipient may
   * not have an account. It discloses the company name and the invited address
   * to whoever holds the token, which is acceptable because holding the token
   * is what the invitation grants; it does not disclose anything to someone who
   * does not.
   */
  async preview(input: PreviewInvitationDto): Promise<InvitationPreview> {
    const invitation = await this.resolveLive(input.token);
    const account = await this.identity.findStaffAccountForInvite(invitation.email);

    return {
      companyName: invitation.company.displayName,
      companySlug: invitation.company.slug,
      email: invitation.email,
      roles: invitation.roles.map((r) => ({ key: r.role.key, name: r.role.name })),
      expiresAt: invitation.expiresAt,
      // A usable account is one that exists and can hold a password. A
      // placeholder created by provisioning has neither, so the recipient is
      // sent down the set-a-password path, which is correct.
      accountExists: account !== null && !account.deletedAt && account.hasPassword,
    };
  }

  // ---------------------------------------------------------------------------
  // Accept
  // ---------------------------------------------------------------------------

  async accept(input: AcceptInvitationDto): Promise<AcceptedInvitation> {
    const invitation = await this.resolveLive(input.token);
    const existing = await this.identity.findStaffAccountForInvite(invitation.email);

    // A soft-deleted or disabled account must not be revived by an invitation.
    // Reported as a dead token rather than as a state, so the token holder
    // learns nothing about the account behind the address.
    if (existing && (existing.deletedAt || existing.status === 'DISABLED')) {
      throw new InvitationNotFoundError();
    }

    const { userAccountId, accountCreated } = existing?.hasPassword
      ? { userAccountId: this.requireSignedInAs(invitation.email, existing.id), accountCreated: false }
      : await this.ensureAccount(invitation.email, existing?.id ?? null, input);

    const result = await this.claim(invitation, userAccountId);

    // Permissions and membership are cached per replica; without this the user
    // who just joined is told they are not a member until the TTL lapses.
    this.memberships.invalidateUser(invitation.companyId, userAccountId);

    await this.audit.recordForCompany(invitation.companyId, {
      action: 'member.invitation_accepted',
      resourceType: 'company_user',
      resourceId: result.companyUserId,
      metadata: { invitationId: invitation.id, accountCreated, email: invitation.email },
    });

    this.logger.log(
      `Invitation ${invitation.id} accepted for company ${invitation.companyId} ` +
        `(account ${accountCreated ? 'created' : 'existing'})`,
    );

    return {
      companyId: invitation.companyId,
      companySlug: invitation.company.slug,
      companyName: invitation.company.displayName,
      companyUserId: result.companyUserId,
      email: invitation.email,
      roles: invitation.roles.map((r) => ({ key: r.role.key, name: r.role.name })),
      accountCreated,
    };
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /**
   * Token -> invitation, or one of two errors.
   *
   * Steps 1-3 of the accept flow, shared with preview so the two cannot drift
   * apart and leave preview validating something accept does not.
   */
  private async resolveLive(token: string) {
    // 1. Look up by HMAC. The plaintext is never stored, so a database dump
    //    yields no usable links.
    const invitation = await this.tokens.findByTokenHash(this.hashes.hash(token));
    if (!invitation) throw new InvitationNotFoundError();

    // 2. Terminal states share one answer. See InvitationNotFoundError.
    if (invitation.acceptedAt || invitation.revokedAt) throw new InvitationNotFoundError();

    // Expiry is derived, not stored, so it takes effect on the stroke of the
    // clock with no sweeper job to fall behind.
    if (invitation.expiresAt.getTime() <= Date.now()) throw new InvitationExpiredError();

    // 3. The company-status check the guard chain skipped for a @Public() route.
    const company = invitation.company;
    if (company.deletedAt || company.status === 'CANCELED' || company.status === 'SUSPENDED') {
      throw new InvitationNotFoundError();
    }

    return invitation;
  }

  /**
   * The existing-account path: prove you are already that person.
   *
   * The bearer token in the request is the proof. Matching on the INVITATION's
   * address rather than on "whoever is signed in" is what stops a leaked link
   * silently adding an unrelated account to the company.
   */
  private requireSignedInAs(invitedEmail: string, accountId: string): string {
    const actor = this.context.peek()?.actor;

    if (!actor || !isCompanyUser(actor)) {
      throw new InvitationSignInRequiredError();
    }

    // Citext in the database; compare case-insensitively here to match.
    if (actor.email.toLowerCase() !== invitedEmail.toLowerCase()) {
      throw new InvitationEmailMismatchError();
    }

    if (actor.userAccountId !== accountId) {
      // Same address, different account id. Should be impossible given the
      // unique index on email, so treat it as a bug rather than a branch.
      throw new InvitationEmailMismatchError();
    }

    return actor.userAccountId;
  }

  /**
   * The new-account path: create it, or fill in the password on a placeholder.
   *
   * A placeholder is what provisioning leaves behind for an owner — the row
   * exists so the membership had something to point at, but it has no password
   * and cannot be signed into. Completing it here is not a password reset:
   * there was never a password to reset, and no session was ever possible.
   */
  private async ensureAccount(
    email: string,
    placeholderId: string | null,
    input: AcceptInvitationDto,
  ): Promise<{ userAccountId: string; accountCreated: boolean }> {
    const issues: Record<string, string> = {};
    if (!input.password) issues.password = 'Choose a password to finish setting up your account.';
    if (!placeholderId && !input.fullName) issues.fullName = 'Tell us your name.';

    if (Object.keys(issues).length > 0) {
      throw new ValidationFailedError(issues);
    }

    const passwordHash = await this.passwords.hash(input.password!);

    if (placeholderId) {
      const activated = await this.identity.activateStaffAccountWithPassword(
        placeholderId,
        passwordHash,
        input.fullName,
      );

      if (!activated) {
        // The account acquired a password between the check and here. Fall back
        // to the sign-in path rather than assuming; never overwrite one.
        throw new InvitationSignInRequiredError();
      }

      return { userAccountId: placeholderId, accountCreated: false };
    }

    const account = await this.identity.createActiveStaffAccount({
      email,
      fullName: input.fullName!,
      passwordHash,
    });

    return { userAccountId: account.id, accountCreated: true };
  }

  /**
   * Consume the invitation and create the membership, atomically.
   *
   * ---------------------------------------------------------------------------
   * WHY THE UPDATE COMES FIRST
   * ---------------------------------------------------------------------------
   *
   * `updateMany` with `acceptedAt: null` in the WHERE is a compare-and-swap:
   * the row is claimed, and a count of zero means somebody else claimed it
   * first. Doing it before the membership write means two simultaneous accepts
   * of one link produce one membership, not two — the loser rolls back having
   * written nothing.
   *
   * The unique index on `(company_id, user_account_id)` is the second line of
   * defence, so even a claim that somehow slipped through cannot produce a
   * duplicate member.
   *
   * ---------------------------------------------------------------------------
   * THE ATOMICITY GAP, STATED HONESTLY
   * ---------------------------------------------------------------------------
   *
   * Account creation happens on the PLATFORM connection and cannot join this
   * transaction — `user_account` is unwritable from the tenant connection under
   * FORCE RLS. The order is chosen so a crash between them is recoverable: the
   * account is created first and is idempotent by email, and the invitation is
   * still live, so a retry finds the account and completes. An account with no
   * membership can reach no company, so the intermediate state is inert.
   */
  private async claim(
    invitation: {
      id: string;
      companyId: string;
      companyUserId: string | null;
      roles: Array<{ role: { id: string } }>;
    },
    userAccountId: string,
  ) {
    return this.db.runInCompany(invitation.companyId, async (tx) => {
      const claimed = await tx.companyInvitation.updateMany({
        where: { companyId: invitation.companyId, id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: new Date() },
      });

      if (claimed.count === 0) {
        // Lost the race, or revoked in the microseconds since resolveLive.
        throw new InvitationNotFoundError();
      }

      if (invitation.companyUserId) {
        // The provisioning path: the owner's membership already exists in
        // INVITED state and this activates it. Its roles were assigned at
        // provisioning time, so they are not touched here.
        const { count } = await tx.companyUser.updateMany({
          where: {
            companyId: invitation.companyId,
            id: invitation.companyUserId,
            userAccountId,
          },
          data: { status: 'ACTIVE', joinedAt: new Date() },
        });

        if (count === 0) {
          // The invitation points at a membership belonging to someone else.
          // Not reachable through any endpoint; refusing keeps it that way.
          throw new InvitationNotFoundError();
        }

        return { companyUserId: invitation.companyUserId };
      }

      const membership = await tx.companyUser.create({
        data: {
          companyId: invitation.companyId,
          userAccountId,
          status: 'ACTIVE',
          joinedAt: new Date(),
          // A LITERAL false, not a value from anywhere. Ownership is granted
          // only by provisioning; no invitation can confer it.
          isOwner: false,
        },
        select: { id: true },
      });

      await tx.companyUserRole.createMany({
        data: invitation.roles.map((r) => ({
          companyId: invitation.companyId,
          companyUserId: membership.id,
          roleId: r.role.id,
        })),
      });

      await tx.companyInvitation.updateMany({
        where: { companyId: invitation.companyId, id: invitation.id },
        data: { companyUserId: membership.id },
      });

      return { companyUserId: membership.id };
    });
  }
}
