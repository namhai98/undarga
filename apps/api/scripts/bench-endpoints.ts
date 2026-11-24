/**
 * Endpoint benchmark against the benchmark database (docs/PERFORMANCE.md).
 *
 * Boots the real application in-process — guards, row-level security, tenant
 * transactions and all — and calls each endpoint sequentially. For every
 * endpoint it reports latency (p50 / p95 / mean over the measured runs) and
 * how many SQL statements one request executes, which is what exposes N+1
 * patterns. The slowest individual statements are written out for EXPLAIN.
 *
 *   (bench database URLs in the environment)
 *   ts-node --transpile-only scripts/bench-endpoints.ts [label] [runs]
 *
 * Writes bench-results/<label>.json next to this package.
 */
import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// --- count every SQL statement Prisma sends ---------------------------------
interface QueryEvent {
  query: string;
  params: string;
  duration: number;
}
const counter = { statements: 0, sqlMs: 0, slow: [] as Array<QueryEvent & { endpoint: string }> };
let currentEndpoint = '';
const trace = { active: false };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const prismaModule = require('@prisma/client') as {
  PrismaClient: new (o?: Record<string, unknown>) => unknown;
};
const Original = prismaModule.PrismaClient;
class CountingPrismaClient extends (Original as new (o?: Record<string, unknown>) => {
  $on(event: 'query', cb: (e: QueryEvent) => void): void;
}) {
  constructor(options: Record<string, unknown> = {}) {
    const log: unknown[] = Array.isArray(options.log) ? (options.log as unknown[]) : [];
    super({ ...options, log: [...log, { emit: 'event', level: 'query' }] });
    this.$on('query', (e) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|SELECT 1)$/i.test(e.query.trim())) return;
      counter.statements += 1;
      counter.sqlMs += e.duration;
      if (currentEndpoint && e.duration >= 5)
        counter.slow.push({ ...e, endpoint: currentEndpoint });
      // BENCH_TRACE=<endpoint substring>: print every statement of that endpoint's first measured run.
      if (trace.active) {
        const sql = e.query
          .replace(/"public"\./g, '')
          .replace(/\s+/g, ' ')
          .trim();
        console.log(`  [${e.duration}ms] ${sql.slice(0, 230)}`);
      }
    });
  }
}
prismaModule.PrismaClient = CountingPrismaClient;

process.env.THROTTLE_ENABLED = 'false';

