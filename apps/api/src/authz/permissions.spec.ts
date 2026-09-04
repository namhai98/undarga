import {
  ALL_COMPANY_PERMISSIONS,
  COMPANY_PERMISSIONS,
  COMPANY_PERMISSION_SENSITIVITY,
  READ_ONLY_COMPANY_PERMISSIONS,
  SENSITIVE_READ_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  isPlatformPermission,
} from './permissions';

const C = COMPANY_PERMISSIONS;

/**
 * The classification table exists because deriving a permission set from a
 * substring is a silent-failure machine. These tests guard the two things the
 * type system cannot: that nothing sensitive is in the read-only set, and that
 * the four keys which actually leaked stay out of it by name.
 */
describe('permission classification', () => {
  it('classifies every company permission', () => {
    // Also a compile-time guarantee via Record<CompanyPermission, …>. Asserted
    // anyway so the failure names the missing key instead of being a type error
    // in an unrelated file.
    const unclassified = ALL_COMPANY_PERMISSIONS.filter(
      (p) => COMPANY_PERMISSION_SENSITIVITY[p] === undefined,
    );
    expect(unclassified).toEqual([]);
  });

  it('never puts a sensitive read in the read-only set', () => {
    const overlap = READ_ONLY_COMPANY_PERMISSIONS.filter((p) =>
      SENSITIVE_READ_PERMISSIONS.includes(p),
    );
    expect(overlap).toEqual([]);
  });

  it('never puts a write in the read-only set', () => {
    const writes = READ_ONLY_COMPANY_PERMISSIONS.filter(
      (p) => COMPANY_PERMISSION_SENSITIVITY[p] === 'write',
    );
    expect(writes).toEqual([]);
  });

  describe('the keys that leaked', () => {
    // Regression guard, by name.
    //
    // READ_ONLY_COMPANY_PERMISSIONS was once
    //   ALL_COMPANY_PERMISSIONS.filter(p => p.includes(':read'))
    // which granted all four of these to the most restricted company role AND,
    // through MembershipService.authorizePlatformOperator, to every platform
    // operator holding data:read but not data:write.
    it.each([
      ['private customer notes', C.CUSTOMER_NOTE_READ_PRIVATE],
      ['billing figures', C.BILLING_READ],
      ['revenue reports', C.REPORT_REVENUE_READ],
      ['the audit trail', C.AUDIT_READ],
    ])('keeps %s out of the read-only set', (_label, permission) => {
      expect(READ_ONLY_COMPANY_PERMISSIONS).not.toContain(permission);
      expect(SYSTEM_ROLE_PERMISSIONS.READ_ONLY).not.toContain(permission);
    });

    it('still grants ordinary reads', () => {
      // The fix must not have swung the other way into uselessness.
      for (const permission of [
        C.COMPANY_READ,
        C.MEMBER_READ,
        C.SERVICE_READ,
        C.CUSTOMER_READ,
        C.APPOINTMENT_READ_ANY,
        C.REPORT_READ,
      ]) {
        expect(READ_ONLY_COMPANY_PERMISSIONS).toContain(permission);
      }
    });
  });

  it('is a stable, reviewable set', () => {
    // A snapshot so any future change to the read-only role shows up as a diff
    // in review rather than as a quiet widening.
    expect([...READ_ONLY_COMPANY_PERMISSIONS].sort()).toMatchInlineSnapshot(`
[
  "appointment:read:any",
  "appointment:read:own",
  "branch:read",
  "company:read",
  "customer:read",
  "employee:read",
  "giftcard:read",
  "invoice:read",
  "member:read",
  "payment:read",
  "promotion:read",
  "report:read",
  "resource:read",
  "role:read",
  "schedule:read",
  "service:read",
  "settings:read",
]
`);
  });
});

describe('catalog separation', () => {
  it('keeps the two realms disjoint', () => {
    // A company permission that started with "platform:" would be granted to
    // every OWNER, which is the one thing the two-catalog split exists to stop.
    const leaked = ALL_COMPANY_PERMISSIONS.filter((p) => isPlatformPermission(p));
    expect(leaked).toEqual([]);
  });
});

describe('system roles', () => {
  it('gives OWNER everything', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.OWNER).toEqual(ALL_COMPANY_PERMISSIONS);
  });

  it('grants only real permissions', () => {
    for (const [role, permissions] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
      const unknown = permissions.filter((p) => !ALL_COMPANY_PERMISSIONS.includes(p));
      expect({ role, unknown }).toEqual({ role, unknown: [] });
    }
  });

  it('withholds from ADMIN the four things only an owner should do', () => {
    for (const permission of [C.BILLING_WRITE, C.DOMAIN_WRITE, C.MEMBER_REMOVE, C.GIFTCARD_ADJUST]) {
      expect(SYSTEM_ROLE_PERMISSIONS.ADMIN).not.toContain(permission);
    }
  });
});
