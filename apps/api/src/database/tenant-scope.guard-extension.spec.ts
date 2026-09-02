import { UnscopedTenantQueryError } from '../common/errors';
import { assertTenantScoped } from './tenant-scope.guard-extension';

// The assertion reads model metadata from the generated Prisma client's DMMF.
// Stubbed here so the unit suite needs neither a database nor a real schema.
jest.mock('./tenant-models', () => {
  const models = new Map([
    [
      'Appointment',
      {
        name: 'Appointment',
        companyIdRequired: true,
        exemptFromAssertion: false,
        scopedCompoundKeys: ['companyId_id', 'companyId_appointmentNumber'],
      },
    ],
    [
      'OutboxEvent',
      {
        name: 'OutboxEvent',
        companyIdRequired: true,
        exemptFromAssertion: true,
        scopedCompoundKeys: [],
      },
    ],
  ]);

  return {
    isTenantModel: (m?: string) => !!m && models.has(m),
    tenantModelInfo: (m: string) => models.get(m),
    tenantModels: () => models,
    tenantModelSummary: () => ({}),
  };
});

const COMPANY = '018f0000-0000-7000-8000-00000000000a';

describe('assertTenantScoped', () => {
  describe('models it does not police', () => {
    it('ignores models with no companyId', () => {
      expect(() => assertTenantScoped('Currency', 'findMany', { where: {} })).not.toThrow();
    });

    it('ignores raw operations', () => {
      // It cannot see inside raw SQL. RLS covers that gap; the lint rule
      // covers the rest.
      expect(() => assertTenantScoped('Appointment', '$queryRaw', undefined)).not.toThrow();
    });

    it('honours the explicit exemption list', () => {
      expect(() => assertTenantScoped('OutboxEvent', 'findMany', { where: {} })).not.toThrow();
    });
  });

  describe('reads', () => {
    it.each(['findFirst', 'findMany', 'count', 'aggregate', 'groupBy'])(
      'refuses an unscoped %s',
      (operation) => {
        expect(() =>
          assertTenantScoped('Appointment', operation, { where: { branchId: 'branch-1' } }),
        ).toThrow(UnscopedTenantQueryError);
      },
    );

    it('accepts a top-level companyId', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'findMany', { where: { companyId: COMPANY } }),
      ).not.toThrow();
    });

    it('accepts companyId inside an equals filter', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'findMany', {
          where: { companyId: { equals: COMPANY } },
        }),
      ).not.toThrow();
    });

    it('accepts companyId nested in a top-level AND', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'findMany', {
          where: { AND: [{ status: 'CONFIRMED' }, { companyId: COMPANY }] },
        }),
      ).not.toThrow();
    });

    it('accepts the compound unique key used by by-id lookups', () => {
      // findUnique({ where: { companyId_id: { companyId, id } } }) is the
      // intended shape, backed by @@unique([companyId, id]).
      expect(() =>
        assertTenantScoped('Appointment', 'findUnique', {
          where: { companyId_id: { companyId: COMPANY, id: 'appt-1' } },
        }),
      ).not.toThrow();
    });

    it('refuses findUnique by bare id', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'findUnique', { where: { id: 'appt-1' } }),
      ).toThrow(UnscopedTenantQueryError);
    });

    // OR looks scoped and is not: the second branch matches any tenant's row.
    // Accepting it would be worse than rejecting a valid query.
    it('refuses companyId inside an OR', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'findMany', {
          where: { OR: [{ companyId: COMPANY }, { id: 'appt-1' }] },
        }),
      ).toThrow(UnscopedTenantQueryError);
    });

    it('refuses a negated companyId', () => {
      // `{ not: X }` means "every company except", the opposite of scoping.
      expect(() =>
        assertTenantScoped('Appointment', 'findMany', {
          where: { companyId: { not: COMPANY } },
        }),
      ).toThrow(UnscopedTenantQueryError);
    });

    it('refuses an empty in-list', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'findMany', { where: { companyId: { in: [] } } }),
      ).toThrow(UnscopedTenantQueryError);
    });

    it('refuses a missing where entirely', () => {
      expect(() => assertTenantScoped('Appointment', 'findMany', {})).toThrow(
        UnscopedTenantQueryError,
      );
    });
  });

  describe('writes', () => {
    it('refuses a create without a company', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'create', { data: { startsAt: new Date() } }),
      ).toThrow(UnscopedTenantQueryError);
    });

    it('accepts a create with companyId', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'create', { data: { companyId: COMPANY } }),
      ).not.toThrow();
    });

    it('accepts a create that connects the company relation', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'create', {
          data: { company: { connect: { id: COMPANY } } },
        }),
      ).not.toThrow();
    });

    it('checks every row of a createMany, not just the first', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'createMany', {
          data: [{ companyId: COMPANY }, { startsAt: new Date() }],
        }),
      ).toThrow(UnscopedTenantQueryError);
    });

    it.each(['update', 'updateMany', 'delete', 'deleteMany'])(
      'refuses an unscoped %s',
      (operation) => {
        expect(() =>
          assertTenantScoped('Appointment', operation, { where: { id: 'appt-1' }, data: {} }),
        ).toThrow(UnscopedTenantQueryError);
      },
    );

    it('refuses an update that reassigns companyId', () => {
      // Moving a row between tenants is never a legitimate update.
      expect(() =>
        assertTenantScoped('Appointment', 'updateMany', {
          where: { companyId: COMPANY, id: 'appt-1' },
          data: { companyId: 'other-company' },
        }),
      ).toThrow(UnscopedTenantQueryError);
    });

    it('requires both halves of an upsert to be scoped', () => {
      expect(() =>
        assertTenantScoped('Appointment', 'upsert', {
          where: { companyId_id: { companyId: COMPANY, id: 'a' } },
          create: { startsAt: new Date() },
          update: {},
        }),
      ).toThrow(UnscopedTenantQueryError);

      expect(() =>
        assertTenantScoped('Appointment', 'upsert', {
          where: { id: 'a' },
          create: { companyId: COMPANY },
          update: {},
        }),
      ).toThrow(UnscopedTenantQueryError);

      expect(() =>
        assertTenantScoped('Appointment', 'upsert', {
          where: { companyId_id: { companyId: COMPANY, id: 'a' } },
          create: { companyId: COMPANY },
          update: {},
        }),
      ).not.toThrow();
    });
  });

  it('refuses an operation it does not recognise', () => {
    // A new Prisma operation should be reviewed and added deliberately, not
    // waved through by a default-allow branch.
    expect(() => assertTenantScoped('Appointment', 'someFutureOperation', {})).toThrow(
      UnscopedTenantQueryError,
    );
  });

  it('names the model and operation in the error so the fix is obvious', () => {
    try {
      assertTenantScoped('Appointment', 'findMany', { where: {} });
      fail('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('Appointment');
      expect((error as Error).message).toContain('findMany');
      expect((error as Error).message).toContain('TenantScopedRepository');
    }
  });
});
