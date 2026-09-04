import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfig } from '../config';

/**
 * Password hashing.
 *
 * argon2id, memory-hard, tuned via env so the cost can be raised as hardware
 * improves without a code change. The defaults (19 MiB, t=2, p=1) are the OWASP
 * baseline.
 */
@Injectable()
export class PasswordService {
  constructor(private readonly config: AppConfig) {}

  async hash(plain: string): Promise<string> {
    const { memoryCost, timeCost, parallelism } = this.config.auth.argon2;
    return argon2.hash(plain, { type: argon2.argon2id, memoryCost, timeCost, parallelism });
  }

  async verify(hash: string | null | undefined, plain: string): Promise<boolean> {
    // A missing hash still costs a verification. Returning early would make
    // "no such account" measurably faster than "wrong password", which is a
    // timing oracle on the login endpoint.
    if (!hash) {
      await this.burnTime(plain);
      return false;
    }

    try {
      return await argon2.verify(hash, plain);
    } catch {
      // Malformed stored hash: treat as a failed login, not a 500.
      return false;
    }
  }

  /** Whether the stored hash was produced with weaker parameters than current. */
  needsRehash(hash: string): boolean {
    const { memoryCost, timeCost, parallelism } = this.config.auth.argon2;
    try {
      // No `type` here: needsRehash only compares cost parameters, and the
      // variant is already encoded in the stored hash string.
      return argon2.needsRehash(hash, { memoryCost, timeCost, parallelism });
    } catch {
      return true;
    }
  }

  private async burnTime(plain: string): Promise<void> {
    const { memoryCost, timeCost, parallelism } = this.config.auth.argon2;
    await argon2.hash(plain, { type: argon2.argon2id, memoryCost, timeCost, parallelism });
  }
}