if (!/\/[a-z0-9_]*_bench(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  throw new Error(
    'bench-endpoints measures the benchmark database; DATABASE_URL must point at a *_bench database.',
  );
}

async function main() {
  const label = process.argv[2] ?? 'run';
  const runs = Number(process.argv[3] ?? 30);

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module');
  const { AppConfig } = await import('../src/config');
  const { configureApp } = await import('../src/bootstrap/configure-app');
  const { AuthService } = await import('../src/auth/auth.service');
  const request = (await import('supertest')).default;
  const { PrismaClient } = await import('@prisma/client');

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  configureApp(app as never, app.get(AppConfig));
  await app.init();
  const http = app.getHttpServer() as import('node:http').Server;

  const owner = new PrismaClient({
    datasources: { db: { url: process.env.MIGRATION_DATABASE_URL } },
  }) as unknown as {
    $queryRawUnsafe<T>(q: string, ...p: unknown[]): Promise<T>;
    $disconnect(): Promise<void>;
  };
  const [ctx] = await owner.$queryRawUnsafe<Array<Record<string, string>>>(`
    SELECT c.id AS company, c.slug, b.id AS branch,
           (SELECT id FROM service WHERE company_id = c.id ORDER BY created_at LIMIT 1) AS service,
           (SELECT id FROM employee WHERE company_id = c.id ORDER BY created_at LIMIT 1) AS employee,
           (SELECT id FROM company_customer WHERE company_id = c.id AND total_visits = 0 ORDER BY created_at DESC LIMIT 1) AS customer,
           (SELECT id FROM appointment WHERE company_id = c.id AND starts_at > now() ORDER BY starts_at LIMIT 1) AS appointment
      FROM company c JOIN branch b ON b.company_id = c.id WHERE c.slug = 'company-a' LIMIT 1`);
  await owner.$disconnect();
  if (!ctx) throw new Error('Run scripts/bench-seed.ts first.');

  const auth = app.get(AuthService);
  const session = await auth.loginStaff('user-a@example.com', 'correct-horse-battery-staple');
  const token = session.accessToken;

  const day = (offset: number) => {
    const d = new Date(Date.now() + offset * 86_400_000);
    return d.toISOString().slice(0, 10);
  };
  const A = `/api/v1/companies/${ctx.company}`;
  const P = `/api/v1/public/companies/${ctx.slug}`;
  const endpoints: Array<[string, string, boolean]> = [
    ['dashboard', `${A}/dashboard`, true],
    ['report: appointments 90d', `${A}/reports/appointments?from=${day(-90)}&to=${day(0)}`, true],
    ['report: revenue 90d', `${A}/reports/revenue?from=${day(-90)}&to=${day(0)}`, true],
    ['report: customers 90d', `${A}/reports/customers?from=${day(-90)}&to=${day(0)}`, true],
    ['report: services 90d', `${A}/reports/services?from=${day(-90)}&to=${day(0)}`, true],
    ['appointments: next 7 days', `${A}/appointments?from=${day(0)}&to=${day(7)}&limit=50`, true],
    ['appointments: default list', `${A}/appointments`, true],
    ['appointments: search', `${A}/appointments?search=Saraa`, true],
    ['appointment detail', `${A}/appointments/${ctx.appointment}`, true],
    ['customers: list', `${A}/customers?limit=25`, true],
    ['customers: search name', `${A}/customers?search=Nomin4`, true],
    ['customers: search phone', `${A}/customers?search=97691234`, true],
    ['customer detail', `${A}/customers/${ctx.customer}`, true],
    [
      'availability: day, all staff',
      `${A}/availability?branchId=${ctx.branch}&serviceId=${ctx.service}&date=${day(1)}`,
      true,
    ],
    [
      'availability: day, one employee',
      `${A}/availability?branchId=${ctx.branch}&serviceId=${ctx.service}&date=${day(1)}&employeeId=${ctx.employee}`,
      true,
    ],
    ['services list', `${A}/services`, true],
    ['employees list', `${A}/employees`, true],
    ['notifications list', `${A}/notifications`, true],
    ['public: company page', `${P}`, false],
    ['public: services', `${P}/branches/${ctx.branch}/services`, false],
    [
      'public: availability',
      `${P}/availability?branchId=${ctx.branch}&serviceId=${ctx.service}&date=${day(1)}`,
      false,
    ],
  ];

  const results: Array<Record<string, unknown>> = [];
  for (const [name, path, authed] of endpoints) {
    // BENCH_ONLY=<endpoint substring>: measure just the matching endpoints (e.g. under --cpu-prof).
    if (process.env.BENCH_ONLY && !name.includes(process.env.BENCH_ONLY)) continue;
    const call = () => {
      const r = request(http).get(path);
      return authed ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    // Warm-up: JIT, connection pool, Prisma query engine plans.
    let status = 0;
    for (let i = 0; i < 3; i += 1) status = (await call()).status;
    const times: number[] = [];
    const statements: number[] = [];
    currentEndpoint = name;
    for (let i = 0; i < runs; i += 1) {
      trace.active =
        i === 0 && Boolean(process.env.BENCH_TRACE) && name.includes(process.env.BENCH_TRACE ?? '');
      const before = counter.statements;
      const started = process.hrtime.bigint();
      const res = await call();
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
      statements.push(counter.statements - before);
      status = res.status;
    }
    currentEndpoint = '';
    times.sort((a, b) => a - b);
    const pct = (p: number) =>
      times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))]!;
    const row = {
      endpoint: name,
      status,
      p50: +pct(50).toFixed(1),
      p95: +pct(95).toFixed(1),
      mean: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1),
      statements: Math.round(statements.reduce((a, b) => a + b, 0) / statements.length),
    };
    results.push(row);
    console.log(
      `${name.padEnd(34)} ${String(status).padEnd(4)} p50 ${String(row.p50).padStart(7)}ms  p95 ${String(row.p95).padStart(7)}ms  sql/req ${row.statements}`,
    );
  }

  const slowest = [...counter.slow]
    .sort((a, b) => b.duration - a.duration)
    .filter((q, i, all) => all.findIndex((o) => o.query === q.query) === i)
    .slice(0, 15)
    .map((q) => ({ endpoint: q.endpoint, ms: q.duration, query: q.query, params: q.params }));

  const dir = join(__dirname, '..', 'bench-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${label}.json`),
    JSON.stringify(
      { label, runs, at: new Date().toISOString(), node: process.version, results, slowest },
      null,
      2,
    ),
  );
  console.log(`\nwrote bench-results/${label}.json`);
  await app.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
