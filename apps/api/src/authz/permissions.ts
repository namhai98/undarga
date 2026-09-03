/**
 * The permission catalog.
 *
 * Keys are `resource:action` or `resource:action:qualifier`, static, and
 * namespaced by realm. Two separate catalogs, not one with a flag:
 *
 *   COMPANY_PERMISSIONS  — what you can do *inside* one company.
 *   PLATFORM_PERMISSIONS — what you can do to the SaaS itself.
 *
 * They never mix. A company OWNER holds every company permission and zero
 * platform permissions, so no amount of privilege escalation inside a tenant
 * produces cross-tenant reach. That separation is the whole reason for two
 * constants rather than one list with a `scope` column in code.
 *
 * The database mirrors this in `permission.scope`, and these keys are the seed
 * data for that table.
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

/**
 * The read-only subset, used when a platform operator has
 * `platform:company:data:read` but not `:write`. Derived rather than listed so
 * a new read permission is covered automatically.
 */
export const READ_ONLY_COMPANY_PERMISSIONS: readonly CompanyPermission[] =
  ALL_COMPANY_PERMISSIONS.filter((p) => p.includes(':read') || p.includes(':list'));

export function isPlatformPermission(key: string): key is PlatformPermission {
  return key.startsWith('platform:');
}

/**
 * Seeded system roles. A company may clone one into a custom role; the system
 * roles themselves are immutable, so a tenant cannot edit `OWNER` to grant
 * itself something the platform did not intend.
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

const C = COMPANY_PERMISSIONS;

export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly CompanyPermission[]> = {
  // OWNER is granted everything at resolution time rather than from this map,
  // so a permission added later is never silently missing from the owner.
  OWNER: ALL_COMPANY_PERMISSIONS,

  ADMIN: ALL_COMPANY_PERMISSIONS.filter(
    (p) =>
      p !== C.BILLING_WRITE &&
      p !== C.DOMAIN_WRITE &&
      p !== C.MEMBER_REMOVE &&
      p !== C.GIFTCARD_ADJUST,
  ),

  BRANCH_MANAGER: [
    C.COMPANY_READ,
    C.BRANCH_READ,
    C.SETTINGS_READ,
    C.MEMBER_READ,
    C.EMPLOYEE_READ,
    C.EMPLOYEE_WRITE,
    C.SCHEDULE_READ,
    C.SCHEDULE_WRITE_ANY,
    C.TIME_OFF_APPROVE,
    C.SERVICE_READ,
    C.RESOURCE_READ,
    C.RESOURCE_WRITE,
    C.CUSTOMER_READ,
    C.CUSTOMER_WRITE,
    C.APPOINTMENT_READ_ANY,
    C.APPOINTMENT_WRITE,
    C.APPOINTMENT_CANCEL_ANY,
    C.PAYMENT_READ,
    C.PAYMENT_WRITE,
    C.INVOICE_READ,
    C.PROMOTION_READ,
    C.GIFTCARD_READ,
    C.GIFTCARD_ISSUE,
    C.REPORT_READ,
  ],

  RECEPTIONIST: [
    C.COMPANY_READ,
    C.BRANCH_READ,
    C.EMPLOYEE_READ,
    C.SCHEDULE_READ,
    C.SERVICE_READ,
    C.RESOURCE_READ,
    C.CUSTOMER_READ,
    C.CUSTOMER_WRITE,
    C.APPOINTMENT_READ_ANY,
    C.APPOINTMENT_WRITE,
    C.APPOINTMENT_CANCEL_ANY,
    C.PAYMENT_READ,
    C.PAYMENT_WRITE,
    C.GIFTCARD_READ,
    C.GIFTCARD_ISSUE,
    C.PROMOTION_READ,
  ],

  // Note `:own` rather than `:any`: an employee sees their own calendar. The
  // narrowing from "any appointment in the company" to "mine" is a record-level
  // decision and belongs to the policy layer, not to this permission set.
  EMPLOYEE: [
    C.COMPANY_READ,
    C.BRANCH_READ,
    C.SERVICE_READ,
    C.RESOURCE_READ,
    C.SCHEDULE_READ,
    C.SCHEDULE_WRITE_OWN,
    C.TIME_OFF_REQUEST,
    C.CUSTOMER_READ,
    C.APPOINTMENT_READ_OWN,
    C.APPOINTMENT_CANCEL_OWN,
  ],

  READ_ONLY: READ_ONLY_COMPANY_PERMISSIONS,
};
