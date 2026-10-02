/**
 * Permission RULES.
 *
 * The keys themselves live in `@undarga/shared` so the web app compiles against
 * the same union (see that file for why). Everything here is a rule — who holds
 * what, which reads are sensitive, which roles are seeded — and rules stay
 * server-side under `docs/ARCHITECTURE-RULES.md` rule 8.
 *
 * The keys are re-exported so every existing importer keeps working and so
 * server code has one place to import from.
 */

import {
  ALL_COMPANY_PERMISSIONS,
  COMPANY_PERMISSIONS,
  SYSTEM_ROLES,
  type CompanyPermission,
  type SystemRoleKey,
} from '@undarga/shared';

export {
  ALL_COMPANY_PERMISSIONS,
  ALL_PLATFORM_PERMISSIONS,
  COMPANY_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  SYSTEM_ROLES,
  isPlatformPermission,
} from '@undarga/shared';
export type {
  CompanyPermission,
  Permission,
  PlatformPermission,
  SystemRoleKey,
} from '@undarga/shared';

const C = COMPANY_PERMISSIONS;

// ---------------------------------------------------------------------------
// Sensitivity classification
// ---------------------------------------------------------------------------

export type PermissionSensitivity = 'read' | 'sensitive-read' | 'write';

/**
 * Every company permission, classified.
 *
 * `Record<CompanyPermission, …>` is the point: adding a key to the catalog
 * without classifying it here is a TYPE ERROR, not a silent grant. That is a
 * stronger guarantee than any test, and it is what this table exists to buy.
 *
 * It replaces `ALL_COMPANY_PERMISSIONS.filter(p => p.includes(':read'))`, which
 * handed private customer notes, billing figures, revenue reports and the audit
 * trail to the most restricted role — purely because those keys happen to
 * contain the substring ":read". The blast radius was two-wide: the READ_ONLY
 * system role, and, through `MembershipService.authorizePlatformOperator`,
 * every platform operator holding `data:read` but not `data:write`.
 *
 * 'sensitive-read' means a read that must be granted deliberately and never by
 * pattern. The test is not "how secret is it" but "would someone be surprised
 * to learn the most restricted role could see this".
 */
export const COMPANY_PERMISSION_SENSITIVITY: Record<CompanyPermission, PermissionSensitivity> = {
  // company administration
  [C.COMPANY_READ]: 'read',
  [C.COMPANY_WRITE]: 'write',
  [C.SETTINGS_READ]: 'read',
  [C.SETTINGS_WRITE]: 'write',
  [C.BRANDING_WRITE]: 'write',
  // What the company pays and owes. Not a general read.
  [C.BILLING_READ]: 'sensitive-read',
  [C.BILLING_WRITE]: 'write',
  [C.DOMAIN_WRITE]: 'write',

  // people
  [C.MEMBER_READ]: 'read',
  [C.MEMBER_INVITE]: 'write',
  [C.MEMBER_WRITE]: 'write',
  [C.MEMBER_REMOVE]: 'write',
  [C.ROLE_READ]: 'read',
  [C.ROLE_WRITE]: 'write',

  [C.BRANCH_READ]: 'read',
  [C.BRANCH_WRITE]: 'write',

  [C.EMPLOYEE_READ]: 'read',
  [C.EMPLOYEE_WRITE]: 'write',
  [C.SCHEDULE_READ]: 'read',
  [C.SCHEDULE_WRITE_OWN]: 'write',
  [C.SCHEDULE_WRITE_ANY]: 'write',
  [C.TIME_OFF_REQUEST]: 'write',
  [C.TIME_OFF_APPROVE]: 'write',

  // catalog
  [C.SERVICE_READ]: 'read',
  [C.SERVICE_WRITE]: 'write',
  [C.RESOURCE_READ]: 'read',
  [C.RESOURCE_WRITE]: 'write',

  // availability
  [C.AVAILABILITY_READ]: 'read',

  // customers
  [C.CUSTOMER_READ]: 'read',
  [C.CUSTOMER_WRITE]: 'write',
  // Notes staff write about a person, expecting them to stay with the people
  // who need them.
  [C.CUSTOMER_NOTE_READ_PRIVATE]: 'sensitive-read',
  // Bulk exfiltration. A read in name only.
  [C.CUSTOMER_EXPORT]: 'sensitive-read',

  // bookings
  [C.APPOINTMENT_READ_OWN]: 'read',
  [C.APPOINTMENT_READ_ANY]: 'read',
  [C.APPOINTMENT_WRITE]: 'write',
  [C.APPOINTMENT_CANCEL_OWN]: 'write',
  [C.APPOINTMENT_CANCEL_ANY]: 'write',

  // money
  [C.PAYMENT_READ]: 'read',
  [C.PAYMENT_WRITE]: 'write',
  [C.PAYMENT_REFUND]: 'write',
  [C.INVOICE_READ]: 'read',
  [C.PROMOTION_READ]: 'read',
  [C.PROMOTION_WRITE]: 'write',
  [C.GIFTCARD_READ]: 'read',
  [C.GIFTCARD_ISSUE]: 'write',
  [C.GIFTCARD_ADJUST]: 'write',
  [C.GIFTCARD_REDEEM]: 'write',

  // reporting
  [C.REPORT_READ]: 'read',
  // Company-wide revenue. The single most commercially sensitive read there is.
  [C.REPORT_REVENUE_READ]: 'sensitive-read',
  [C.REPORT_EXPORT]: 'sensitive-read',

  // audit
  // Who did what, including every platform-operator access. Handing this to the
  // most restricted role also hands over the record of who has been looking.
  [C.AUDIT_READ]: 'sensitive-read',
};

