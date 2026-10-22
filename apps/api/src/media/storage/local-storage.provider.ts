import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertSafeKey,
  StorageBackendError,
  StorageObjectMissingError,
  type StorageProvider,
  type StoredObject,
} from './storage-provider';

/**
 * Files on the API host's disk. For development and single-instance setups:
 * several API instances would each have their own disk.
 *
 * Signed URLs point back at the API (`GET /files/signed/:token`), with an
 * HMAC over key, type, name and expiry — the token is the authorisation, so
 * it is never logged.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly name = 'local' as const;
  private readonly root: string;

  constructor(
    root: string,
    private readonly signing: { secret: string; downloadBaseUrl: string },
  ) {
    this.root = resolve(root);
  }

  async put(
    key: string,
    body: Readable,
    _info: { contentType: string; contentLength: number },
  ): Promise<void> {
    const path = this.pathOf(key);
    const temp = `${path}.${randomUUID()}.part`;
    try {
      await mkdir(dirname(path), { recursive: true });
      // Write aside and rename: a crash never leaves a half file under the key.
      await pipeline(body, createWriteStream(temp, { flags: 'wx' }));
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new StorageBackendError(
        `Local write failed: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
  }

  async get(key: string): Promise<StoredObject> {
    const path = this.pathOf(key);
    try {
      const info = await stat(path);
      return { body: createReadStream(path), contentLength: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageObjectMissingError();
      throw new StorageBackendError('Local read failed.');
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true }).catch(() => {
      throw new StorageBackendError('Local delete failed.');
    });
  }

  signedUrl(
    key: string,
    options: { expiresInSeconds: number; contentType: string; fileName: string },
  ): Promise<string> {
    assertSafeKey(key);
    const payload = Buffer.from(
      JSON.stringify({
        k: key,
        t: options.contentType,
        n: options.fileName,
        e: Math.floor(Date.now() / 1000) + options.expiresInSeconds,
      }),
    ).toString('base64url');
    return Promise.resolve(`${this.signing.downloadBaseUrl}/${payload}.${this.mac(payload)}`);
  }

  /** The object a valid, unexpired token names; null for anything else. */
  verifyToken(token: string): { key: string; contentType: string; fileName: string } | null {
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return null;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        k: string;
        t: string;
        n: string;
        e: number;
      };
      if (typeof data.e !== 'number' || data.e < Date.now() / 1000) return null;
      assertSafeKey(data.k);
      return { key: data.k, contentType: data.t, fileName: data.n };
    } catch {
      return null;
    }
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.signing.secret)
      .update(`local-file-url:${payload}`)
      .digest('base64url');
  }

  /** The key's path, provably inside the root. */
  private pathOf(key: string): string {
    assertSafeKey(key);
    const path = resolve(this.root, ...key.split('/'));
    if (!path.startsWith(this.root + sep))
      throw new StorageBackendError('Refusing a path outside the storage root.');
    return path;
  }
}
