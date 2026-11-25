/**
 * Set up (or replace) a platform operator's second factor.
 *
 *   PLATFORM_ADMIN_EMAIL=ops@example.com \
 *   SECRETS_ENCRYPTION_KEY=… \
 *   MIGRATION_DATABASE_URL=… \
 *   npx ts-node --transpile-only scripts/platform-mfa.ts
 *
 * Prints an otpauth:// link and the secret ONCE: add it to an authenticator
 * app straight away. The secret is stored sealed with SECRETS_ENCRYPTION_KEY,
 * exactly as the API stores it. Run it again for an operator who lost their
 * phone — the old secret stops working at once.
 *
 * Also used by create-platform-admin.ts, so the first operator never exists
 * without a second factor.
 */
import { PrismaClient } from '@prisma/client';
import { SecretBox } from '../src/common/crypto/secret-box';
import { generateTotpSecret, otpauthUri } from '../src/auth/totp';

export async function enrolPlatformMfa(
  prisma: PrismaClient,
  platformUserId: string,
  email: string,
) {
  const box = new SecretBox(process.env.SECRETS_ENCRYPTION_KEY ?? null);
  if (!box.available) {
    throw new Error('SECRETS_ENCRYPTION_KEY must be set (32 random bytes, base64) to enrol MFA.');
  }
  const secret = generateTotpSecret();
  await prisma.platformUser.update({
    where: { id: platformUserId },
    data: {
      // The same AAD the API uses, so the API can open it.
      mfaSecret: box.seal(secret, `platform-mfa:${platformUserId}`),
      mfaEnrolledAt: new Date(),
      mfaLastStep: null,
    },
  });
  console.log('');
  console.log('Two-factor authentication — add this to an authenticator app NOW.');
  console.log('It is shown only once.');
  console.log(`  Link:   ${otpauthUri('Undarga Platform', email, secret)}`);
  console.log(`  Secret: ${secret}`);
  console.log('');
}

async function main() {
  const email = (process.env.PLATFORM_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
  if (!email) throw new Error('set PLATFORM_ADMIN_EMAIL.');
  if (!url) throw new Error('set MIGRATION_DATABASE_URL (or PLATFORM_DATABASE_URL).');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const user = await prisma.platformUser.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`no platform user ${email}.`);
    await enrolPlatformMfa(prisma, user.id, user.email);
    console.log(`MFA set for ${user.email}. Any previous authenticator entry no longer works.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`platform-mfa: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
