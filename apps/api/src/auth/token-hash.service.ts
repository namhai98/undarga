import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config';

/**
 * HMAC for high-entropy secrets that must be looked up by value: refresh
 * tokens today, gift-card codes later.
 *
 * HMAC with a server-side pepper rather than argon2, deliberately. These values
 * are 256 bits of CSPRNG output, so there is nothing to brute-force and the
 * slow-hash cost would buy nothing — but they ARE looked up by equality on
 * every refresh, so the hash has to be fast and deterministic. The pepper means
 * a database dump alone does not yield usable tokens.
 */
@Injectable()
export class TokenHashService {
  constructor(private readonly config: AppConfig) {}

  generate(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
  }

  hash(value: string): string {
    return createHmac('sha256', this.config.tokenHashPepper).update(value).digest('base64');
  }

  matches(value: string, expectedHash: string): boolean {
    const actual = Buffer.from(this.hash(value));
    const expected = Buffer.from(expectedHash);
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }
}