/**
 * The read-only subset. Used by the READ_ONLY system role and by a platform
 * operator holding `platform:company:data:read` but not `:write`.
 *
 * Both consumers currently want exactly this set. If they ever diverge — an
 * operator keeping `audit:read` for incident work, say — split a separate
 * `PLATFORM_READ_ONLY_COMPANY_PERMISSIONS` here rather than widening this one.
 * Today that would be indirection with one caller, and an operator
 * investigating an incident already holds `platform:audit:read`.
 */
export const READ_ONLY_COMPANY_PERMISSIONS: readonly CompanyPermission[] =
  ALL_COMPANY_PERMISSIONS.filter((p) => COMPANY_PERMISSION_SENSITIVITY[p] === 'read');

/** Reads that must be granted deliberately. Never folded into a derived set. */
export const SENSITIVE_READ_PERMISSIONS: readonly CompanyPermission[] =
  ALL_COMPANY_PERMISSIONS.filter((p) => COMPANY_PERMISSION_SENSITIVITY[p] === 'sensitive-read');

// ---------------------------------------------------------------------------
// Seeded system roles
// ---------------------------------------------------------------------------

/**
 * A company may clone one of these into a custom role; the system roles
 * themselves are immutable, so a tenant cannot edit `OWNER` to grant itself
 * something the platform did not intend.
 */
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
    C.AVAILABILITY_READ,
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
    C.GIFTCARD_REDEEM,
    C.REPORT_READ,
  ],

  RECEPTIONIST: [
    C.COMPANY_READ,
    C.BRANCH_READ,
    C.EMPLOYEE_READ,
    C.SCHEDULE_READ,
    C.SERVICE_READ,
    C.RESOURCE_READ,
    C.AVAILABILITY_READ,
    C.CUSTOMER_READ,
    C.CUSTOMER_WRITE,
    C.APPOINTMENT_READ_ANY,
    C.APPOINTMENT_WRITE,
    C.APPOINTMENT_CANCEL_ANY,
    C.PAYMENT_READ,
    C.PAYMENT_WRITE,
    C.GIFTCARD_READ,
    C.GIFTCARD_ISSUE,
    C.GIFTCARD_REDEEM,
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
    C.AVAILABILITY_READ,
    C.SCHEDULE_READ,
    C.SCHEDULE_WRITE_OWN,
    C.TIME_OFF_REQUEST,
    C.CUSTOMER_READ,
    C.APPOINTMENT_READ_OWN,
    C.APPOINTMENT_CANCEL_OWN,
  ],

  READ_ONLY: READ_ONLY_COMPANY_PERMISSIONS,
};

/** Re-exported for callers that only need the role key list. */
export const SYSTEM_ROLE_KEYS: readonly SystemRoleKey[] = Object.values(SYSTEM_ROLES);
