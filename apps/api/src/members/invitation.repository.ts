import { Injectable } from '@nestjs/common';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';

export interface InvitationRow {
  id: string;
  companyId: string;
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  invitedByCompanyUserId: string | null;
  companyUserId: string | null;
  createdAt: Date;
}

/**
 * Invitations, scoped to the company in the request context.
 *
 * Everything an administrator does to an invitation goes through here, so the
 * cross-tenant cases are the base class's rather than this file's: rotating or
 * revoking another company's invitation resolves to `updateMany({ companyId:
 * mine, id: theirs })`, matches nothing, and 404s. That matters more than usual
 * for rotate — a successful cross-tenant rotate would silently kill a live
 * invitation in a company the caller cannot even see.
 *
 * Looking an invitation up BY TOKEN cannot happen here: the company is not
 * known at that point. See InvitationTokenRepository.
 */
@Injectable()
export class InvitationRepository extends TenantScopedRepository<InvitationRow> {
  protected readonly modelName = 'CompanyInvitation';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<InvitationRow> {
    return tx.companyInvitation;
  }
}
