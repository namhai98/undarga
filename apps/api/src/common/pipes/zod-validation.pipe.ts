import { Injectable, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { ValidationFailedError } from '../errors';

/**
 * Validate a request body/param against a zod schema.
 *
 * zod rather than class-validator so the same schema can be shared with the
 * frontend through packages/contracts. `parse` also strips unknown keys, which
 * matters here: a client that posts `{ name, companyId }` to an endpoint that
 * only declares `name` gets the stray field dropped rather than passed into a
 * Prisma `data` object.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationFailedError(
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}
