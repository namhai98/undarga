import { Injectable } from '@nestjs/common';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';

interface TemplateRow {
  id: string;
  companyId: string;
}

/**
 * Tenant-scoped access for the notification admin services. Its
 * `transaction` is what they use for every read and write — templates,
 * company settings and customer preferences alike — so each runs inside the
 * caller's company with RLS active.
 */
@Injectable()
export class NotificationTemplateRepository extends TenantScopedRepository<TemplateRow> {
  protected readonly modelName = 'NotificationTemplate';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<TemplateRow> {
    return tx.notificationTemplate as unknown as PrismaDelegateLike<TemplateRow>;
  }
}
