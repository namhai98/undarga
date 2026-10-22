import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encrypt secrets at rest: AES-256-GCM with a random 96-bit IV per value.
 *
 * Stored as `v1.<iv>.<tag>.<ciphertext>` (base64url), so a future key or
 * algorithm change can be told apart from this one. `context` is bound in as
 * additional authenticated data — a ciphertext copied from one company's row
 * to another's (or one channel's to another's) fails to decrypt instead of
 * quietly handing over somebody else's credentials.
 *
 * The key is SECRETS_ENCRYPTION_KEY and never touches the database.
 */
export class SecretBox {
  private readonly key: Buffer | null;

  constructor(base64Key: string | null) {
    const key = base64Key ? Buffer.from(base64Key, 'base64') : null;
    this.key = key && key.length === 32 ? key : null;
  }

  get available(): boolean {
    return this.key !== null;
  }

  seal(plaintext: string, context: string): string {
    const key = this.requireKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), data]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  /** @throws when the key is wrong, the context differs, or the value was tampered with. */
  open(sealed: string, context: string): string {
    const key = this.requireKey();
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised sealed value.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(data, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('SECRETS_ENCRYPTION_KEY is not configured.');
    return this.key;
  }
}
