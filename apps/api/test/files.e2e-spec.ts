import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { SYSTEM_ROLES } from '../src/authz/permissions';
import { FileCleanupService } from '../src/media/file-cleanup.service';
import { PURPOSES } from '../src/media/file-purposes';
import { StorageService } from '../src/media/storage/storage.service';
import { UPLOAD_TMP_DIR } from '../src/media/upload.interceptor';
import { createTestHarness, type TestHarness } from './support/test-app';
import { seedWorld, type SeededWorld } from './support/seed';

/**
 * ===========================================================================
 * FILES & MEDIA
 * ===========================================================================
 *
 * Real uploads through the real pipeline: multipart → temp file → content
 * checks → re-encode → local storage (a temp directory, test-env.ts) →
 * attached to its record. Images are generated with sharp, so they are real.
 */
describe('files and media', () => {
  let harness: TestHarness;
  let http: Server;
  let world: SeededWorld;
  let ownerA: string;
  let ownerB: string;
  let storage: StorageService;
  let unique = 0;
  const root = process.env.STORAGE_LOCAL_ROOT!;

  const api = (path: string, companyId = world.companyA.id) => `/api/v1/companies/${companyId}/${path}`;
  const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;

  async function png(width = 400, height = 300, background = '#336699') {
    return sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();
  }

  function upload(
    token: string | null,
    fields: { purpose: string; targetId?: string },
    file: { bytes: Buffer; name?: string; type?: string } | null,
    companyId = world.companyA.id,
  ) {
    let req = request(http).post(api('files', companyId));
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    req = req.field('purpose', fields.purpose);
    if (fields.targetId) req = req.field('targetId', fields.targetId);
    if (file) req = req.attach('file', file.bytes, { filename: file.name ?? 'image.png', contentType: file.type ?? 'image/png' });
    return req;
  }

  async function member(roleKey: string) {
    const known = await harness.prisma.userAccount.findFirstOrThrow({ where: { id: world.userA.id } });
    const account = await harness.prisma.userAccount.create({
      data: {
        email: `files-${roleKey.toLowerCase()}-${Date.now()}-${unique++}@example.com`,
        fullName: roleKey,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: known.passwordHash,
      },
    });
    const membership = await harness.prisma.companyUser.create({
      data: { companyId: world.companyA.id, userAccountId: account.id, status: 'ACTIVE' },
    });
    const role = await harness.prisma.companyRole.findFirstOrThrow({ where: { companyId: world.companyA.id, key: roleKey } });
    await harness.prisma.companyUserRole.create({ data: { companyId: world.companyA.id, companyUserId: membership.id, roleId: role.id } });
    return harness.staffTokenForCompany(account.email, world.companyA.id);
  }

  const fileRow = (id: string) => harness.prisma.file.findUniqueOrThrow({ where: { id } });
  const objectExists = async (id: string) => existsSync(join(root, ...(await fileRow(id)).storageKey.split('/')));
  const rows = () => harness.prisma.file.count();

  beforeAll(async () => {
    harness = await createTestHarness();
    http = harness.app.getHttpServer() as Server;
    world = await seedWorld(harness.prisma);
    ownerA = await harness.staffTokenForCompany(world.userA.email, world.companyA.id);
    ownerB = await harness.staffTokenForCompany(world.userB.email, world.companyB.id);
    storage = harness.app.get(StorageService);
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await harness.close();
  });

  // ===========================================================================
  describe('uploading', () => {
    it('stores a branch image, attaches it, and serves it publicly', async () => {
      const res = await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png(), name: 'front.png' }).expect(201);
      const file = res.body.data;
      expect(file).toMatchObject({
        purpose: 'BRANCH_IMAGE',
        targetId: world.companyA.branchId,
        visibility: 'PUBLIC',
        mimeType: 'image/png',
        width: 400,
        height: 300,
        fileName: 'front.png',
        urlExpiresAt: null,
      });
      expect(file.url).toBe(`https://api.undarga.test/api/v1/public/files/${file.id}`);

      const branch = await request(http).get(api(`branches/${world.companyA.branchId}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(branch.body.data.imageFileId).toBe(file.id);

      const stored = await fileRow(file.id);
      expect(stored).toMatchObject({ status: 'READY', storageProvider: 'local', deletedAt: null });
      expect(stored.storageKey).toMatch(new RegExp(`^public/${world.companyA.id}/branch_image/[0-9a-f-]{36}\\.png$`));
      expect(stored.storageKey).not.toContain('front');
      expect(await objectExists(file.id)).toBe(true);

      const served = await request(http).get(pathOf(file.url)).buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      }).expect(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['cache-control']).toContain('immutable');
      expect((await sharp(served.body as Buffer).metadata()).width).toBe(400);
      // Conditional request.
      await request(http).get(pathOf(file.url)).set('If-None-Match', served.headers.etag!).expect(304);
    });

    it('attaches a logo, a staff photo and a service image to their records', async () => {
      const logo = (await upload(ownerA, { purpose: 'COMPANY_LOGO' }, { bytes: await png(256, 256) }).expect(201)).body.data;
      const branding = await request(http).get(api('branding')).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(branding.body.data.logoFileId).toBe(logo.id);

      const employee = await harness.prisma.employee.create({
        data: { companyId: world.companyA.id, displayName: `Photo ${unique++}`, status: 'ACTIVE', isBookable: true },
      });
      const photo = (await upload(ownerA, { purpose: 'EMPLOYEE_PHOTO', targetId: employee.id }, { bytes: await png(300, 300) }).expect(201)).body.data;
      const detail = await request(http).get(api(`employees/${employee.id}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(detail.body.data.publicProfile.avatarFileId).toBe(photo.id);

      const service = await harness.prisma.service.create({
        data: { companyId: world.companyA.id, name: `Svc ${unique++}`, status: 'ACTIVE', durationMin: 30, priceMinor: 100n, currencyCode: 'MNT' },
      });
      const image = (await upload(ownerA, { purpose: 'SERVICE_IMAGE', targetId: service.id }, { bytes: await png(800, 600) }).expect(201)).body.data;
      const svc = await request(http).get(api(`services/${service.id}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(svc.body.data.imageFileId).toBe(image.id);
    });

    it('replaces an image and deletes the old one, from the table and from storage', async () => {
      const first = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(201)).body.data;
      const second = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png(500, 400, '#aa3300') }).expect(201)).body.data;

      const old = await fileRow(first.id);
      expect(old.deletedAt).not.toBeNull();
      expect(old.purgedAt).not.toBeNull();
      expect(await objectExists(first.id)).toBe(false);
      await request(http).get(pathOf(first.url)).expect(404);
      await request(http).get(pathOf(second.url)).expect(200);
    });

    it('removes an image on request, but only detaches one still used elsewhere', async () => {
      const file = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(201)).body.data;
      // Something else uses the same file (e.g. reused for a service).
      const service = await harness.prisma.service.create({
        data: { companyId: world.companyA.id, name: `Shared ${unique++}`, status: 'ACTIVE', durationMin: 30, priceMinor: 100n, currencyCode: 'MNT', imageFileId: file.id },
      });
      const res = await request(http).delete(api(`files/${file.id}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(res.body.data).toEqual({ removed: true, deleted: false });
      expect((await harness.prisma.branch.findUniqueOrThrow({ where: { id: world.companyA.branchId } })).imageFileId).toBeNull();
      expect(await objectExists(file.id)).toBe(true);
      await request(http).get(pathOf(file.url)).expect(200);

      // Once nothing uses it, removing it deletes it.
      await harness.prisma.service.update({ where: { id: service.id }, data: { imageFileId: null } });
      await harness.prisma.branch.update({ where: { id: world.companyA.branchId }, data: { imageFileId: file.id } });
      const gone = await request(http).delete(api(`files/${file.id}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(gone.body.data).toEqual({ removed: true, deleted: true });
      expect(await objectExists(file.id)).toBe(false);
      await request(http).get(pathOf(file.url)).expect(404);
    });
  });

  // ===========================================================================
  describe('validation', () => {
    const before = async () => ({ rows: await rows(), temp: (await readdir(UPLOAD_TMP_DIR)).length });

    it('refuses an oversized file before reading it all, and leaves nothing behind', async () => {
      const start = await before();
      const huge = Buffer.concat([await png(), Buffer.alloc(5 * 1024 * 1024)]);
      const res = await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: huge });
      expect(res.status).toBe(413);
      expect(res.body.error.code).toBe('FILE_TOO_LARGE');
      expect(await before()).toEqual(start);
    });

    it('judges by content: wrong bytes, fake images and out-of-range sizes are refused', async () => {
      const start = await before();
      const target = { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId };
      const cases: Array<[{ bytes: Buffer; name?: string; type?: string }, number, string]> = [
        [{ bytes: Buffer.from('just text, called a png'), name: 'x.png' }, 415, 'FILE_TYPE_NOT_ALLOWED'],
        [{ bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), name: 'x.svg', type: 'image/svg+xml' }, 415, 'FILE_TYPE_NOT_ALLOWED'],
        [{ bytes: await png(), name: 'x.exe', type: 'application/x-msdownload' }, 415, 'FILE_TYPE_NOT_ALLOWED'],
        [{ bytes: await png(), name: 'payload.php' }, 415, 'FILE_TYPE_NOT_ALLOWED'],
        [{ bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 0x41)]), name: 'x.jpg', type: 'image/jpeg' }, 422, 'FILE_INVALID'],
        [{ bytes: await png(50, 50) }, 422, 'FILE_INVALID'], // below the branch minimum
      ];
      for (const [file, status, code] of cases) {
        const res = await upload(ownerA, target, file);
        expect([file.name, res.status, res.body.error?.code]).toEqual([file.name, status, code]);
      }
      expect(await before()).toEqual(start);
    });

    it('needs a purpose, a file and a real target', async () => {
      await upload(ownerA, { purpose: 'ANYTHING' }, { bytes: await png() }).expect(400);
      await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, null).expect(400);
      await upload(ownerA, { purpose: 'BRANCH_IMAGE' }, { bytes: await png() }).expect(400);
      await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: '018f0000-0000-7000-8000-00000000dead' }, { bytes: await png() }).expect(404);
    });
  });

  // ===========================================================================
  describe('access control', () => {
    it('rejects anonymous uploads, and uploads without the purpose’s permission', async () => {
      const bytes = await png();
      await upload(null, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes }).expect(401);
      for (const role of [SYSTEM_ROLES.READ_ONLY, SYSTEM_ROLES.EMPLOYEE]) {
        const token = await member(role);
        await upload(token, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes }).expect(403);
      }
      // A receptionist may set a customer's photo, but not the company logo.
      const receptionist = await member(SYSTEM_ROLES.RECEPTIONIST);
      await upload(receptionist, { purpose: 'COMPANY_LOGO' }, { bytes }).expect(403);
      await upload(receptionist, { purpose: 'CUSTOMER_PHOTO', targetId: world.companyA.customerId }, { bytes }).expect(201);
    });

    it('keeps each company’s files to itself', async () => {
      const file = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(201)).body.data;
      // Company B's owner at company A's URLs.
      await upload(ownerB, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(404);
      await request(http).get(api(`files/${file.id}`)).set('Authorization', `Bearer ${ownerB}`).expect(404);
      // At its own URLs, with A's ids.
      await upload(ownerB, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }, world.companyB.id).expect(404);
      await request(http).get(api(`files/${file.id}`, world.companyB.id)).set('Authorization', `Bearer ${ownerB}`).expect(404);
      await request(http).delete(api(`files/${file.id}`, world.companyB.id)).set('Authorization', `Bearer ${ownerB}`).expect(404);
      expect((await fileRow(file.id)).deletedAt).toBeNull();
    });

    it('lets only writers delete', async () => {
      const file = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(201)).body.data;
      const reader = await member(SYSTEM_ROLES.READ_ONLY);
      await request(http).get(api(`files/${file.id}`)).set('Authorization', `Bearer ${reader}`).expect(200);
      await request(http).delete(api(`files/${file.id}`)).set('Authorization', `Bearer ${reader}`).expect(403);
      expect((await fileRow(file.id)).deletedAt).toBeNull();
    });
  });

  // ===========================================================================
  describe('private files', () => {
    it('serves a customer photo only through a short-lived signed URL', async () => {
      const file = (await upload(ownerA, { purpose: 'CUSTOMER_PHOTO', targetId: world.companyA.customerId }, { bytes: await png(200, 200) }).expect(201)).body.data;
      expect(file.visibility).toBe('PRIVATE');
      expect((await fileRow(file.id)).storageKey.startsWith(`private/${world.companyA.id}/customer_photo/`)).toBe(true);

      // Not public.
      await request(http).get(`/api/v1/public/files/${file.id}`).expect(404);

      const meta = await request(http).get(api(`files/${file.id}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(meta.body.data.url).toMatch(/^https:\/\/api\.undarga\.test\/api\/v1\/files\/signed\//);
      expect(new Date(meta.body.data.urlExpiresAt).getTime()).toBeGreaterThan(Date.now());
      const signedPath = pathOf(meta.body.data.url as string);
      const got = await request(http).get(signedPath).expect(200);
      expect(got.headers['content-type']).toBe('image/png');
      expect(got.headers['cache-control']).toContain('no-store');

      // Tampered, or for another key: refused.
      const tampered = signedPath.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
      await request(http).get(tampered).expect(404);
      await request(http).get('/api/v1/files/signed/not-a-token').expect(404);

      const customer = await request(http).get(api(`customers/${world.companyA.customerId}`)).set('Authorization', `Bearer ${ownerA}`).expect(200);
      expect(customer.body.data.photoFileId).toBe(file.id);
    });
  });

  // ===========================================================================
  describe('failures and cleanup', () => {
    it('saves nothing when storage fails, and keeps the existing image', async () => {
      const current = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(201)).body.data;
      jest.spyOn(storage.local, 'put').mockRejectedValueOnce(new Error('disk full'));
      const res = await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png(600, 400) });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain('disk full');
      expect((await harness.prisma.branch.findUniqueOrThrow({ where: { id: world.companyA.branchId } })).imageFileId).toBe(current.id);
      const failed = await harness.prisma.file.findFirstOrThrow({ where: { width: 600, purpose: 'BRANCH_IMAGE' }, orderBy: { createdAt: 'desc' } });
      expect(failed.deletedAt).not.toBeNull();
      expect(await objectExists(current.id)).toBe(true);
    });

    it('deletes the stored object when attaching fails', async () => {
      jest.spyOn(PURPOSES.BRANCH_IMAGE.slot, 'swap').mockRejectedValueOnce(new Error('database went away'));
      const res = await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png(700, 400) });
      expect(res.status).toBe(500);
      const failed = await harness.prisma.file.findFirstOrThrow({ where: { width: 700 }, orderBy: { createdAt: 'desc' } });
      expect(failed.deletedAt).not.toBeNull();
      expect(await objectExists(failed.id)).toBe(false);
    });

    it('sweeps abandoned uploads, unreferenced files and unpurged objects — never one in use', async () => {
      const inUse = (await upload(ownerA, { purpose: 'BRANCH_IMAGE', targetId: world.companyA.branchId }, { bytes: await png() }).expect(201)).body.data;
      const orphan = (await upload(ownerA, { purpose: 'CUSTOMER_PHOTO', targetId: world.companyA.customerId }, { bytes: await png(200, 200) }).expect(201)).body.data;
      // Its record lets go of it outside the files API (e.g. a hard delete elsewhere).
      await harness.prisma.companyCustomer.update({ where: { id: world.companyA.customerId }, data: { photoFileId: null } });
      // A crashed upload: UPLOADING row, object written, never attached.
      const crashed = await harness.prisma.file.create({
        data: {
          companyId: world.companyA.id,
          storageKey: `public/${world.companyA.id}/branch_image/018f0000-0000-7000-8000-${String(unique++).padStart(12, '0')}.png`,
          storageProvider: 'local',
          fileName: 'x.png',
          mimeType: 'image/png',
          sizeBytes: 3n,
          checksum: 'x',
          purpose: 'BRANCH_IMAGE',
          visibility: 'PUBLIC',
          status: 'UPLOADING',
          uploadedByType: 'SYSTEM',
        },
      });
      const { Readable } = await import('node:stream');
      await storage.local.put(crashed.storageKey, Readable.from([Buffer.from('abc')]), { contentType: 'image/png', contentLength: 3 });

      const later = new Date(Date.now() + 2 * 60 * 60_000);
      const result = await harness.app.get(FileCleanupService).sweep({ now: later });
      expect(result.abandoned).toBeGreaterThanOrEqual(1);
      expect(result.unreferenced).toBeGreaterThanOrEqual(1);

      expect((await fileRow(crashed.id)).deletedAt).not.toBeNull();
      expect(await objectExists(crashed.id)).toBe(false);
      expect((await fileRow(orphan.id)).deletedAt).not.toBeNull();
      expect(await objectExists(orphan.id)).toBe(false);
      // The branch image is in use: untouched.
      expect((await fileRow(inUse.id)).deletedAt).toBeNull();
      expect(await objectExists(inUse.id)).toBe(true);
    });
  });
});
