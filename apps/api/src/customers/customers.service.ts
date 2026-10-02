import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError } from '../common/errors';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { TenantPrismaService, type TenantTx } from '../database/tenant-prisma.service';
import {
  TenantScopedRepository,
  type PrismaDelegateLike,
} from '../database/tenant-scoped.repository';
import {
  normalisePhone,
  type CreateCustomerDto,
  type CustomerAppointmentQueryDto,
  type CustomerQueryDto,
  type UpdateCustomerDto,
} from './dto/customer.dto';
import { EntitlementsService } from '../subscriptions/entitlements.service';

interface CustomerRow {
  id: string;
  companyId: string;
  firstName: string;
  deletedAt: Date | null;
}

@Injectable()
export class CustomerRepository extends TenantScopedRepository<CustomerRow> {
  protected readonly modelName = 'CompanyCustomer';

  constructor(db: TenantPrismaService, context: RequestContextService) {
    super(db, context);
  }

  protected delegate(tx: TenantTx): PrismaDelegateLike<CustomerRow> {
    return tx.companyCustomer;
  }
}

/**
 * The people a company books work for.
 *
 * ===========================================================================
 * `company_customer` IS THE RELATIONSHIP, NOT THE PERSON
 * ===========================================================================
 *
 * The schema separates two things that look like one:
 *
 *   `customer_identity`   the human — global, one row, they may log in with it
 *   `company_customer`    what ONE company knows about them — tenant-scoped
 *
 * Every note, tag, statistic, consent and appointment hangs off the second.
 * That is what stops Company A's record of a person reaching Company B, and it
 * is why the same phone number legitimately appears in two companies as two
 * independently editable rows.
 *
 * This module only ever touches `company_customer`. Nothing here reads or
 * writes `customer_identity`: linking a booking account to a company record is
 * the public-booking module's job, and `customerIdentityId` stays NULL until
 * somebody proves control of the address in that flow. A staff-created
 * customer is a record about a person, not an account for them.
 *
 * ===========================================================================
 * DUPLICATES
 * ===========================================================================
 *
 * Two partial unique indexes already exist:
 *
 *   (company_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL
 *   (company_id, phone) WHERE deleted_at IS NULL AND phone IS NOT NULL
 *
 * The database is therefore the authority, and the service checks first only so
 * the caller gets a message naming the field and the existing customer instead
 * of a constraint name. Both paths exist on purpose: the pre-check loses a race
 * between two concurrent creates, and P2002 catches what the race let through.
 *
 * Merging two records that are already duplicates is deliberately not built.
 * A merge has to move appointments, payments, gift cards and loyalty points,
 * and getting that wrong is worse than having two rows.
 */
