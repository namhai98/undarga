import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes';
import { NoTenant } from '../tenancy/decorators/tenant.decorators';
import { InvitationAcceptService } from './invitation-accept.service';
import {
  acceptInvitationSchema,
  previewInvitationSchema,
  type AcceptInvitationDto,
  type PreviewInvitationDto,
} from './dto/invitation.dto';

/**
 * The public half of the invitation flow.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE CONTROLLER AT A SEPARATE PATH
 * ---------------------------------------------------------------------------
 *
 * These two routes are the only unauthenticated writes in the application, and
 * they are mounted at `/api/v1/invitations` rather than under
 * `/api/v1/members/...` so that the public surface and the permissioned one
 * cannot be confused for each other in a route listing or in review.
 *
 * `@Public()` alone would be enough — TenantGuard and PermissionGuard both
 * return true for it — but `@NoTenant()` is declared as well. It documents the
 * intent, and it means the route does not suddenly start demanding a tenant if
 * someone later removes `@Public()` while refactoring.
 *
 * NOTE: because `@Public()` short-circuits PermissionGuard entirely, these
 * routes get no company-status check from the guard chain. That check lives in
 * InvitationAcceptService and must stay there.
 *
 * ---------------------------------------------------------------------------
 * NOT NESTED UNDER A COMPANY
 * ---------------------------------------------------------------------------
 *
 * There is deliberately no `/companies/:companyId/invitations/accept`. The
 * company must come from the invitation row and nowhere else; a company id in
 * the path would be a caller-supplied tenant selector on an unauthenticated
 * route, which is the worst combination available.
 */
@ApiTags('invitations')
@Controller({ path: 'invitations', version: '1' })
@Public()
@NoTenant()
export class InvitationAcceptController {
  constructor(private readonly accept: InvitationAcceptService) {}

  @Post('preview')
  @HttpCode(200)
  @ApiOperation({
    summary: 'What this invitation is for',
    description:
      'Lets the accept screen show the company and address, and decide whether to ask for a ' +
      'password or for a sign-in, before the recipient commits to anything. POST rather than ' +
      'GET because the token travels in the body — see below.',
  })
  @ApiResponse({ status: 200, description: 'Valid and outstanding.' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND — unknown, revoked or used.' })
  @ApiResponse({ status: 410, description: 'INVITATION_EXPIRED.' })
  async preview(@Body(new ZodValidationPipe(previewInvitationSchema)) dto: PreviewInvitationDto) {
    return this.accept.preview(dto);
  }

  /**
   * Accept.
   *
   * The token is in the BODY, not the path. `POST /invitations/{token}/accept`
   * is the more familiar shape, but a URL is the least private part of a
   * request: it is written to access logs, proxy logs, browser history and the
   * `Referer` header of every subsequent request from that page. A one-time
   * credential should not be recorded in four places on its way in.
   *
   * The link the recipient clicks is a FRONTEND url —
   * `{WEB_APP_URL}/invitations/accept?token=…` — which the web app reads and
   * posts here. Only the frontend origin ever sees it in a URL.
   *
   * A bearer token is optional and only consulted when the invited address
   * already has a usable account, in which case the caller must be signed in
   * as that address.
   *
   * No session is returned. Sign in normally afterwards.
   */
  @Post('accept')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Accept an invitation and join the company',
    description:
      'Returns the company and membership, never tokens: a stolen link must not be ' +
      'exchangeable for a session. If the address already has an account you must be signed ' +
      'in as it; if it does not, supply fullName and password to create one.',
  })
  @ApiResponse({ status: 200, description: 'Joined.' })
  @ApiResponse({ status: 400, description: 'VALIDATION_FAILED — password or name required.' })
  @ApiResponse({ status: 401, description: 'INVITATION_SIGN_IN_REQUIRED — account exists.' })
  @ApiResponse({ status: 403, description: 'INVITATION_EMAIL_MISMATCH — signed in as someone else.' })
  @ApiResponse({ status: 404, description: 'INVITATION_NOT_FOUND.' })
  @ApiResponse({ status: 410, description: 'INVITATION_EXPIRED.' })
  async acceptInvitation(
    @Body(new ZodValidationPipe(acceptInvitationSchema)) dto: AcceptInvitationDto,
  ) {
    return this.accept.accept(dto);
  }
}
