import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp, { type Sharp } from 'sharp';
import { checkClaims, processImage, sanitiseFileName, sniffImageFormat } from './image-processing';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { S3StorageProvider } from './storage/s3-storage.provider';
import { assertSafeKey, contentDisposition } from './storage/storage-provider';

const rules = { minEdge: 32, maxEdge: 4000, maxPixels: 4_000_000, maxOutputEdge: 1024 };
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'media-spec-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function imageFile(name: string, make: (s: Sharp) => Sharp, size = { width: 300, height: 200 }) {
  const path = join(dir, name);
  await make(sharp({ create: { ...size, channels: 3, background: '#336699' } })).toFile(path);
  return path;
}

describe('image validation and re-encoding', () => {
  it('accepts JPEG, PNG and WebP by content, and reports the stored dimensions', async () => {
    for (const [format, make] of [
      ['jpeg', (s: Sharp) => s.jpeg()],
      ['png', (s: Sharp) => s.png()],
      ['webp', (s: Sharp) => s.webp()],
    ] as const) {
      const input = await imageFile(`ok.${format}`, make);
      expect(await sniffImageFormat(input)).toBe(format);
      const out = await processImage(input, `${input}.out`, rules);
      expect(out).toMatchObject({ format, width: 300, height: 200 });
      expect(out.sizeBytes).toBeGreaterThan(0);
      expect(out.checksum).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    }
  });

  it('scales a large image down to fit, never up', async () => {
    const big = await imageFile('big.png', (s) => s.png(), { width: 2400, height: 1200 });
    expect(await processImage(big, `${big}.out`, rules)).toMatchObject({ width: 1024, height: 512 });
    const small = await imageFile('small.png', (s) => s.png(), { width: 100, height: 80 });
    expect(await processImage(small, `${small}.out`, rules)).toMatchObject({ width: 100, height: 80 });
  });

  it('removes metadata (camera, author, GPS) and applies the EXIF orientation', async () => {
    const input = await imageFile('exif.jpg', (s) =>
      s.jpeg().withExif({ IFD0: { Artist: 'Secret Person', Copyright: 'Home address' } }).withMetadata({ orientation: 6 }),
    );
    const before = await sharp(input).metadata();
    expect(before.exif).toBeDefined();
    const out = await processImage(input, `${input}.out`, rules);
    const after = await sharp(`${input}.out`).metadata();
    expect(after.exif).toBeUndefined();
    expect((await readFile(`${input}.out`)).includes(Buffer.from('Secret Person'))).toBe(false);
    // Orientation 6 = rotated 90°: stored upright, so width and height swap.
    expect(out).toMatchObject({ width: 200, height: 300 });
  });

  it('refuses content that is not an accepted image, whatever it claims to be', async () => {
    const cases: Array<[string, Buffer]> = [
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ['exe', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)])],
      ['gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200)])],
      ['html', Buffer.from('<!doctype html><html><body>hi</body></html>')],
    ];
    for (const [name, bytes] of cases) {
      const path = join(dir, `bad-${name}`);
      await writeFile(path, bytes);
      await expect(processImage(path, `${path}.out`, rules)).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    }
  });

  it('refuses a fake image: right magic bytes, broken or hostile body', async () => {
    const path = join(dir, 'polyglot.jpg');
    await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('<?php system($_GET["c"]); ?>'.repeat(20))]));
    await expect(processImage(path, `${path}.out`, rules)).rejects.toMatchObject({ code: 'FILE_INVALID' });

    // PNG bytes behind a JPEG magic number is not "a JPEG".
    const png = await imageFile('real.png', (s) => s.png());
    const mixed = join(dir, 'mixed.jpg');
    await writeFile(mixed, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), await readFile(png)]));
    await expect(processImage(mixed, `${mixed}.out`, rules)).rejects.toMatchObject({ code: 'FILE_INVALID' });
  });

  it('enforces dimensions and refuses decompression bombs before decoding them', async () => {
    const tiny = await imageFile('tiny.png', (s) => s.png(), { width: 10, height: 10 });
    await expect(processImage(tiny, `${tiny}.out`, rules)).rejects.toMatchObject({ code: 'FILE_INVALID', details: { minEdge: 32 } });
    const wide = await imageFile('wide.png', (s) => s.png(), { width: 5000, height: 40 });
    await expect(processImage(wide, `${wide}.out`, { ...rules, maxPixels: 10_000_000 })).rejects.toMatchObject({
      code: 'FILE_INVALID',
      details: { maxEdge: 4000 },
    });
    const bomb = await imageFile('bomb.png', (s) => s.png(), { width: 3000, height: 3000 });
    await expect(processImage(bomb, `${bomb}.out`, { ...rules, maxPixels: 1_000_000 })).rejects.toMatchObject({
      code: 'FILE_INVALID',
      message: 'The image has too many pixels.',
    });
  });

  it('checks the claimed type and refuses executable names before decoding', () => {
    expect(() => checkClaims('image/png', 'logo.png')).not.toThrow();
    expect(() => checkClaims('application/x-msdownload', 'logo.png')).toThrow(expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' }));
    expect(() => checkClaims('image/svg+xml', 'logo.svg')).toThrow(expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' }));
    expect(() => checkClaims('image/png', 'logo.png.exe')).toThrow(expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' }));
    expect(() => checkClaims('image/jpeg', 'shell.php')).toThrow(expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' }));
  });

  it('sanitises display names: no directories, no control characters', () => {
    expect(sanitiseFileName('../../etc/passwd', 'png')).toBe('passwd.png');
    expect(sanitiseFileName('C:\\Users\\me\\Logo final.jpeg', 'jpg')).toBe('Logo final.jpg');
    expect(sanitiseFileName('a\u0000b\u001f"<>.png', 'png')).toBe('ab.png');
    expect(sanitiseFileName('', 'webp')).toBe('image.webp');
  });
});

describe('storage keys and headers', () => {
  const company = '018f0000-0000-7000-8000-000000000001';
  const id = '018f0000-0000-7000-8000-0000000000aa';

  it('accepts only server-shaped keys', () => {
    expect(() => assertSafeKey(`public/${company}/branch_image/${id}.jpg`)).not.toThrow();
    for (const bad of [
      `public/${company}/branch_image/../../../etc/passwd`,
      `/etc/passwd`,
      `public/${company}/branch_image/${id}.jpg/../x`,
      `secret/${company}/x/${id}.jpg`,
      `public\\${company}\\x\\${id}.jpg`,
      `public/${company}/BRANCH/${id}.jpg`,
    ]) {
      expect(() => assertSafeKey(bad)).toThrow();
    }
  });

  it('builds a Content-Disposition that cannot be broken out of', () => {
    expect(contentDisposition('a"b\r\nSet-Cookie: x.png')).toMatch(/^inline; filename="a_b__Set-Cookie: x.png"; filename\*=UTF-8''/);
  });
});

describe('LocalStorageProvider', () => {
  const company = '018f0000-0000-7000-8000-000000000001';
  const key = `private/${company}/customer_photo/018f0000-0000-7000-8000-0000000000bb.jpg`;

  it('stores, streams back, signs and deletes', async () => {
    const provider = new LocalStorageProvider(join(dir, 'store'), { secret: 'x'.repeat(40), downloadBaseUrl: 'http://api/files/signed' });
    await provider.put(key, Readable.from([Buffer.from('hello')]), { contentType: 'image/jpeg', contentLength: 5 });
    const got = await provider.get(key);
    const chunks: Buffer[] = [];
    for await (const c of got.body) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hello');

    const url = await provider.signedUrl(key, { expiresInSeconds: 60, contentType: 'image/jpeg', fileName: 'p.jpg' });
    const token = url.split('/').pop()!;
    expect(provider.verifyToken(token)).toEqual({ key, contentType: 'image/jpeg', fileName: 'p.jpg' });
    // Tampered payload, tampered signature, another secret: refused.
    const [payload, mac] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ k: key.replace('customer_photo', 'branch_image'), t: 'text/html', n: 'x', e: 9e9 })).toString('base64url');
    expect(provider.verifyToken(`${forged}.${mac}`)).toBeNull();
    expect(provider.verifyToken(`${payload}.${mac!.slice(0, -2)}xx`)).toBeNull();
    const other = new LocalStorageProvider(join(dir, 'store'), { secret: 'y'.repeat(40), downloadBaseUrl: 'http://api/files/signed' });
    expect(other.verifyToken(token)).toBeNull();

    await provider.delete(key);
    await expect(provider.get(key)).rejects.toThrow('No such object.');
    await expect(provider.delete(key)).resolves.toBeUndefined();
  });

  it('refuses an expired token', async () => {
    const provider = new LocalStorageProvider(join(dir, 'store'), { secret: 'x'.repeat(40), downloadBaseUrl: 'http://api' });
    const url = await provider.signedUrl(key, { expiresInSeconds: -1, contentType: 'image/jpeg', fileName: 'p.jpg' });
    expect(provider.verifyToken(url.split('/').pop()!)).toBeNull();
  });

  it('never writes outside its root', async () => {
    const provider = new LocalStorageProvider(join(dir, 'store'), { secret: 'x'.repeat(40), downloadBaseUrl: 'http://api' });
    await expect(provider.put('../../escape.jpg', Readable.from([]), { contentType: 'image/jpeg', contentLength: 0 })).rejects.toThrow();
  });
});

