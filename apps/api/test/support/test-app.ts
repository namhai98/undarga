import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { ProbeModule } from './probe.module';
import { TEST_PASSWORD } from './seed';

export interface TestHarness {
  app: INestApplication;
  /** Owner connection, used by the seeder. Bypasses RLS by design. */
  prisma: PrismaClient;
  close(): Promise<void>;
  /** Sign in and return the bearer token for a staff user. */
  staffToken(email: string): Promise<string>;
  /** Sign in and return the bearer token for a platform operator. */
  platformToken(email: string): Promise<string>;
  /** Sign in, switch to a company, and return the resulting token. */
  staffTokenForCompany(email: string, companyId: string): Promise<string>;
}

/**
 * Boots the real application.
 *
 * The whole point of this suite is that the guards, the resolver chain, the
 * membership check and the Prisma extension are the shipped ones. Nothing is
 * overridden except the addition of ProbeModule, which contributes controllers
 * and no behaviour.
 */
export async function createTestHarness(): Promise<TestHarness> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ProbeModule],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const auth = app.get(AuthService);

  const prisma = new PrismaClient({
    datasources: {
      db: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL },
    },
  });
  await prisma.$connect();

  return {
    app,
    prisma,

    async close() {
      await prisma.$disconnect();
      await app.close();
    },

    async staffToken(email: string) {
      const session = await auth.loginStaff(email, TEST_PASSWORD);
      return session.accessToken;
    },

    async platformToken(email: string) {
      const session = await auth.loginPlatform(email, TEST_PASSWORD);
      return session.accessToken;
    },

    async staffTokenForCompany(email: string, companyId: string) {
      const session = await auth.loginStaff(email, TEST_PASSWORD);
      if (session.activeCompanyId === companyId) return session.accessToken;

      // Decode without verifying: this is test plumbing extracting the session
      // id, not an authorization decision.
      const claims = JSON.parse(
        Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { sub: string; sid: string };

      const switched = await auth.switchCompany(claims.sub, claims.sid, companyId);
      return switched.accessToken;
    },
  };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
