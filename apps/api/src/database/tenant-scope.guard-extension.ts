import { UnscopedTenantQueryError } from '../common/errors';
import { isTenantModel, tenantModelInfo } from './tenant-models';

/**
 * The scoped-query assertion.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ASSERTS INSTEAD OF INJECTING
 * ---------------------------------------------------------------------------
 *
 * The obvious Prisma trick is a middleware that quietly rewrites every query to
 * add `companyId`. It is rejected here, for four reasons:
 *
 *   1. It is the "clever magic" that makes queries impossible to reason about.
 *      A developer reads `findMany({ where: { branchId } })`, sees one filter,
 *      and gets a different query. Debugging a wrong result then means
 *      debugging the framework.
 *
 *   2. It fails silently in exactly the cases that matter. Injection covers
 *      top-level `where` and nothing else — not nested writes, not `$queryRaw`,
 *      not `groupBy` having-clauses. The gaps produce no error, so the team
 *      learns to trust a mechanism that is only partly there.
 *
 *   3. It hides bugs rather than surfacing them. Code that forgot the tenant is
 *      broken code; auto-correcting it means the bug ships and the next
 *      developer copies the pattern.
 *
 *   4. It cannot distinguish "forgot the tenant" from "deliberately
 *      cross-tenant". Asserting forces that decision to be written down.
 *
 * So this extension only ever *refuses*. Correct code passes through untouched
 * and the SQL Prisma emits is exactly the SQL the developer wrote.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 *
 * It is not the isolation boundary. Row-level security is, and RLS is active on
 * every query this client makes. This layer exists so a missing `companyId`
 * fails as a loud 500 in development instead of an empty result set in
 * production that everyone assumes means "no records".
 *
 * It cannot see `$queryRaw`. That gap is covered by RLS underneath and by the
 * `no-restricted-syntax` lint rule above.
 */

type UnknownRecord = Record<string, unknown>;

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WRITE_WHERE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany']);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Operations that touch no rows and so need no scope. */
const IGNORED_OPS = new Set([
  '$queryRaw',
  '$executeRaw',
  '$queryRawUnsafe',
  '$executeRawUnsafe',
  '$runCommandRaw',
  'findRaw',
  'aggregateRaw',
]);

export function assertTenantScoped(
  model: string | undefined,
  operation: string,
  args: unknown,
): void {
  if (!model || IGNORED_OPS.has(operation)) return;
  if (!isTenantModel(model)) return;

  const info = tenantModelInfo(model)!;
  if (info.exemptFromAssertion) return;

  const a = (args ?? {}) as UnknownRecord;

  if (CREATE_OPS.has(operation)) {
    assertCreateScoped(model, operation, a, info.scopedCompoundKeys);
    return;
  }

  if (operation === 'upsert') {
    // Both halves matter: an unscoped `where` could match another tenant's row
    // and turn an insert into a cross-tenant update.
    if (!whereIsScoped(a['where'], info.scopedCompoundKeys)) {
      throw new UnscopedTenantQueryError(model, 'upsert (where)');
    }
    if (!dataIsScoped(a['create'])) {
      throw new UnscopedTenantQueryError(model, 'upsert (create)');
    }
    return;
  }

  if (READ_OPS.has(operation) || WRITE_WHERE_OPS.has(operation)) {
    if (!whereIsScoped(a['where'], info.scopedCompoundKeys)) {
      throw new UnscopedTenantQueryError(model, operation);
    }
    // An update that rewrites companyId would move a row between tenants.
    if (WRITE_WHERE_OPS.has(operation) && rewritesCompanyId(a['data'])) {
      throw new UnscopedTenantQueryError(model, `${operation} (data reassigns companyId)`);
    }
    return;
  }

  // Unknown operation: refuse rather than wave it through. A new Prisma
  // operation should be reviewed and added above, not silently unprotected.
  throw new UnscopedTenantQueryError(model, `${operation} (unrecognised operation)`);
}

function assertCreateScoped(
  model: string,
  operation: string,
  args: UnknownRecord,
  _compoundKeys: readonly string[],
): void {
  const data = args['data'];

  if (Array.isArray(data)) {
    // createMany: every row, not just the first.
    const bad = data.findIndex((row) => !dataIsScoped(row));
    if (bad >= 0) {
      throw new UnscopedTenantQueryError(model, `${operation} (row ${bad})`);
    }
    return;
  }

  if (!dataIsScoped(data)) {
    throw new UnscopedTenantQueryError(model, operation);
  }
}

/**
 * A create is scoped if it sets companyId directly or connects the company
 * relation. Nested creates below the top level are not inspected: their tenant
 * is fixed by the composite foreign key on `(company_id, parent_id)`, which the
 * database enforces regardless of what this function thinks.
 */
function dataIsScoped(data: unknown): boolean {
  if (!isRecord(data)) return false;
  if (hasConcreteValue(data['companyId'])) return true;

  const company = data['company'];
  if (isRecord(company)) {
    if (isRecord(company['connect']) || isRecord(company['connectOrCreate'])) return true;
  }
  return false;
}

function rewritesCompanyId(data: unknown): boolean {
  if (!isRecord(data)) return false;
  return 'companyId' in data || 'company' in data;
}

/**
 * A `where` counts as scoped when companyId is constrained at the top level or
 * inside a top-level AND.
 *
 * `OR` is deliberately NOT accepted. `OR: [{ companyId: X }, { id: Y }]` looks
 * scoped and is not — the second branch matches any tenant's row. Anything
 * subtler than the accepted shapes is refused, on the principle that a false
 * negative costs a developer one minute and a false positive costs a customer
 * their data.
 */
function whereIsScoped(where: unknown, compoundKeys: readonly string[]): boolean {
  if (!isRecord(where)) return false;

  if (isCompanyIdConstrained(where['companyId'])) return true;

  // `findUnique({ where: { companyId_id: { companyId, id } } })` — the intended
  // shape for by-id lookups, backed by @@unique([companyId, id]).
  for (const key of compoundKeys) {
    const compound = where[key];
    if (isRecord(compound) && hasConcreteValue(compound['companyId'])) return true;
  }

  const and = where['AND'];
  if (Array.isArray(and)) {
    if (and.some((clause) => whereIsScoped(clause, compoundKeys))) return true;
  } else if (isRecord(and)) {
    if (whereIsScoped(and, compoundKeys)) return true;
  }

  return false;
}

/**
 * `companyId` may be a bare value or a filter object. `{ not: ... }` and
 * `{ notIn: ... }` are rejected: they are the shapes that mean "every company
 * except", which is the opposite of scoping.
 */
function isCompanyIdConstrained(value: unknown): boolean {
  if (hasConcreteValue(value)) return typeof value !== 'object';

  if (isRecord(value)) {
    if (hasConcreteValue(value['equals'])) return true;
    const inList = value['in'];
    if (Array.isArray(inList) && inList.length > 0) return true;
  }
  return false;
}

function hasConcreteValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
