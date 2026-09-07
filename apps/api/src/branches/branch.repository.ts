import { Injectable } from '@nestjs/common';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';

export interface BranchRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  status: string;
  timezoneName: string;
  currencyCode: string | null;
  sortOrder: number;
  deletedAt: Date | null;
}

/**
 * Branches, scoped to the company in the request context.
 *
 * The base class is what makes `branch.companyId === currentCompany.id` true by
 * construction rather than by remembering to check it: `companyId` is merged
 * into every filter here, so a subclass never writes it and cannot omit it.
 * Reading another company's branch by id resolves to
 * `findFirst({ id: theirs, companyId: mine })`, matches nothing, and 404s —
 * the id alone is never trusted, which is the property this module needs most.
 */
@Injectable()
export class BranchRepository extends TenantScopedRepository<BranchRow> {
  protected readonly modelName = 'Branch';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<BranchRow> {
    return tx.branch;
  }
}
