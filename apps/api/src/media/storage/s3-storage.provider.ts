import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  assertSafeKey,
  contentDisposition,
  StorageBackendError,
  StorageObjectMissingError,
  type StorageProvider,
  type StoredObject,
} from './storage-provider';

export interface S3Settings {
  bucket: string;
  /** e.g. https://minio.internal:9000. Null for AWS (https://s3.<region>.amazonaws.com). */
  endpoint: string | null;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

type Fetch = typeof fetch;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TIMEOUT_MS = 30_000;

/**
 * Any S3-compatible store (AWS S3, MinIO, Cloudflare R2, DigitalOcean
 * Spaces, Backblaze B2…) over plain HTTPS with AWS Signature Version 4 — no
 * SDK, so nothing to keep patched beyond this file.
 *
 *   put      streamed with a known Content-Length (`UNSIGNED-PAYLOAD`, which
 *            S3 accepts over TLS) — the object is never held in memory
 *   get      streamed back
 *   signed   presigned GET, query-string auth, with the response type and a
 *            safe Content-Disposition pinned into the signature
 *
 * The bucket should block public access; public images are served by the API
 * (or a CDN in front of the `public/` prefix). Credentials never leave this
 * class; signed URLs are never logged.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;
  private readonly origin: URL;

  constructor(
    private readonly settings: S3Settings,
    private readonly fetchImpl: Fetch = (input, init) => fetch(input, init),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.origin = new URL(settings.endpoint ?? `https://s3.${settings.region}.amazonaws.com`);
  }

  async put(
    key: string,
    body: Readable,
    info: { contentType: string; contentLength: number },
  ): Promise<void> {
    const response = await this.send('PUT', key, {
      headers: {
        'content-type': info.contentType,
        'content-length': String(info.contentLength),
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
      },
      body: Readable.toWeb(body),
    });
    if (!response.ok) throw new StorageBackendError(`S3 PUT answered ${response.status}.`);
    await response.body?.cancel();
  }

  async get(key: string): Promise<StoredObject> {
    const response = await this.send('GET', key, {
      headers: { 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new StorageObjectMissingError();
    }
    if (!response.ok || !response.body)
      throw new StorageBackendError(`S3 GET answered ${response.status}.`);
    const length = Number(response.headers.get('content-length'));
    return {
      body: Readable.fromWeb(response.body),
      contentLength: Number.isFinite(length) ? length : null,
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.send('DELETE', key, {
      headers: { 'x-amz-content-sha256': EMPTY_SHA256 },
    });
    await response.body?.cancel();
    if (!response.ok && response.status !== 404)
      throw new StorageBackendError(`S3 DELETE answered ${response.status}.`);
  }

  signedUrl(
    key: string,
    options: { expiresInSeconds: number; contentType: string; fileName: string },
  ): Promise<string> {
    assertSafeKey(key);
    return Promise.resolve(
      this.presign('GET', this.objectUrl(key), options.expiresInSeconds, {
        'response-content-type': options.contentType,
        'response-content-disposition': contentDisposition(options.fileName),
      }),
    );
  }

  // ===========================================================================
  // Signature Version 4
  // ===========================================================================

  /** The object's URL: virtual-hosted (bucket.host/key) or path-style (host/bucket/key). */
  objectUrl(key: string): URL {
    const url = new URL(this.origin.toString());
    const path = key.split('/').map(encodeRfc3986).join('/');
    if (this.settings.forcePathStyle) {
      url.pathname = `${trimSlash(url.pathname)}/${encodeRfc3986(this.settings.bucket)}/${path}`;
    } else {
      url.hostname = `${this.settings.bucket}.${url.hostname}`;
      url.pathname = `${trimSlash(url.pathname)}/${path}`;
    }
    return url;
  }

  private async send(
    method: 'GET' | 'PUT' | 'DELETE',
    key: string,
    init: { headers: Record<string, string>; body?: RequestInit['body'] },
  ): Promise<Response> {
    assertSafeKey(key);
    const url = this.objectUrl(key);
    const headers = this.signHeaders(method, url, init.headers);
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: init.body,
        // Required by fetch for a streamed request body.
        ...(init.body ? { duplex: 'half' } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new StorageBackendError(`S3 ${method} could not reach the endpoint.`);
    }
  }

  /** Authorization header signing: host + every x-amz-* header + content-type. */
  signHeaders(method: string, url: URL, extra: Record<string, string>): Record<string, string> {
    const now = this.now();
    const amzDate = toAmzDate(now);
    const day = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      ...lowerKeys(extra),
      host: url.host,
      'x-amz-date': amzDate,
    };
    const signed = Object.keys(headers)
      .filter(
        (h) => h === 'host' || h.startsWith('x-amz-') || h === 'content-type' || h === 'range',
      )
      .sort();
    const canonicalHeaders = signed.map((h) => `${h}:${headers[h]!.trim()}\n`).join('');
    const payloadHash = headers['x-amz-content-sha256'] ?? EMPTY_SHA256;
    const canonical = [
      method,
      url.pathname,
      canonicalQuery(url.searchParams),
      canonicalHeaders,
      signed.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${this.settings.region}/s3/aws4_request`;
    const signature = this.signature(
      day,
      ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n'),
    );
    const { host: _host, ...rest } = headers;
    return {
      ...rest,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.settings.accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
    };
  }

  /** Query-string signing: the URL alone authorises the request until it expires. */
  presign(
    method: string,
    url: URL,
    expiresInSeconds: number,
    extraQuery: Record<string, string> = {},
  ): string {
    const amzDate = toAmzDate(this.now());
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${this.settings.region}/s3/aws4_request`;
    const signedUrl = new URL(url.toString());
    const params: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.settings.accessKey}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresInSeconds),
      'X-Amz-SignedHeaders': 'host',
      ...extraQuery,
    };
    for (const [k, v] of Object.entries(params)) signedUrl.searchParams.set(k, v);
    const canonical = [
      method,
      signedUrl.pathname,
      canonicalQuery(signedUrl.searchParams),
      `host:${signedUrl.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const signature = this.signature(
      day,
      ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonical)].join('\n'),
    );
    return `${signedUrl.origin}${signedUrl.pathname}?${canonicalQuery(signedUrl.searchParams)}&X-Amz-Signature=${signature}`;
  }

  private signature(day: string, stringToSign: string): string {
    const kDate = hmac(`AWS4${this.settings.secretKey}`, day);
    const kRegion = hmac(kDate, this.settings.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    return createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  }
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** RFC 3986 unreserved characters stay; everything else is %XX (S3's rule). */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '');
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
}
