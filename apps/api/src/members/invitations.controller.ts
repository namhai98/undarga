import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { InvitationsService } from './invitations.service';
import {
  createInvitationSchema,
  listInvitationsSchema,
  rotateInvitationSchema,
  type CreateInvitationDto,
  type ListInvitationsDto,
  type RotateInvitationDto,
} from './dto/invitation.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * Administering invitations, from inside a company.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPANY IS NOT IN THE PATH
 * ---------------------------------------------------------------------------
 *
 * The obvious shape is `POST /organizations/{id}/invitations`, and the tenant
 * resolver chain supports it — `/api/v1/companies/:companyId/...` is validated
 * against the caller's memberships like anything else. But the project's
 * convention for a caller acting inside their own company is to let the token's
 * active company decide, because that is the one source a caller cannot forge.
 * A company in the path is for the case where the caller genuinely needs to
 * name a different one, which an administrator inviting their own colleague
 * does not.
 *
 * Either way the id would be checked against membership: reading it is not the
 * vulnerability, trusting it would be. Leaving it out simply removes the
 * question.
 *
 * ---------------------------------------------------------------------------
 * WHY `/members/invitations` AND NOT `/invitations`
 * ---------------------------------------------------------------------------
 *
 * So the permissioned surface and the PUBLIC accept surface never share a base
 * path. A future route added under the wrong prefix then cannot accidentally
 * inherit the wrong exposure.
 *
 * ---------------------------------------------------------------------------
 * WHY PLATFORM OPERATORS MAY REACH THIS
 * ---------------------------------------------------------------------------
 *
 * `@AllowPlatformAccess()` exists here to close a hole the provisioning design
 * creates. A freshly provisioned company has exactly one member — the owner —
 * and they cannot sign in until they accept. If that link is lost or expires,
 * there is no member left who could re-send it, and the company is stranded
 * with no route back short of direct database surgery.
 *
 * An operator who has explicitly targeted the company can rotate it. That is
 * not a widening of trust: TenantGuard still requires the operator to hold
 * `platform:company:data:*`, MembershipService records the entry, and every
 * resulting audit row is flagged `viaPlatformAccess`.
 */
@ApiTags('members')
@Controller({ path: 'members/invitations', version: '1' })
@AllowPlatformAccess()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_READ)
  @ApiOperation({
    summary: 'List invitations',
    description:
      'Never includes the token: only its HMAC is stored, so the plaintext is unrecoverable ' +
      'after the response that created it.',
  })
  async list(@Query(new ZodValidationPipe(listInvitationsSchema)) query: ListInvitationsDto) {
    return this.invitations.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_INVITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Invite someone to this company',
    description:
      'Returns the one-time token and, when WEB_APP_URL is configured, the link to send. ' +
      'Nothing is emailed — there is no mail transport yet, so the administrator distributes ' +
      'the link. The token appears in this response only.',
  })
  @ApiResponse({ status: 201, description: 'Created. Body carries the one-time token.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — bad email, or unknown role key.' })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED or PRIVILEGE_ESCALATION_BLOCKED.' })
  @ApiResponse({ status: 409, description: 'CONFLICT — already a member, or already invited.' })
  async create(@Body(new ZodValidationPipe(createInvitationSchema)) dto: CreateInvitationDto) {
    return this.invitations.create(dto);
  }

  @Post(':id/rotate')
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_INVITE)
  @RequiresWrite()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Issue a fresh token for an outstanding invitation',
    description:
      'This is "resend the link". The previous token stops working immediately — otherwise ' +
      'resending would leave two live credentials where the administrator believes there is one.',
  })
  @ApiResponse({ status: 404, description: 'Unknown, already accepted, or already revoked.' })
  async rotate(
    @Param('id', uuidParam) id: string,
    @Body(new ZodValidationPipe(rotateInvitationSchema)) dto: RotateInvitationDto,
  ) {
    return this.invitations.rotate(id, dto.expiresInDays);
  }

  @Delete(':id')
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_INVITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke an invitation',
    description: 'The link stops working immediately. Gated by member:invite, not member:remove — '
      + 'withdrawing an invitation nobody accepted is part of inviting, not of removing a person.',
  })
  async revoke(@Param('id', uuidParam) id: string): Promise<void> {
    await this.invitations.revoke(id);
  }
}