@Injectable()
export class CustomersService {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly customers: CustomerRepository,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(query: CustomerQueryDto) {
    return this.customers.transaction(async (tx, companyId) => {
      const where = this.buildWhere(companyId, query);

      const [rows, total] = await Promise.all([
        tx.companyCustomer.findMany({
          where,
          orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
          skip: query.offset,
          take: query.limit,
          include: {
            preferredEmployee: { select: { id: true, displayName: true } },
            _count: { select: { appointments: true } },
          },
        }),
        tx.companyCustomer.count({ where }),
      ]);

      return {
        items: rows.map(toCustomerResponse),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  async findById(customerId: string) {
    return this.customers.transaction(async (tx, companyId) => {
      const customer = await tx.companyCustomer.findFirst({
        where: { id: customerId, companyId, deletedAt: null },
        include: {
          preferredEmployee: { select: { id: true, displayName: true } },
          _count: { select: { appointments: true } },
        },
      });

      if (!customer) throw new ResourceNotFoundError('CompanyCustomer', customerId);
      return toCustomerResponse(customer);
    });
  }

  async create(input: CreateCustomerDto) {
    const created = await this.customers.transaction(async (tx, companyId) => {
      if (input.preferredEmployeeId) {
        await this.assertEmployeeExists(tx, companyId, input.preferredEmployeeId);
      }
      await this.assertContactAvailable(tx, companyId, input.email, input.phone);
      await this.entitlements.assertCanAdd(tx, companyId, 'CUSTOMER');

      try {
        return await tx.companyCustomer.create({
          data: {
            ...input,
            companyId,
            birthDate: input.birthDate ? new Date(input.birthDate) : null,
            // A record created at the desk, not through a booking page. The
            // column defaults to STAFF, but saying so makes the intent explicit
            // when the public flow later writes ONLINE.
            source: 'STAFF',
          },
        });
      } catch (error) {
        throw mapDuplicateContact(error, input.email, input.phone);
      }
    });

    await this.audit.record({
      action: 'customer.created',
      resourceType: 'company_customer',
      resourceId: created.id,
      // Contact details are recorded so "who changed this number" is answerable.
      // `notes` is deliberately NOT: it is free text that at a clinic holds
      // medical detail, and nobody audits it field by field.
      after: {
        firstName: created.firstName,
        lastName: created.lastName,
        email: created.email,
        phone: created.phone,
      },
    });

    this.logger.log(`Customer created for company ${created.companyId}`);

    return this.findById(created.id);
  }

  async update(customerId: string, input: UpdateCustomerDto) {
    const before = await this.customers.transaction(async (tx, companyId) => {
      const before = await tx.companyCustomer.findFirst({
        where: { id: customerId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('CompanyCustomer', customerId);

      if (input.preferredEmployeeId) {
        await this.assertEmployeeExists(tx, companyId, input.preferredEmployeeId);
      }

      // Only the contact fields actually being changed are checked, so saving a
      // form that round-trips the customer's own email does not collide with
      // itself.
      await this.assertContactAvailable(
        tx,
        companyId,
        input.email !== undefined && input.email !== before.email ? input.email : undefined,
        input.phone !== undefined && input.phone !== before.phone ? input.phone : undefined,
        customerId,
      );

      const { birthDate, ...rest } = input;
      const data: Prisma.CompanyCustomerUncheckedUpdateManyInput = {
        ...rest,
        ...(birthDate !== undefined ? { birthDate: birthDate ? new Date(birthDate) : null } : {}),
      };

      try {
        const { count } = await tx.companyCustomer.updateMany({
          where: { id: customerId, companyId, deletedAt: null },
          data,
        });
        if (count === 0) throw new ResourceNotFoundError('CompanyCustomer', customerId);
      } catch (error) {
        throw mapDuplicateContact(error, input.email, input.phone);
      }

      return before;
    });

    await this.audit.record({
      action: 'customer.updated',
      resourceType: 'company_customer',
      resourceId: customerId,
      before: {
        firstName: before.firstName,
        lastName: before.lastName,
        email: before.email,
        phone: before.phone,
        status: before.status,
      },
      after: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
        status: input.status,
      },
    });

    return this.findById(customerId);
  }

  /**
   * Soft delete, and the contact details come free again.
   *
   * The row stays because appointments, payments and invoices reference it, and
   * history that cannot resolve a customer name is history nobody can read.
   *
   * Both unique indexes are filtered on `deleted_at IS NULL`, so deleting a
   * customer releases their phone and email for a new record — which is the
   * behaviour a receptionist expects when somebody they deleted by mistake
   * walks back in. It also means a delete is not a way to hide a duplicate:
   * the old row is still there, still joined to its appointments.
   */
  async remove(customerId: string) {
    const before = await this.customers.transaction(async (tx, companyId) => {
      const before = await tx.companyCustomer.findFirst({
        where: { id: customerId, companyId, deletedAt: null },
      });
      if (!before) throw new ResourceNotFoundError('CompanyCustomer', customerId);

      await tx.companyCustomer.updateMany({
        where: { id: customerId, companyId, deletedAt: null },
        data: { deletedAt: new Date(), status: 'ARCHIVED' },
      });

      return before;
    });

    await this.audit.record({
      action: 'customer.deactivated',
      resourceType: 'company_customer',
      resourceId: customerId,
      before: { firstName: before.firstName, lastName: before.lastName, status: before.status },
    });
  }

  /**
   * What this customer has booked.
   *
   * Read-only, and it reads the appointment table directly rather than calling
   * an appointments module — there is no appointments module yet. When one
   * lands this method should delegate to it (rule 5: a module does not query
   * another module's tables), which is why the shape returned here is the
   * summary an appointments module would expose rather than the whole row.
   *
   * The cross-company question the brief asks about is settled in the schema,
   * not here: `appointment.customer` is a COMPOSITE foreign key on
   * `(company_id, customer_id)` referencing `(company_id, id)`, so an
   * appointment in company A physically cannot point at a customer in
   * company B. There is nothing for this module to enforce, and a test asserts
   * the constraint rather than trusting the comment.
   */
  async listAppointments(customerId: string, query: CustomerAppointmentQueryDto) {
    return this.customers.transaction(async (tx, companyId) => {
      const exists = await tx.companyCustomer.findFirst({
        where: { id: customerId, companyId, deletedAt: null },
        select: { id: true },
      });
      if (!exists) throw new ResourceNotFoundError('CompanyCustomer', customerId);

      const where: Prisma.AppointmentWhereInput = { companyId, customerId };

      const [rows, total] = await Promise.all([
        tx.appointment.findMany({
          where,
          // Newest first: the question at the desk is almost always "when were
          // they last in", not "when did they first come".
          orderBy: { startsAt: 'desc' },
          skip: query.offset,
          take: query.limit,
          include: {
            branch: { select: { id: true, name: true } },
            items: {
              orderBy: { sequence: 'asc' },
              select: {
                serviceId: true,
                service: { select: { name: true } },
                employee: { select: { displayName: true } },
              },
            },
          },
        }),
        tx.appointment.count({ where }),
      ]);

      return {
        items: rows.map((appointment) => ({
          id: appointment.id,
          appointmentNumber: appointment.appointmentNumber,
          status: appointment.status,
          paymentStatus: appointment.paymentStatus,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          branchId: appointment.branchId,
          branchName: appointment.branch.name,
          // Minor units as a string — the column is BigInt and money never
          // becomes a JS number in this codebase.
          totalMinor: appointment.totalMinor.toString(),
          currencyCode: appointment.currencyCode,
          services: appointment.items.map((item) => ({
            serviceId: item.serviceId,
            name: item.service.name,
            employeeName: item.employee?.displayName ?? null,
          })),
        })),
        total,
        limit: query.limit,
        offset: query.offset,
      };
    });
  }

  /**
   * The customer behind an online booking: an existing record with the same
   * phone (checked first) or email, otherwise a new one marked `source: ONLINE`.
   *
   * ---------------------------------------------------------------------------
   * AN ANONYMOUS FORM NEVER EDITS AN EXISTING RECORD
   * ---------------------------------------------------------------------------
   *
   * Anyone can type anyone's phone number. So a match is reused as-is — the
   * name, email and notes staff keep on it are not overwritten by whatever a
   * visitor typed — and the caller learns nothing about which case happened:
   * `reused` is for the server's audit trail, not for the response.
   *
   * The unique indexes on (company, phone) and (company, email) are the
   * authority. Two simultaneous first-time bookings with the same number both
   * miss the lookup and race to insert; the loser's P2002 aborts its
   * transaction, so the retry re-reads in a fresh one and finds the winner.
   */
  async findOrCreateForBooking(input: {
    firstName: string;
    lastName?: string | null;
    phone: string;
    email?: string | null;
  }): Promise<{ id: string; status: string; reused: boolean }> {
    const lookup = (tx: TenantTx, companyId: string) => this.findByContact(tx, companyId, input);

    try {
      const result = await this.customers.transaction(async (tx, companyId) => {
        const existing = await lookup(tx, companyId);
        if (existing) return { ...existing, reused: true };
        // A returning customer never counts; only a new one does.
        await this.entitlements.assertCanAdd(tx, companyId, 'CUSTOMER');

        const created = await tx.companyCustomer.create({
          data: {
            companyId,
            firstName: input.firstName,
            lastName: input.lastName ?? null,
            phone: input.phone,
            email: input.email ?? null,
            source: 'ONLINE',
          },
          select: { id: true, status: true },
        });
        return { ...created, reused: false };
      });

      if (!result.reused) {
        await this.audit.record({
          action: 'customer.created',
          resourceType: 'company_customer',
          resourceId: result.id,
          after: {
            firstName: input.firstName,
            lastName: input.lastName ?? null,
            email: input.email ?? null,
            phone: input.phone,
          },
          metadata: { channel: 'online_booking' },
        });
      }
      return result;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const winner = await this.customers.transaction(lookup);
      if (!winner) throw error;
      return { ...winner, reused: true };
    }
  }

  private async findByContact(
    tx: TenantTx,
    companyId: string,
    contact: { phone: string; email?: string | null },
  ): Promise<{ id: string; status: string } | null> {
    const byPhone = await tx.companyCustomer.findFirst({
      where: { companyId, deletedAt: null, phone: contact.phone },
      select: { id: true, status: true },
    });
    if (byPhone || !contact.email) return byPhone;

    return tx.companyCustomer.findFirst({
      where: { companyId, deletedAt: null, email: contact.email },
      select: { id: true, status: true },
    });
  }

  // ---------------------------------------------------------------------------

  private buildWhere(companyId: string, query: CustomerQueryDto): Prisma.CompanyCustomerWhereInput {
    return {
      companyId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.preferredEmployeeId ? { preferredEmployeeId: query.preferredEmployeeId } : {}),
      ...(query.hasVisited
        ? query.hasVisited === 'true'
          ? { lastVisitAt: { not: null } }
          : { lastVisitAt: null }
        : {}),
      ...(query.search ? { OR: customerSearchClauses(query.search) } : {}),
    };
  }

  /**
   * 404, not 400, and never a 500 from the composite foreign key.
   *
   * A preferred employee belonging to another company must be indistinguishable
   * from one that does not exist.
   */
  private async assertEmployeeExists(tx: TenantTx, companyId: string, employeeId: string) {
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, companyId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) throw new ResourceNotFoundError('Employee', employeeId);
  }

  /**
   * Refuse an obvious duplicate before creating one.
   *
   * Scoped to the company and to live rows, exactly matching the two partial
   * unique indexes — a check with a different predicate than the index it
   * anticipates is worse than no check, because it disagrees with the database
   * in one direction or the other.
   */
  private async assertContactAvailable(
    tx: TenantTx,
    companyId: string,
    email: string | null | undefined,
    phone: string | null | undefined,
    excludeCustomerId?: string,
  ) {
    for (const [field, value] of [
      ['email', email],
      ['phone', phone],
    ] as const) {
      if (!value) continue;

      const existing = await tx.companyCustomer.findFirst({
        where: {
          companyId,
          deletedAt: null,
          [field]: value,
          ...(excludeCustomerId ? { id: { not: excludeCustomerId } } : {}),
        },
        select: { id: true, firstName: true, lastName: true },
      });

      if (existing) {
        throw new ConflictError(
          field === 'email'
            ? 'A customer with that email address already exists here.'
            : 'A customer with that phone number already exists here.',
          {
            field,
            // The id lets the UI offer "open that customer" instead of leaving
            // somebody to search for a record they were just told exists.
            existingCustomerId: existing.id,
            existingCustomerName: [existing.firstName, existing.lastName]
              .filter(Boolean)
              .join(' '),
          },
        );
      }
    }
  }
}

/**
 * The clauses behind the search box.
 *
 * The phone term is normalised the same way stored numbers are, so pasting
 * `+976 9911 2233` out of a message finds the customer saved as
 * `+97699112233`. Without it the search silently fails on the one format
 * people actually paste.
 */
export function customerSearchClauses(search: string): Prisma.CompanyCustomerWhereInput[] {
  const clauses: Prisma.CompanyCustomerWhereInput[] = [
    { firstName: { contains: search, mode: 'insensitive' } },
    { lastName: { contains: search, mode: 'insensitive' } },
    { email: { contains: search, mode: 'insensitive' } },
  ];

  const digits = normalisePhone(search);
  if (digits.replace(/\D/g, '').length >= 3) {
    clauses.push({ phone: { contains: digits } });
  }

  return clauses;
}

function mapDuplicateContact(
  error: unknown,
  email: string | null | undefined,
  phone: string | null | undefined,
): unknown {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return error;
  }

  // Which column collided has to be inferred: `meta.target` is null for a
  // partial index created outside the Prisma schema, so when it says nothing
  // the answer is whichever contact field the request actually supplied.
  const target = JSON.stringify(error.meta?.target ?? '');
  const isEmail = target.includes('email')
    ? true
    : target.includes('phone')
      ? false
      : Boolean(email) || !phone;

  return new ConflictError(
    isEmail
      ? 'A customer with that email address already exists here.'
      : 'A customer with that phone number already exists here.',
    { field: isEmail ? 'email' : 'phone' },
  );
}

function toCustomerResponse(customer: {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  birthDate: Date | null;
  gender: string | null;
  locale: string | null;
  status: string;
  tags: string[];
  preferredEmployeeId: string | null;
  loyaltyPoints: number;
  totalVisits: number;
  totalNoShows: number;
  totalSpentMinor: bigint;
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  preferredEmployee?: { id: string; displayName: string } | null;
  _count?: { appointments: number };
}) {
  return {
    id: customer.id,
    firstName: customer.firstName,
    lastName: customer.lastName,
    /** Composed once here so eight screens do not each join the two halves. */
    fullName: [customer.firstName, customer.lastName].filter(Boolean).join(' '),
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
    notes: customer.notes,
    birthDate: customer.birthDate ? customer.birthDate.toISOString().slice(0, 10) : null,
    gender: customer.gender,
    locale: customer.locale,
    status: customer.status,
    tags: customer.tags,
    preferredEmployeeId: customer.preferredEmployeeId,
    preferredEmployeeName: customer.preferredEmployee?.displayName ?? null,
    loyaltyPoints: customer.loyaltyPoints,
    totalVisits: customer.totalVisits,
    totalNoShows: customer.totalNoShows,
    // Money as a string: the column is BigInt and a lifetime total is exactly
    // the value that must not be rounded.
    totalSpentMinor: customer.totalSpentMinor.toString(),
    firstVisitAt: customer.firstVisitAt,
    lastVisitAt: customer.lastVisitAt,
    appointmentCount: customer._count?.appointments ?? 0,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    // `companyId` is omitted: the caller is already scoped to it, and echoing a
    // tenant key invites a client to start passing it back.
  };
}