describe('S3StorageProvider (Signature Version 4)', () => {
  // The worked examples from the AWS S3 documentation ("Signature Calculations
  // for the Authorization Header" and "Query String Authentication").
  const aws = new S3StorageProvider(
    {
      bucket: 'examplebucket',
      endpoint: 'https://s3.amazonaws.com',
      region: 'us-east-1',
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      forcePathStyle: false,
    },
    undefined,
    () => new Date('2013-05-24T00:00:00Z'),
  );

  it('matches the AWS example for a signed GET with a Range header', () => {
    const headers = aws.signHeaders('GET', new URL('https://examplebucket.s3.amazonaws.com/test.txt'), {
      Range: 'bytes=0-9',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('matches the AWS example for a presigned GET URL', () => {
    const url = aws.presign('GET', new URL('https://examplebucket.s3.amazonaws.com/test.txt'), 86400);
    expect(url).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(url).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
  });

  it('builds virtual-hosted and path-style object URLs', () => {
    const key = '018f0000-0000-7000-8000-000000000001';
    expect(aws.objectUrl(`public/${key}/x/${key}.png`).toString()).toBe(
      `https://examplebucket.s3.amazonaws.com/public/${key}/x/${key}.png`,
    );
    const minio = new S3StorageProvider({
      bucket: 'media',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKey: 'a',
      secretKey: 'b',
      forcePathStyle: true,
    });
    expect(minio.objectUrl(`public/${key}/x/${key}.png`).toString()).toBe(`http://localhost:9000/media/public/${key}/x/${key}.png`);
  });

  it('streams PUT with a length, maps 404 and outages, and never sends the secret', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let answer = new Response(null, { status: 200 });
    const provider = new S3StorageProvider(
      { bucket: 'b', endpoint: 'https://s3.test', region: 'eu-west-1', accessKey: 'AK', secretKey: 'SUPER-SECRET', forcePathStyle: true },
      (input, init) => {
        calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init! });
        return Promise.resolve(answer);
      },
    );
    const key = 'public/018f0000-0000-7000-8000-000000000001/branch_image/018f0000-0000-7000-8000-000000000002.png';
    await provider.put(key, Readable.from([Buffer.from('abc')]), { contentType: 'image/png', contentLength: 3 });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(calls[0]!.init.method).toBe('PUT');
    expect(headers['content-length']).toBe('3');
    expect(headers['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(JSON.stringify(calls)).not.toContain('SUPER-SECRET');

    answer = new Response('missing', { status: 404 });
    await expect(provider.get(key)).rejects.toThrow('No such object.');
    answer = new Response(null, { status: 404 });
    await expect(provider.delete(key)).resolves.toBeUndefined();
    answer = new Response(null, { status: 503 });
    await expect(provider.put(key, Readable.from([Buffer.from('x')]), { contentType: 'image/png', contentLength: 1 })).rejects.toThrow('S3 PUT answered 503.');

    const signed = await provider.signedUrl(key, { expiresInSeconds: 300, contentType: 'image/png', fileName: 'a.png' });
    expect(signed).toContain('X-Amz-Expires=300');
    expect(signed).toContain('response-content-type=image%2Fpng');
    expect(signed).not.toContain('SUPER-SECRET');
  });
});
