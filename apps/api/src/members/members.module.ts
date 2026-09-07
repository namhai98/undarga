import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { InvitationAcceptController } from './invitation-accept.controller';
import { InvitationAcceptService } from './invitation-accept.service';
import { InvitationTokenRepository } from './invitation-token.repository';
import { InvitationRepository } from './invitation.repository';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';

/**
 * Company membership: invitations today, member and role administration next.
 *
 * AuthModule is imported for TokenHashService (invitation tokens use the same
 * HMAC pepper as refresh tokens — one keyed-hashing scheme in the codebase, not
 * two), PasswordService and IdentityRepository. TenancyModule and AuditModule
 * are @Global, so MembershipService, RequestContextService and AuditService
 * need no import here.
 */
@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [InvitationsController, InvitationAcceptController],
  providers: [
    InvitationsService,
    InvitationRepository,
    InvitationAcceptService,
    InvitationTokenRepository,
  ],
  exports: [InvitationsService],
})
export class MembersModule {}
