import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IdentityRepository } from '../auth/identity.repository';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { updateProfileSchema, type UpdateProfileDto } from '../auth/dto/account.dto';
import { AuditService } from '../audit/audit.service';
import { ResourceNotFoundError, UnauthenticatedError } from '../common/errors';
import { ZodValidationPipe } from '../common/pipes';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { isCompanyUser, type Actor } from '../tenancy/context/context.types';

/**
 * Your own account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TENANT-LESS
 * ---------------------------------------------------------------------------
 *
 * An account exists independently of any company. Your name, your phone number
 * and your locale are yours across every company you belong to, and changing
 * them from inside Company A must not require — or imply — a Company A
 * permission. `/me/context` is the tenant-scoped counterpart, and it answers a
 * different question: what may I do *here*.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 *
 * Administering OTHER people — listing a company's members, changing their
 * roles, suspending them — is deliberately absent. Those are company-scoped,
 * permission-gated operations against `company_user`, not against
 * `user_account`, and they belong to the members module. Putting them here
 * would blur the one distinction this file exists to keep: this endpoint can
 * only ever act on the caller.
 */
@ApiTags('users')
@Controller({ path: 'users', version: '1' })
@NoTenant()
export class UsersController {
  constructor(
    private readonly identity: IdentityRepository,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @ApiOperation({
    summary: 'Your account',
    description: 'Never includes a password hash, MFA secret, or any other credential column.',
  })
  @ApiResponse({ status: 200, description: 'The caller’s own profile.' })
  @ApiResponse({ status: 401, description: 'UNAUTHENTICATED.' })
  async me(@CurrentUser() actor: Actor | null) {
    const profile = await this.identity.findStaffProfile(requireStaff(actor).userAccountId);
    if (!profile) throw new ResourceNotFoundError('UserAccount');

    return toProfileResponse(profile);
  }

  @Patch('me')
  @ApiOperation({
    summary: 'Update your account',
    description:
      'Name, phone and locale only. The schema is strict, so `status`, `emailVerifiedAt` or ' +
      'any other column sent along is a 400 rather than a silent no-op — those live on the ' +
      'same table and a permissive body is how one of them gets set from a PATCH.',
  })
  @ApiResponse({ status: 200, description: 'The updated profile.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — including unknown fields.' })
  async updateMe(
    @Body(new ZodValidationPipe(updateProfileSchema)) dto: UpdateProfileDto,
    @CurrentUser() actor: Actor | null,
  ) {
    const userAccountId = requireStaff(actor).userAccountId;

    const before = await this.identity.findStaffProfile(userAccountId);
    if (!before) throw new ResourceNotFoundError('UserAccount');

    const updated = await this.identity.updateStaffProfile(userAccountId, dto);

    await this.audit.record({
      action: 'user.profile_updated',
      resourceType: 'user_account',
      resourceId: userAccountId,
      // A change to your own account is not a company event — it would be
      // misleading in one company's trail and invisible from the others.
      platformLevel: true,
      before: { fullName: before.fullName, phone: before.phone, locale: before.locale },
      after: { fullName: updated.fullName, phone: updated.phone, locale: updated.locale },
    });

    return toProfileResponse(updated);
  }
}

function requireStaff(actor: Actor | null) {
  if (!actor || !isCompanyUser(actor)) throw new UnauthenticatedError();
  return actor;
}

/**
 * Shape the response explicitly rather than returning the row.
 *
 * `emailVerified` as a boolean rather than the timestamp: clients branch on
 * "is it verified", and handing out exactly when somebody confirmed their
 * address serves no caller.
 */
function toProfileResponse(profile: {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  locale: string;
  status: string;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: profile.id,
    email: profile.email,
    fullName: profile.fullName,
    phone: profile.phone,
    locale: profile.locale,
    status: profile.status,
    emailVerified: profile.emailVerifiedAt !== null,
    lastLoginAt: profile.lastLoginAt,
    createdAt: profile.createdAt,
  };
}
