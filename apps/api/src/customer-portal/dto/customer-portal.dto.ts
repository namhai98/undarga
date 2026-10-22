import { z } from 'zod';
import { customerPhoneSchema } from '../../customers/dto/customer.dto';

/**
 * The customer portal's request shapes.
 *
 * No schema here names a customer, company or session: those come from the
 * signed token (CustomerActor). An appointment or gift-card id in a path is
 * looked up inside the token's company AND checked to belong to the token's
 * customer, so another customer's id answers exactly like a missing one.
 */

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(320);

export const requestCodeSchema = z.object({ email }).strict();
export type RequestCodeDto = z.infer<typeof requestCodeSchema>;

export const verifyCodeSchema = z
  .object({
    email,
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code.'),
  })
  .strict();
export type VerifyCodeDto = z.infer<typeof verifyCodeSchema>;

/**
 * What a customer may change about themselves. Email is the sign-in address
 * and is changed by the business, not here; tags, notes and loyalty figures
 * are the business's and are not even shown.
 */
export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(1, 'Enter your first name.').max(96).optional(),
    lastName: z.string().trim().max(96).nullable().optional(),
    phone: customerPhoneSchema.nullable().optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, 'Use a locale like en-US or mn-MN.')
      .nullable()
      .optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Change at least one field.' });
export type UpdateProfileDto = z.infer<typeof updateProfileSchema>;

const page = {
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
};

export const appointmentListSchema = z
  .object({
    /** upcoming: still to come · past: completed, no-show or gone by · cancelled */
    scope: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'),
    ...page,
  })
  .strict();
export type AppointmentListDto = z.infer<typeof appointmentListSchema>;

export const pageSchema = z.object(page).strict();
export type PageDto = z.infer<typeof pageSchema>;

export const customerCancelSchema = z
  .object({ reason: z.string().trim().max(512).optional() })
  .strict();
export type CustomerCancelDto = z.infer<typeof customerCancelSchema>;

/** A new time only: the customer keeps the same service, branch and staff. */
export const customerRescheduleSchema = z
  .object({ startsAt: z.string().datetime({ offset: true, message: 'Use an ISO date-time.' }) })
  .strict();
export type CustomerRescheduleDto = z.infer<typeof customerRescheduleSchema>;

export const rescheduleOptionsSchema = z
  .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.') })
  .strict();
export type RescheduleOptionsDto = z.infer<typeof rescheduleOptionsSchema>;
