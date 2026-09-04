/**
 * The permission vocabulary — keys only.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SHARED AND THE RULES ARE NOT
 * ---------------------------------------------------------------------------
 *
 * `docs/ARCHITECTURE-RULES.md` rule 8 keeps business rules out of this package.
 * That is why only the *keys* live here. Who holds which permission, what
 * counts as a sensitive read, and whether a grant would escalate privilege are
 * all decided server-side and stay in `apps/api/src/authz/permissions.ts`.
 *
 * The keys themselves are vocabulary, and they belong here for the same reason
 * `API_ERROR_CODES` does: both sides compile against one union, so a renamed
 * key is a build failure rather than a branch that silently never runs. Without
 * it, `useCan('member:invite')` would return false forever after a rename and
 * the button would simply stop appearing — with no error anywhere.
 *
 * The frontend uses these to decide what to *render*. It is not a security
 * boundary (rule 3): the web app hides buttons, the API decides.
 *
 * Two catalogs, never one with a flag:
 *
 *   COMPANY_PERMISSIONS  — what you can do *inside* one company.
 *   PLATFORM_PERMISSIONS — what you can do to the SaaS itself.
 *
 * They never mix. A company OWNER holds every company permission and zero
 * platform permissions, so no amount of privilege escalation inside a tenant
 * produces cross-tenant reach. The database mirrors the split in
 * `permission.scope`, seeded from these keys.
 */

export const COMPANY_PERMISSIONS = {
  // company administration
  COMPANY_READ: 'company:read',
  COMPANY_WRITE: 'company:write',
  SETTINGS_READ: 'settings:read',
  SETTINGS_WRITE: 'settings:write',
  BRANDING_WRITE: 'settings:branding:write',
  BILLING_READ: 'settings:billing:read',
  BILLING_WRITE: 'settings:billing:write',
  DOMAIN_WRITE: 'settings:domain:write',

  // people
  MEMBER_READ: 'member:read',
  MEMBER_INVITE: 'member:invite',
  MEMBER_WRITE: 'member:write',
  MEMBER_REMOVE: 'member:remove',
  ROLE_READ: 'role:read',
  ROLE_WRITE: 'role:write',

  BRANCH_READ: 'branch:read',
  BRANCH_WRITE: 'branch:write',

  EMPLOYEE_READ: 'employee:read',
  EMPLOYEE_WRITE: 'employee:write',
  SCHEDULE_READ: 'schedule:read',
  SCHEDULE_WRITE_OWN: 'schedule:write:own',
  SCHEDULE_WRITE_ANY: 'schedule:write:any',
  TIME_OFF_REQUEST: 'timeoff:request',
  TIME_OFF_APPROVE: 'timeoff:approve',

  // catalog
  SERVICE_READ: 'service:read',
  SERVICE_WRITE: 'service:write',
  RESOURCE_READ: 'resource:read',
  RESOURCE_WRITE: 'resource:write',

  // customers
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_WRITE: 'customer:write',
  CUSTOMER_NOTE_READ_PRIVATE: 'customer:note:read:private',
  /** Separate from customer:read so bulk exfiltration is its own decision. */
  CUSTOMER_EXPORT: 'customer:export',

  // bookings
  APPOINTMENT_READ_OWN: 'appointment:read:own',
  APPOINTMENT_READ_ANY: 'appointment:read:any',
  APPOINTMENT_WRITE: 'appointment:write',
  APPOINTMENT_CANCEL_OWN: 'appointment:cancel:own',
  APPOINTMENT_CANCEL_ANY: 'appointment:cancel:any',

  // money
  PAYMENT_READ: 'payment:read',
  PAYMENT_WRITE: 'payment:write',
  PAYMENT_REFUND: 'payment:refund',
  INVOICE_READ: 'invoice:read',
  PROMOTION_READ: 'promotion:read',
  PROMOTION_WRITE: 'promotion:write',
  GIFTCARD_READ: 'giftcard:read',
  GIFTCARD_ISSUE: 'giftcard:issue',
  GIFTCARD_ADJUST: 'giftcard:adjust',

  // reporting
  REPORT_READ: 'report:read',
  REPORT_REVENUE_READ: 'report:revenue:read',
  REPORT_EXPORT: 'report:export',

  // audit
  AUDIT_READ: 'audit:read',
} as const;

export const PLATFORM_PERMISSIONS = {
  COMPANY_LIST: 'platform:company:list',
  COMPANY_PROVISION: 'platform:company:provision',
  COMPANY_SUSPEND: 'platform:company:suspend',
  /** Read a tenant's business data. Never implicit — see MembershipService. */
  COMPANY_DATA_READ: 'platform:company:data:read',
  /** Modify a tenant's business data. Reserved for incident recovery. */
  COMPANY_DATA_WRITE: 'platform:company:data:write',
  IMPERSONATE: 'platform:impersonate',
  PLAN_WRITE: 'platform:plan:write',
  BILLING_MANAGE: 'platform:billing:manage',
  OPERATOR_MANAGE: 'platform:operator:manage',
  AUDIT_READ_ALL: 'platform:audit:read',
} as const;

export type CompanyPermission = (typeof COMPANY_PERMISSIONS)[keyof typeof COMPANY_PERMISSIONS];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];
export type Permission = CompanyPermission | PlatformPermission;

export const ALL_COMPANY_PERMISSIONS: readonly CompanyPermission[] =
  Object.values(COMPANY_PERMISSIONS);
export const ALL_PLATFORM_PERMISSIONS: readonly PlatformPermission[] =
  Object.values(PLATFORM_PERMISSIONS);

export function isPlatformPermission(key: string): key is PlatformPermission {
  return key.startsWith('platform:');
}

/**
 * Seeded system role keys.
 *
 * Only the keys are shared — which permissions each role holds is a rule and
 * stays server-side. The frontend needs these to label a role badge and to
 * offer "start from this role" when cloning; it must never derive what a role
 * can do from its key.
 */
export const SYSTEM_ROLES = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  BRANCH_MANAGER: 'BRANCH_MANAGER',
  RECEPTIONIST: 'RECEPTIONIST',
  EMPLOYEE: 'EMPLOYEE',
  READ_ONLY: 'READ_ONLY',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLES)[keyof typeof SYSTEM_ROLES];
