// EXPLAIN ANALYZE captured statements as the tenant role (RLS active).
//   node scripts/bench-explain.cjs <bench-results/x.json> <endpoint-substring> <companyId>
// See docs/PERFORMANCE.md.
const { PrismaClient } = require('@prisma/client');
const results = require(process.argv[2]);
const match = process.argv[3] || '';
const companyId = process.argv[4];
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `'{${v.map((x) => `"${String(x)}"`).join(',')}}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

(async () => {
  const seen = new Set();
  for (const q of results.slowest) {
    if (match && !q.endpoint.includes(match)) continue;
    if (seen.has(q.query)) continue;
    seen.add(q.query);
    const params = JSON.parse(q.params);
    let sql = q.query;
    for (let i = params.length; i >= 1; i -= 1) sql = sql.split(`$${i}`).join(literal(params[i - 1]));
    try {
      const plan = await p.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.current_company_id', '${companyId}', true)`);
        return tx.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`);
      });
      console.log(`\n===== [${q.endpoint}] captured ${q.ms}ms\n${sql.replace(/"public"\./g, '').replace(/\s+/g, ' ').slice(0, 400)}`);
      console.log(plan.map((r) => r['QUERY PLAN']).join('\n'));
    } catch (e) {
      console.log(`\n===== [${q.endpoint}] could not explain: ${e.message.split('\n').slice(-2).join(' ')}`);
    }
  }
  await p.$disconnect();
})();
