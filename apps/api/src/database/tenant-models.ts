import { Prisma } from '@prisma/client';

/**
 * Which Prisma models are company-owned, derived from the schema itself.
 *
 * WHY DERIVED RATHER THAN LISTED
 *
 * A hand-maintained array of 60 model names is a list that drifts. Someone adds
 * a table, forgets the array, and the new table silently opts out of every
 * safety check in this directory — which is precisely the failure the checks
 * exist to prevent. Reading the DMMF at boot means a model is protected the
 * moment it has a `companyId` field, with no second place to remember.
 *
 * The database has the matching guard from the other side: the
 * `tables_missing_rls` view in 001_hardening.sql fails CI if a table with a
 * company_id column has no row-level security policy.
 */

/**
 * Models whose `companyId` is nullable, i.e. a NULL row is legitimately
 * platform-wide. These are enumerated explicitly because "nullable" alone is
 * not enough to justify unscoped access — each one is a deliberate exception
 * with a reason.
 */
const NULLABLE_TENANT_MODELS: Record<string, string> = {
  NotificationTemplate:
    'NULL rows are platform-provided default templates, readable by every tenant.',
  AuditLog: 'NULL rows record platform-level actions that belong to no company.',
};

/**
 * Models that carry a `companyId` but are exempt from the scoped-query
 * assertion, because the only code that touches them already runs on the
 * platform connection with a deliberate cross-tenant purpose.
 */
const ASSERTION_EXEMPT: Record<string, string> = {
  // The hold sweeper and the notification dispatcher intentionally scan across
  // tenants to *find* work, then re-enter each tenant's context to do it.
  OutboxEvent: 'Dispatcher claims across tenants on the platform pool, then re-enters per tenant.',
};

export interface TenantModelInfo {
  readonly name: string;
  readonly companyIdRequired: boolean;
  readonly exemptFromAssertion: boolean;
  /** Compound unique keys that include companyId, e.g. `companyId_id`. */
  readonly scopedCompoundKeys: readonly string[];
}

function build(): ReadonlyMap<string, TenantModelInfo> {
  const map = new Map<string, TenantModelInfo>();

  for (const model of Prisma.dmmf.datamodel.models) {
    const companyField = model.fields.find((f) => f.name === 'companyId');
    if (!companyField) continue;

    // Compound unique keys containing companyId. Prisma exposes these in a
    // `where` as `companyId_id: { companyId, id }`, and recognising them is
    // what lets `findUnique` stay usable under the assertion.
    const scopedCompoundKeys: string[] = [];
    for (const unique of model.uniqueFields) {
      if (unique.includes('companyId')) {
        scopedCompoundKeys.push(unique.join('_'));
      }
    }
    for (const idx of model.uniqueIndexes ?? []) {
      if (idx.fields.includes('companyId')) {
        scopedCompoundKeys.push(idx.name || idx.fields.join('_'));
      }
    }
    // A model whose primary key is composite and includes companyId.
    if (model.primaryKey?.fields.includes('companyId')) {
      scopedCompoundKeys.push(model.primaryKey.name || model.primaryKey.fields.join('_'));
    }

    map.set(model.name, {
      name: model.name,
      companyIdRequired: companyField.isRequired && !(model.name in NULLABLE_TENANT_MODELS),
      exemptFromAssertion: model.name in ASSERTION_EXEMPT,
      scopedCompoundKeys: [...new Set(scopedCompoundKeys)],
    });
  }

  return map;
}

let cache: ReadonlyMap<string, TenantModelInfo> | null = null;

export function tenantModels(): ReadonlyMap<string, TenantModelInfo> {
  cache ??= build();
  return cache;
}

export function isTenantModel(model: string | undefined): boolean {
  return model ? tenantModels().has(model) : false;
}

export function tenantModelInfo(model: string): TenantModelInfo | undefined {
  return tenantModels().get(model);
}

/** Diagnostics for the startup banner and the health endpoint. */
export function tenantModelSummary() {
  const all = [...tenantModels().values()];
  return {
    total: Prisma.dmmf.datamodel.models.length,
    tenantScoped: all.length,
    nullableTenant: Object.keys(NULLABLE_TENANT_MODELS),
    assertionExempt: Object.keys(ASSERTION_EXEMPT),
  };
}
