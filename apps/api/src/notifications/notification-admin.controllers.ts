import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import {
  createTemplateSchema,
  customerPreferencesSchema,
  previewTemplateSchema,
  templateQuerySchema,
  updateNotificationSettingsSchema,
  updateTemplateSchema,
  type CreateTemplateDto,
  type CustomerPreferencesDto,
  type PreviewTemplateDto,
  type TemplateQueryDto,
  type UpdateNotificationSettingsDto,
  type UpdateTemplateDto,
} from './dto/notification.dto';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationSettingsService } from './notification-settings.service';
import { NotificationTemplatesService } from './notification-templates.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());

@ApiTags('notifications')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/notification-settings', version: '1' })
@AllowPlatformAccess()
export class NotificationSettingsController {
  constructor(private readonly settings: NotificationSettingsService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'Notification settings',
    description:
      'Which channels are on, reminder timing, and which channels each kind of message uses. ' +
      'Also returns the catalog of message types with their variables and default wording.',
  })
  async get() {
    return this.settings.get();
  }

  @Patch()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Change notification settings',
    description:
      'Any subset of `channels` ({email, sms, push}), `reminders` ({enabled, offsetsMinutes: ' +
      'minutes before the start, 15–10080, at most four}) and `eventChannels` (per type; an ' +
      'empty list switches that type off). A disabled channel creates no notifications at all.',
  })
  async update(
    @Body(new ZodValidationPipe(updateNotificationSettingsSchema))
    dto: UpdateNotificationSettingsDto,
  ) {
    return this.settings.update(dto);
  }
}

@ApiTags('notifications')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/notification-templates', version: '1' })
@AllowPlatformAccess()
export class NotificationTemplatesController {
  constructor(private readonly templates: NotificationTemplatesService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'This company’s templates',
    description:
      'Its own wording per (type, channel). Where it has none — or it is inactive — the platform ' +
      'default in `catalog` is used.',
  })
  async list(@Query(new ZodValidationPipe(templateQuerySchema)) query: TemplateQueryDto) {
    return this.templates.list(query);
  }

  @Post()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a template',
    description:
      'Variables: {{customerName}}, {{serviceName}}, {{branchName}}, {{employeeName}}, ' +
      '{{appointmentDate}}, {{appointmentTime}}, {{companyName}} (appointment messages), ' +
      '{{giftCardBalance}} (gift cards), {{paymentAmount}} (payments). Unknown or ' +
      'inapplicable variables are refused. Email needs a subject, push a title; SMS ≤ 480 chars.',
  })
  @ApiResponse({
    status: 409,
    description: 'A template for that type and channel exists — edit it.',
  })
  async create(@Body(new ZodValidationPipe(createTemplateSchema)) dto: CreateTemplateDto) {
    return this.templates.create(dto);
  }

  @Post('preview')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Render a template with sample values',
    description: 'Validates exactly as saving does, and saves nothing.',
  })
  async preview(@Body(new ZodValidationPipe(previewTemplateSchema)) dto: PreviewTemplateDto) {
    return this.templates.preview(dto);
  }

  @Patch(':templateId')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Edit a template or switch it on/off',
    description: 'Type and channel are fixed. Inactive means the platform default is used instead.',
  })
  async update(
    @Param('templateId', uuidParam) templateId: string,
    @Body(new ZodValidationPipe(updateTemplateSchema)) dto: UpdateTemplateDto,
  ) {
    return this.templates.update(templateId, dto);
  }
}

@ApiTags('notifications')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({
  path: 'companies/:companyId/customers/:customerId/notification-preferences',
  version: '1',
})
@AllowPlatformAccess()
export class CustomerNotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_READ)
  @ApiOperation({
    summary: 'A customer’s notification channels',
    description:
      '`enabled` per channel (opt-out: on unless turned off) and `reachable` per channel.',
  })
  async get(@Param('customerId', uuidParam) customerId: string) {
    return this.preferences.get(customerId);
  }

  @Patch()
  @RequirePermission(COMPANY_PERMISSIONS.CUSTOMER_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'Turn a customer’s email / SMS / push notifications on or off' })
  async update(
    @Param('customerId', uuidParam) customerId: string,
    @Body(new ZodValidationPipe(customerPreferencesSchema)) dto: CustomerPreferencesDto,
  ) {
    return this.preferences.update(customerId, dto);
  }
}
