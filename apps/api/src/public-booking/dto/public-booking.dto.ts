import { z } from 'zod';
import { customerEmailSchema, customerPhoneSchema } from '../../customers/dto/customer.dto';
import { promotionCode } from '../../promotions/dto/promotion.dto';

/** Same shape the platform enforces when a company is provisioned. */
export const companySlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

const uuid = z.string().uuid();

export const publicAvailabilityQuerySchema = z.object({
  branchId: uuid,
  serviceId: uuid,
  /** `YYYY-MM-DD`, in the branch's timezone. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.'),
  employeeId: uuid.optional(),
});
export type PublicAvailabilityQueryDto = z.infer<typeof publicAvailabilityQuerySchema>;

/**
 * A booking from the public page.
 *
 * Deliberately narrower than the staff DTO: no `resourceId` (rooms are the
 * business's to allocate), no `source` (it is ONLINE, full stop), no
 * `internalNote`, no `customerId` (a visitor identifies by contact details, and
 * the server decides which record that is).
 *
 * The phone and email validators are the customer module's own, so a number a
 * visitor types is normalised exactly as one typed at the desk — which is what
 * lets the two find each other.
 */
export const createPublicBookingSchema = z
  .object({
    branchId: uuid,
    serviceId: uuid,
    /** Omit to take whoever is free — the server assigns deterministically. */
    employeeId: uuid.optional(),
    /** Echo back exactly the `startAt` the availability call returned. */
    startsAt: z.string().datetime({ offset: true, message: 'Choose a time from the list.' }),
    customer: z
      .object({
        firstName: z.string().trim().min(1, 'Enter your first name.').max(96),
        lastName: z.string().trim().max(96).optional(),
        phone: customerPhoneSchema,
        email: customerEmailSchema.optional(),
      })
      .strict(),
    note: z.string().trim().max(1000).optional(),
    /** Re-validated and consumed inside the booking transaction. */
    promotionCode: promotionCode.optional(),
  })
  .strict();
export type CreatePublicBookingDto = z.infer<typeof createPublicBookingSchema>;

/**
 * Preview a code on the public page. Ids and the code only — the server prices
 * the service. No customer: rules about a specific customer (new customers
 * only, per-customer limits, personal codes) are checked when the booking is
 * made, once the customer is known.
 */
export const publicPromotionPreviewSchema = z
  .object({
    code: promotionCode,
    branchId: uuid,
    serviceId: uuid,
    employeeId: uuid.optional(),
  })
  .strict();
export type PublicPromotionPreviewDto = z.infer<typeof publicPromotionPreviewSchema>;
