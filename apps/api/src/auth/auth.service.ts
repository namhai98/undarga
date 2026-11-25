import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config';
import type { SystemActor } from '../tenancy/context/context.types';
import {
  InvalidCredentialsError,
  MfaEnrollmentRequiredError,
  MfaRequiredError,
  RefreshTokenReusedError,
  SessionRevokedError,
  TenantNotFoundError,
  UnauthenticatedError,
} from '../common/errors';
import { TenantDirectoryService } from '../tenancy/directory/tenant-directory.service';
import { normalizeEmail } from './normalize-email';
import { IdentityRepository } from './identity.repository';
import { PasswordService } from './password.service';
import { PlatformMfaService } from './platform-mfa.service';
import { SessionDenyList } from './session-deny-list';
import { TokenHashService } from './token-hash.service';
import { TokenService } from './token.service';
import type { IssuedTokens } from './token.types';

/** Failed and suspicious attempts: nobody has proved who they are. */
const ANONYMOUS: SystemActor = { kind: 'SYSTEM', name: 'anonymous' };

export interface MembershipSummary {
  companyId: string;
  companySlug: string;
  companyName: string;
  isOwner: boolean;
}

export interface AuthenticatedSession extends IssuedTokens {
  memberships: MembershipSummary[];
}

/**
 * Authentication and active-company selection.
 *
 * ---------------------------------------------------------------------------
 * MULTIPLE MEMBERSHIPS ARE THE NORMAL CASE
 * ---------------------------------------------------------------------------
 *
 * A user may belong to any number of companies with a different role in each.
 * Nothing here binds an account to one company:
 *
 *   - Login returns the full membership list and selects a *default* active
 *     company (the first, deterministically ordered) purely so the common
 *     single-company user is not forced through a picker.
 *   - The active company lives in the token, so it is per-session rather than
 *     per-account. The same person can be signed in to two companies in two
 *     browsers.
 *   - Switching issues a NEW token rather than mutating state, so a token is
 *     always valid for exactly one company. There is no window in which a token
 *     means two things.
 *
 * The active company is still only a hint: TenantGuard re-validates membership
 * on every request, so a token naming a company the user was just removed from
 * stops working immediately rather than at expiry.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly identity: IdentityRepository,
    private readonly directory: TenantDirectoryService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly hashes: TokenHashService,
    private readonly denyList: SessionDenyList,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly mfa: PlatformMfaService,
  ) {}

  // -------------------------------------------------------------------------
  // Staff
  // -------------------------------------------------------------------------

  async loginStaff(
    email: string,
    password: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<AuthenticatedSession> {
    const user = await this.identity.findStaffByEmail(normalizeEmail(email));

    // Every failure below raises the identical error. "No such user", "wrong
    // password", "account disabled" and "locked out" are indistinguishable to
    // the caller, so the login endpoint cannot be used to enumerate accounts.
    // The password is still verified against a dummy hash when the user does
    // not exist (see PasswordService.verify) so the timing matches too.
    if (!user) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      await this.identity.recordStaffLoginFailure(user.id);
      // Platform-level, about a known account: the trail that shows someone
      // guessing at it. The attempt proves nothing about who made it.
      await this.audit.recordAs(ANONYMOUS, {
        action: 'auth.sign_in_failed',
        resourceType: 'user_account',
        resourceId: user.id,
      });
      throw new InvalidCredentialsError();
    }

    if (user.status !== 'ACTIVE') {
      throw new InvalidCredentialsError();
    }

    await this.identity.recordStaffLoginSuccess(user.id);

    const memberships = await this.directory.listMembershipsForUser(user.id);
    // Deterministic default so a single-company user never sees a picker. A
    // user with no memberships still gets a valid token — they can be invited
    // to a company, and their token simply carries no active company until then.
    const active = memberships[0];

    const { sessionId, ...issued } = await this.issueStaffSession({
      userAccountId: user.id,
      email: user.email,
      name: user.fullName,
      activeCompanyId: active?.companyId,
      companyUserId: active?.companyUserId,
      meta,
    });

    // Filed under the company the session opened in, so that company sees who
    // signed in to it.
    await this.audit.recordAs(
      {
        kind: 'COMPANY_USER',
        userAccountId: user.id,
        email: user.email,
        displayName: user.fullName,
        sessionId,
      },
      { action: 'auth.signed_in', resourceType: 'user_session', resourceId: sessionId },
      active?.companyId,
    );

    return { ...issued, memberships: memberships.map(toSummary) };
  }

  /**
   * Switch the active company.
   *
   * Validates membership here as well as in TenantGuard. Belt and braces: this
   * is the one endpoint whose entire purpose is to change which company a token
   * points at, so it should not depend on a downstream guard to be correct.
   */
  async switchCompany(
    userAccountId: string,
    sessionId: string,
    targetCompanyId: string,
  ): Promise<AuthenticatedSession> {
    const user = await this.identity.findStaffById(userAccountId);
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthenticatedError();
    }

    const memberships = await this.directory.listMembershipsForUser(userAccountId);
    const target = memberships.find((m) => m.companyId === targetCompanyId);

    if (!target) {
      // Same 404 as everywhere else: switching to a company you do not belong
      // to must not confirm that the company exists.
      throw new TenantNotFoundError();
    }

    // The old session is retired rather than reused, so a leaked token cannot
    // be replayed against the new company.
    this.denyList.revoke(sessionId);
    await this.identity.revokeStaffSession(sessionId);

    const { sessionId: _next, ...issued } = await this.issueStaffSession({
      userAccountId: user.id,
      email: user.email,
      name: user.fullName,
      activeCompanyId: target.companyId,
      companyUserId: target.companyUserId,
      meta: {},
    });

    this.logger.log(`User ${userAccountId} switched active company to ${target.companyId}`);

    return { ...issued, memberships: memberships.map(toSummary) };
  }

  /**
   * Rotate a refresh token.
   *
   * Reuse of an already-rotated token kills the whole family. See
   * IdentityRepository.revokeStaffSessionFamily for why that trade is correct.
   */
  async refreshStaff(
    refreshToken: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
  ): Promise<AuthenticatedSession> {
    const tokenHash = this.hashes.hash(refreshToken);
    const session = await this.identity.findStaffSessionByHash(tokenHash);

    if (!session) {
      throw new SessionRevokedError();
    }

    if (session.revokedAt || session.replacedById) {
      return this.rejectReuse(session.familyId);
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new SessionRevokedError();
    }

    const user = await this.identity.findStaffById(session.userAccountId);
    if (!user || user.status !== 'ACTIVE') {
      throw new SessionRevokedError();
    }

    const memberships = await this.directory.listMembershipsForUser(user.id);

    // Carry the session's active company across the rotation.
    //
    // A refresh presents only the refresh token, so the expiring access token —
    // which held the active company — is not available here. Reading it back
    // from the session is what stops a rotation from silently returning the
    // user to their first membership fifteen minutes after they switched.
    //
    // The stored value is a hint and is re-validated: if the membership behind
    // it was revoked, or the row is stale, it is dropped and the default
    // applies. Nothing is authorized on the strength of the hint alone.
    const remembered = session.activeCompanyId
      ? memberships.find((m) => m.companyId === session.activeCompanyId)
      : undefined;
    const active = remembered ?? memberships[0];

    if (session.activeCompanyId && !remembered) {
      this.logger.log(
        `Session ${session.id} pointed at company ${session.activeCompanyId}, ` +
          'which is no longer a live membership; falling back to the default.',
      );
    }

    const nextToken = this.hashes.generate();
    const next = await this.identity.rotateStaffSession({
      previousSessionId: session.id,
      userAccountId: user.id,
      tokenHash: this.hashes.hash(nextToken),
      familyId: session.familyId,
      expiresAt: this.refreshExpiry(),
      activeCompanyId: active?.companyId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    // Another request rotated this token between our read and our write.
    if (!next) return this.rejectReuse(session.familyId);

    this.denyList.revoke(session.id);

    const accessToken = this.tokens.signStaffAccess({
      userAccountId: user.id,
      sessionId: next.id,
      email: user.email,
      name: user.fullName,
      activeCompanyId: active?.companyId,
      companyUserId: active?.companyUserId,
    });

    return {
      accessToken,
      refreshToken: nextToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      activeCompanyId: active?.companyId,
      memberships: memberships.map(toSummary),
    };
  }

  /** A rotated token came back: kill the family and refuse. */
  private async rejectReuse(familyId: string): Promise<never> {
    const killed = await this.identity.revokeStaffSessionFamily(familyId);
    killed.forEach((id) => this.denyList.revoke(id));
    this.logger.warn(
      `Refresh token reuse detected for family ${familyId}; ${killed.length} sessions revoked`,
    );
    // A possible stolen token: worth a row, not just a log line.
    await this.audit.recordAs(ANONYMOUS, {
      action: 'auth.refresh_token_reused',
      resourceType: 'user_session_family',
      resourceId: familyId,
      metadata: { sessionsRevoked: killed.length },
    });
    throw new RefreshTokenReusedError();
  }

  async logoutStaff(sessionId: string): Promise<void> {
    this.denyList.revoke(sessionId);
    await this.identity.revokeStaffSession(sessionId);
  }

  async listMemberships(userAccountId: string): Promise<MembershipSummary[]> {
    const memberships = await this.directory.listMembershipsForUser(userAccountId);
    return memberships.map(toSummary);
  }

  // -------------------------------------------------------------------------
  // Platform
  // -------------------------------------------------------------------------

  /**
   * Operator sign-in: password, then a TOTP code.
   *
   * An enrolled operator always needs the code; a wrong one counts towards the
   * lockout exactly like a wrong password. An operator who has not enrolled is
   * refused when PLATFORM_MFA_REQUIRED (always, in production), and only let
   * in — loudly — in development.
   */
  async loginPlatform(
    email: string,
    password: string,
    meta: { ipAddress?: string; userAgent?: string } = {},
    mfaCode?: string,
  ): Promise<IssuedTokens> {
    const user = await this.identity.findPlatformUserByEmail(normalizeEmail(email));

    if (!user) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    // Locked out: the same error and the same work as a wrong password, so the
    // response says nothing about whether the account exists or is locked.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      await this.passwords.verify(null, password);
      throw new InvalidCredentialsError();
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok) {
      await this.identity.recordPlatformLoginFailure(user.id);
      this.logger.warn(`Failed platform sign-in for operator ${user.id}`);
      await this.audit.recordAs(ANONYMOUS, {
        action: 'platform.sign_in_failed',
        resourceType: 'platform_user',
        resourceId: user.id,
      });
      throw new InvalidCredentialsError();
    }
    if (user.status !== 'ACTIVE') {
      throw new InvalidCredentialsError();
    }

    if (user.mfaEnrolledAt) {
      // Only reached with the right password, so this says nothing to a guesser.
      if (!mfaCode) throw new MfaRequiredError();
      if (!(await this.mfa.verify(user, mfaCode))) {
        await this.identity.recordPlatformLoginFailure(user.id);
        await this.audit.recordAs(ANONYMOUS, {
          action: 'platform.mfa_failed',
          resourceType: 'platform_user',
          resourceId: user.id,
        });
        throw new InvalidCredentialsError();
      }
    } else if (this.config.auth.platformMfaRequired) {
      throw new MfaEnrollmentRequiredError();
    } else {
      this.logger.error(
        `Platform user ${user.id} signed in without MFA enrolment. Allowed only because ` +
          'PLATFORM_MFA_REQUIRED is false; production refuses this.',
      );
    }

    await this.identity.recordPlatformLogin(user.id);

    const refreshToken = this.hashes.generate();
    const session = await this.identity.createPlatformSession({
      platformUserId: user.id,
      tokenHash: this.hashes.hash(refreshToken),
      familyId: randomUUID(),
      expiresAt: this.refreshExpiry(),
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    this.logger.warn(`Platform operator ${user.email} signed in (session ${session.id})`);
    await this.audit.recordAs(
      {
        kind: 'PLATFORM_USER',
        platformUserId: user.id,
        email: user.email,
        displayName: user.fullName,
        sessionId: session.id,
        platformPermissions: new Set(),
      },
      {
        action: 'platform.signed_in',
        resourceType: 'platform_session',
        resourceId: session.id,
        metadata: { mfa: Boolean(user.mfaEnrolledAt) },
      },
    );

    return {
      accessToken: this.tokens.signPlatformAccess({
        platformUserId: user.id,
        sessionId: session.id,
        email: user.email,
        name: user.fullName,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
    };
  }

  async logoutPlatform(sessionId: string): Promise<void> {
    this.denyList.revoke(sessionId);
    await this.identity.revokePlatformSession(sessionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async issueStaffSession(input: {
    userAccountId: string;
    email: string;
    name: string;
    activeCompanyId?: string;
    companyUserId?: string;
    meta: { ipAddress?: string; userAgent?: string };
  }): Promise<IssuedTokens & { sessionId: string }> {
    const refreshToken = this.hashes.generate();
    const session = await this.identity.createStaffSession({
      userAccountId: input.userAccountId,
      tokenHash: this.hashes.hash(refreshToken),
      familyId: randomUUID(),
      expiresAt: this.refreshExpiry(),
      // Remembered so a refresh can restore it. Re-validated against live
      // memberships every time it is read back.
      activeCompanyId: input.activeCompanyId,
      ipAddress: input.meta.ipAddress,
      userAgent: input.meta.userAgent,
    });

    return {
      accessToken: this.tokens.signStaffAccess({
        userAccountId: input.userAccountId,
        sessionId: session.id,
        email: input.email,
        name: input.name,
        activeCompanyId: input.activeCompanyId,
        companyUserId: input.companyUserId,
      }),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.tokens.accessTtlSeconds,
      activeCompanyId: input.activeCompanyId,
      // For the caller's audit row; stripped before anything is returned.
      sessionId: session.id,
    };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.config.auth.refreshTokenTtlDays * 86_400_000);
  }
}

function toSummary(m: {
  companyId: string;
  companySlug: string;
  companyName: string;
  isOwner: boolean;
}): MembershipSummary {
  return {
    companyId: m.companyId,
    companySlug: m.companySlug,
    companyName: m.companyName,
    isOwner: m.isOwner,
  };
}
