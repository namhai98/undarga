/**
 * Benchmark data: two companies with a realistic volume of history, for
 * measuring queries and endpoints (docs/PERFORMANCE.md).
 *
 *   Company A: 1 branch, 25 staff, 30 services, 20 000 customers,
 *              ~40 000 appointments (18 months past, 2 months ahead;
 *              a third of every staff member's hourly slots), ~20 000 notifications
 *   Company B: a tenth of that — so every query also has rows it must skip
 *
 * Refuses to run unless the target database name ends in `_bench`: it
 * truncates every table first.
 *
 *   MIGRATION_DATABASE_URL=…/undarga_bench ts-node scripts/bench-seed.ts
 */
import { PrismaClient } from '@prisma/client';
import { seedWorld } from '../test/support/seed';

const url = process.env.MIGRATION_DATABASE_URL ?? '';
if (!/\/[a-z0-9_]*_bench(\?|$)/.test(url)) {
  throw new Error(
    'bench-seed truncates every table; MIGRATION_DATABASE_URL must point at a *_bench database.',
  );
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

const HOURS = { opens: '1970-01-01T09:00:00.000Z', closes: '1970-01-01T18:00:00.000Z' };

async function company(companyId: string, branchId: string, scale: number) {
  const employees = Math.max(3, Math.round(25 * scale));
  const services = Math.max(3, Math.round(30 * scale));
  const customers = Math.round(20_000 * scale);
  const pastDays = 540;
  const futureDays = 60;

  await prisma.businessHours.createMany({
    data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
      companyId,
      branchId,
      dayOfWeek,
      opensAt: new Date(HOURS.opens),
      closesAt: new Date(HOURS.closes),
      effectiveFrom: new Date('2024-01-01'),
    })),
  });

  const serviceIds: string[] = [];
  for (let i = 0; i < services; i += 1) {
    const s = await prisma.service.create({
      data: {
        companyId,
        name: `Service ${i + 1}`,
        status: 'ACTIVE',
        durationMin: 45,
        bufferAfterMin: 15,
        priceMinor: BigInt(20_000 + i * 1_000),
        currencyCode: 'MNT',
        requiresEmployee: true,
        isOnlineBookable: true,
      },
    });
    serviceIds.push(s.id);
  }
  await prisma.serviceBranch.createMany({
    data: serviceIds.map((serviceId) => ({ companyId, serviceId, branchId })),
  });

  const employeeIds: string[] = [];
  for (let i = 0; i < employees; i += 1) {
    const e = await prisma.employee.create({
      data: { companyId, displayName: `Staff ${i + 1}`, status: 'ACTIVE', isBookable: true },
    });
    employeeIds.push(e.id);
  }
  await prisma.employeeBranch.createMany({
    data: employeeIds.map((employeeId) => ({ companyId, employeeId, branchId })),
  });
  await prisma.employeeService.createMany({
    data: employeeIds.flatMap((employeeId) =>
      serviceIds.map((serviceId) => ({ companyId, employeeId, serviceId })),
    ),
  });
  await prisma.employeeSchedule.createMany({
    data: employeeIds.flatMap((employeeId) =>
      Array.from({ length: 7 }, (_, dayOfWeek) => ({
        companyId,
        employeeId,
        branchId,
        dayOfWeek,
        startsAt: new Date(HOURS.opens),
        endsAt: new Date(HOURS.closes),
        effectiveFrom: new Date('2024-01-01'),
      })),
    ),
  });

  // Customers: names from a small vocabulary so searches match realistic subsets.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO company_customer (id, company_id, first_name, last_name, email, phone, status, source,
                                  total_visits, created_at, updated_at)
    SELECT gen_random_uuid(), $1::uuid,
           (ARRAY['Bat','Bold','Saraa','Nomin','Temuulen','Anu','Enkh','Tuya','Oyun','Zaya'])[1 + (g % 10)] || (g % 97),
           (ARRAY['Ganbaatar','Dorj','Bayar','Erdene','Sukh','Munkh','Altan','Tseren'])[1 + (g % 8)],
           'customer' || g || '@example.mn',
           '+9769' || lpad((g * 7919 % 10000000)::text, 7, '0'),
           'ACTIVE', 'STAFF', 0,
           now() - (g % 700) * interval '1 day', now()
      FROM generate_series(1, $2::int) g
    `,
    companyId,
    customers,
  );

  // Appointments: each employee works 8 one-hour slots a day; one in three is
  // booked, deterministically, so no two items overlap for an employee.
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS bench_slots');
  await prisma.$executeRawUnsafe(
    `
    CREATE UNLOGGED TABLE bench_slots AS
    WITH ids AS (
           SELECT (SELECT array_agg(id ORDER BY id) FROM service WHERE company_id = $1::uuid) AS svc,
                  (SELECT array_agg(id ORDER BY id) FROM company_customer WHERE company_id = $1::uuid) AS cust
         ),
         slots AS (
           SELECT e.id AS employee_id, e.n AS en, d AS day_offset, h AS hour
             FROM unnest((SELECT array_agg(id ORDER BY id) FROM employee WHERE company_id = $1::uuid))
                  WITH ORDINALITY AS e(id, n),
                  generate_series(-$2::int, $3::int) d,
                  generate_series(0, 7) h
            WHERE (e.n + d + h) % 3 = 0
         )
    SELECT gen_random_uuid() AS appointment_id, s.employee_id,
           (date_trunc('day', now() AT TIME ZONE 'Asia/Ulaanbaatar') + s.day_offset * interval '1 day'
              + (1 + s.hour) * interval '1 hour') AT TIME ZONE 'Asia/Ulaanbaatar' AS starts_at,
           ids.svc[1 + (abs(hashtext(s.employee_id::text || s.day_offset || s.hour)) % cardinality(ids.svc))] AS service_id,
           ids.cust[1 + (abs(hashtext(s.day_offset || '-' || s.hour || '-' || s.en)) % cardinality(ids.cust))] AS customer_id,
           s.day_offset,
           abs(hashtext(s.employee_id::text || s.day_offset || s.hour)) % 100 AS roll,
           row_number() OVER () AS seq
      FROM slots s, ids
    `,
    companyId,
    pastDays,
    futureDays,
  );
  return { employees, services, customers };
}

/** Appointments, items and notifications from bench_slots. */
async function appointmentsFromSlots(companyId: string, branchId: string) {
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO appointment (id, company_id, branch_id, customer_id, appointment_number, status, payment_status,
                             source, starts_at, ends_at, booked_timezone_name, subtotal_minor, total_minor,
                             currency_code, created_by_type, cancelled_at, completed_at, created_at, updated_at)
    SELECT b.appointment_id, $1::uuid, $2::uuid, b.customer_id,
           'APT-B-' || lpad(b.seq::text, 9, '0'),
           (CASE WHEN b.day_offset >= 0 THEN (CASE WHEN b.roll < 10 THEN 'PENDING' ELSE 'CONFIRMED' END)
                 WHEN b.roll < 10 THEN 'CANCELLED' WHEN b.roll < 15 THEN 'NO_SHOW' ELSE 'COMPLETED' END)::appointment_status,
           (CASE WHEN b.day_offset < 0 AND b.roll >= 15 THEN 'PAID' ELSE 'UNPAID' END)::appointment_payment_status,
           (CASE WHEN b.roll % 2 = 0 THEN 'ONLINE' ELSE 'STAFF' END)::booking_source,
           b.starts_at, b.starts_at + interval '45 minutes', 'Asia/Ulaanbaatar',
           s.price_minor, s.price_minor, 'MNT', 'COMPANY_USER',
           CASE WHEN b.day_offset < 0 AND b.roll < 10 THEN b.starts_at - interval '1 day' END,
           CASE WHEN b.day_offset < 0 AND b.roll >= 15 THEN b.starts_at + interval '45 minutes' END,
           b.starts_at - interval '7 days', now()
      FROM bench_slots b JOIN service s ON s.id = b.service_id
    `,
    companyId,
    branchId,
  );
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO appointment_item (id, company_id, appointment_id, branch_id, service_id, employee_id, status,
                                  starts_at, ends_at, duration_min, buffer_after_min, blocks_calendar,
                                  unit_price_minor, total_minor, snapshot, created_at, updated_at)
    SELECT gen_random_uuid(), $1::uuid, a.id, $2::uuid, b.service_id, b.employee_id, a.status,
           a.starts_at, a.ends_at, 45, 15, a.status NOT IN ('CANCELLED', 'NO_SHOW', 'EXPIRED'),
           a.subtotal_minor, a.total_minor,
           jsonb_build_object('serviceName', 'Service', 'durationMin', 45, 'priceMinor', a.subtotal_minor::text, 'currencyCode', 'MNT'),
           a.created_at, now()
      FROM bench_slots b JOIN appointment a ON a.id = b.appointment_id
    `,
    companyId,
    branchId,
  );
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO notification (id, company_id, channel, type, status, recipient_type, recipient_id,
                              recipient_address, appointment_id, scheduled_for, sent_at, created_at, updated_at)
    SELECT gen_random_uuid(), $1::uuid, 'EMAIL', 'appointment.confirmed',
           (CASE WHEN a.starts_at < now() THEN 'SENT' ELSE 'PENDING' END)::notification_status,
           'CUSTOMER', a.customer_id, 'customer@example.mn', a.id,
           a.created_at, CASE WHEN a.starts_at < now() THEN a.created_at END, a.created_at, now()
      FROM appointment a
     WHERE a.company_id = $1::uuid AND a.id IN (SELECT appointment_id FROM bench_slots) AND (abs(hashtext(a.id::text)) % 2) = 0
    `,
    companyId,
  );
}

async function main() {
  const started = Date.now();
  const world = await seedWorld(prisma);
  const summary: Record<string, unknown> = {};
  for (const [label, c, scale] of [
    ['A', world.companyA, 1],
    ['B', world.companyB, 0.1],
  ] as const) {
    summary[label] = await company(c.id, c.branchId, scale);
    await appointmentsFromSlots(c.id, c.branchId);
    await prisma.$executeRawUnsafe('DROP TABLE bench_slots');
  }
  await prisma.$executeRawUnsafe('ANALYZE');
  const totals = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(
    `SELECT (SELECT count(*) FROM appointment) AS appointments, (SELECT count(*) FROM appointment_item) AS items,
            (SELECT count(*) FROM company_customer) AS customers, (SELECT count(*) FROM notification) AS notifications`,
  );
  console.log('companies', summary);
  console.log(
    'rows',
    Object.fromEntries(Object.entries(totals[0] ?? {}).map(([k, v]) => [k, Number(v)])),
  );
  console.log(`company A: ${world.companyA.id}  branch ${world.companyA.branchId}`);
  console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
