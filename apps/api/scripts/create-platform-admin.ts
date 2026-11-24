/**
 * Create the first Platform Admin (SUPER_ADMIN) of a new installation.
 *
 *   PLATFORM_ADMIN_EMAIL=ops@example.com \
 *   PLATFORM_ADMIN_NAME="Operations" \
 *   PLATFORM_ADMIN_PASSWORD='…at least 12 characters…' \
 *   MIGRATION_DATABASE_URL=… \
 *   npx ts-node --transpile-only scripts/create-platform-admin.ts
 *
 * The password is read from the environment, never from the command line, so
 * it does not land in shell history or the process list. Unset it afterwards.
 *
 * Refuses when a SUPER_ADMIN already exists: this is for bootstrapping an
 * empty installation, not for managing operators. Run scripts/migrate-deploy.sh
 * first (it seeds the SUPER_ADMIN role this assigns).
 *
 * Platform sign-in does not yet enforce MFA (docs/SECURITY.md): use a long,
 * unique password and keep the number of SUPER_ADMIN accounts minimal.
 */
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const email = (process.env.PLATFORM_ADMIN_EMAIL ?? '').trim().toLowerCase();
const fullName = (process.env.PLATFORM_ADMIN_NAME ?? '').trim();
const password = process.env.PLATFORM_ADMIN_PASSWORD ?? '';
const minLength = Math.max(12, Number(process.env.PASSWORD_MIN_LENGTH ?? 12));

function fail(message: string): never {
  console.error(`create-platform-admin: ${message}`);
  process.exit(1);
}

async function main() {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    fail('set PLATFORM_ADMIN_EMAIL to a valid address.');
  if (!fullName) fail('set PLATFORM_ADMIN_NAME.');
  if (password.length < minLength || password.length > 512) {
    fail(`PLATFORM_ADMIN_PASSWORD must be ${minLength}–512 characters.`);
  }
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
  if (!url) fail('set MIGRATION_DATABASE_URL (or PLATFORM_DATABASE_URL).');

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const role = await prisma.platformRole.findUnique({ where: { key: 'SUPER_ADMIN' } });
    if (!role)
      fail('the SUPER_ADMIN role does not exist yet; run scripts/migrate-deploy.sh first.');

    const existing = await prisma.platformUserRole.count({
      where: { roleId: role.id, platformUser: { deletedAt: null } },
    });
    if (existing > 0) {
      fail('a SUPER_ADMIN already exists. Manage further operators from the platform console.');
    }
    if (await prisma.platformUser.findFirst({ where: { email }, select: { id: true } })) {
      fail(`a platform user ${email} already exists.`);
    }

    // The same argon2id parameters the API uses (ARGON2_* env, same defaults).
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: Number(process.env.ARGON2_MEMORY_KIB ?? 19456),
      timeCost: Number(process.env.ARGON2_TIME_COST ?? 2),
      parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
    });

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.platformUser.create({
        data: { email, fullName, passwordHash, status: 'ACTIVE' },
        select: { id: true, email: true },
      });
      await tx.platformUserRole.create({ data: { platformUserId: created.id, roleId: role.id } });
      // No audit_log row from here: that table is hash-chained by the API's
      // AuditService, and a row written outside it would break verification.
      // The account's created_at and this script's output are the record.
      return created;
    });

    console.log(`Created SUPER_ADMIN ${user.email} (${user.id}). Sign in at /platform.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
