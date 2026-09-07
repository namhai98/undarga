import { Injectable } from '@nestjs/common';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';

export interface EmployeeRow {
  id: string;
  companyId: string;
  userAccountId: string | null;
  employeeCode: string | null;
  displayName: string;
  status: string;
  isBookable: boolean;
  deletedAt: Date | null;
}

/**
 * Employees, scoped to the company in the request context.
 *
 * The base class merges `companyId` into every filter, which is what makes
 * "never retrieve an employee by id without verifying company ownership" true
 * by construction rather than by remembering — a foreign id resolves to
 * `findFirst({ id: theirs, companyId: mine })`, matches nothing, and 404s.
 *
 * The join tables (`employee_branch`, `employee_service`) are written through
 * `transaction()`, which hands back the same company id, so even hand-written
 * queries take it from the context rather than from a request body.
 */
@Injectable()
export class EmployeeRepository extends TenantScopedRepository<EmployeeRow> {
  protected readonly modelName = 'Employee';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<EmployeeRow> {
    return tx.employee;
  }
}
