import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { ConflictError, ResourceNotFoundError, ValidationFailedError } from '../common/errors';
import type { NotificationEventType } from './notification-event.service';
import {
  NOTIFICATION_TYPES,
  SAMPLE_VARIABLES,
  notificationCatalog,
  SMS_MAX_LENGTH,
  TEMPLATE_VARIABLES,
  renderTemplate,
  variablesIn,
  type DeliveryChannel,
} from './notification-templates';
import { NotificationTemplateRepository } from './notification.repositories';
import type {
  CreateTemplateDto,
  PreviewTemplateDto,
  TemplateQueryDto,
  UpdateTemplateDto,
} from './dto/notification.dto';

/** Templates are keyed on (type, channel); locale is fixed until translations ship. */
const LOCALE = 'en-US';

/**
 * A company's own wording, one template per (type, channel).
 *
 * Only this company's rows are ever read or written: `company_id IS NULL`
 * platform rows are not used (the platform defaults live in code), and RLS
 * forbids a tenant writing one anyway. What cannot be saved:
 *
 *   - a `{{variable}}` that does not exist, or that the type cannot fill
 *     (a gift-card balance in a reminder) — it would render as its fallback,
 *     which is never what the author meant;
 *   - an email without a subject, a push without a title;
 *   - an SMS over three segments.
 */
@Injectable()
export class NotificationTemplatesService {
  constructor(
    private readonly templates: NotificationTemplateRepository,
    private readonly audit: AuditService,
  ) {}

  async list(query: TemplateQueryDto) {
    return this.templates.transaction(async (tx, companyId) => {
      const rows = await tx.notificationTemplate.findMany({
        where: {
          companyId,
          deletedAt: null,
          ...(query.type ? { key: query.type } : {}),
          ...(query.channel ? { channel: query.channel } : {}),
          ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
        },
        orderBy: [{ key: 'asc' }, { channel: 'asc' }],
      });
      return {
        items: rows.map(toResponse),
        catalog: notificationCatalog(),
        variables: TEMPLATE_VARIABLES,
      };
    });
  }

  async create(input: CreateTemplateDto) {
    const subject = checkTemplate(input.type, input.channel, input.subject ?? null, input.body);

    const created = await this.templates.transaction(async (tx, companyId) => {
      const existing = await tx.notificationTemplate.findFirst({
        where: { companyId, key: input.type, channel: input.channel, deletedAt: null },
        select: { id: true },
      });
      if (existing) throw duplicate(existing.id);

      try {
        return await tx.notificationTemplate.create({
          data: {
            companyId,
            key: input.type,
            channel: input.channel,
            locale: LOCALE,
            subject,
            body: input.body,
            isActive: input.isActive ?? true,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw duplicate(null);
        }
        throw error;
      }
    });

    await this.audit.record({
      action: 'notification_template.created',
      resourceType: 'notification_template',
      resourceId: created.id,
      after: { type: created.key, channel: created.channel, isActive: created.isActive },
    });

    return toResponse(created);
  }

  async update(templateId: string, input: UpdateTemplateDto) {
    const { before, after } = await this.templates.transaction(async (tx, companyId) => {
      const current = await tx.notificationTemplate.findFirst({
        where: { id: templateId, companyId, deletedAt: null },
      });
      if (!current) throw new ResourceNotFoundError('NotificationTemplate', templateId);

      const body = input.body ?? current.body;
      const subject = checkTemplate(
        current.key as NotificationEventType,
        current.channel as DeliveryChannel,
        input.subject !== undefined ? input.subject : current.subject,
        body,
      );

      // updateMany so the company is in the filter — the tenant guard refuses
      // a write keyed on id alone.
      await tx.notificationTemplate.updateMany({
        where: { id: current.id, companyId },
        data: {
          subject,
          body,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      const updated = await tx.notificationTemplate.findFirstOrThrow({
        where: { id: current.id, companyId },
      });
      return { before: current, after: updated };
    });

    await this.audit.record({
      action: 'notification_template.updated',
      resourceType: 'notification_template',
      resourceId: templateId,
      before: { isActive: before.isActive },
      after: {
        isActive: after.isActive,
        textChanged: before.body !== after.body || before.subject !== after.subject,
      },
    });

    return toResponse(after);
  }

  /** Render with clearly fictional sample values. Validates exactly as saving does. */
  preview(input: PreviewTemplateDto) {
    const subject = checkTemplate(input.type, input.channel, input.subject ?? null, input.body);
    const rendered = renderTemplate({ subject, body: input.body }, SAMPLE_VARIABLES);
    return {
      subject: rendered.subject,
      body: rendered.body,
      length: rendered.body.length,
      sample: Object.fromEntries(
        NOTIFICATION_TYPES[input.type].variables.map((name) => [name, SAMPLE_VARIABLES[name]]),
      ),
    };
  }
}

/**
 * The rules a template must meet, per channel. Returns the subject to store
 * (always null for SMS).
 */
function checkTemplate(
  type: NotificationEventType,
  channel: DeliveryChannel,
  subject: string | null,
  body: string,
): string | null {
  const errors: Record<string, string> = {};
  const allowed = NOTIFICATION_TYPES[type].variables;
  const label = NOTIFICATION_TYPES[type].label;
  const storedSubject = channel === 'SMS' ? null : subject?.trim() || null;

  if (channel === 'EMAIL' && !storedSubject) errors.subject = 'An email needs a subject.';
  if (channel === 'PUSH' && !storedSubject) errors.subject = 'A push notification needs a title.';
  if (channel === 'SMS' && body.length > SMS_MAX_LENGTH) {
    errors.body = `A text message may be at most ${SMS_MAX_LENGTH} characters.`;
  }

  for (const [field, text] of [
    ['subject', storedSubject ?? ''],
    ['body', body],
  ] as const) {
    for (const name of variablesIn(text)) {
      if (!(TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
        errors[field] ??=
          `Unknown variable {{${name}}}. Available: ${allowed.map((v) => `{{${v}}}`).join(', ')}.`;
      } else if (!(allowed as readonly string[]).includes(name)) {
        errors[field] ??= `{{${name}}} is not available in “${label}” messages.`;
      }
    }
  }

  if (Object.keys(errors).length > 0) throw new ValidationFailedError(errors);
  return storedSubject;
}

function duplicate(existingId: string | null) {
  return new ConflictError(
    'This company already has a template for that message and channel. Edit it instead.',
    { field: 'type', ...(existingId ? { existingTemplateId: existingId } : {}) },
  );
}

function toResponse(row: {
  id: string;
  key: string;
  channel: string;
  subject: string | null;
  body: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  const known = Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, row.key);
  return {
    id: row.id,
    type: row.key,
    typeLabel: known ? NOTIFICATION_TYPES[row.key as NotificationEventType].label : row.key,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
