import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { RequestContextService } from '../tenancy/context/request-context.service';
import { AllowPlatformAccess } from '../tenancy/decorators/tenant.decorators';
import { notificationQuerySchema, type NotificationQueryDto } from './dto/notification.dto';
import { NotificationSchedulerService } from './notification-scheduler.service';
import { NotificationsService } from './notifications.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());

/**
 * What the system has tried to tell people.
 *
 * ---------------------------------------------------------------------------
 * NO "SEND A MESSAGE" ENDPOINT
 * ---------------------------------------------------------------------------
 *
 * Notifications are produced by business events — a booking, a cancellation,
 * a reminder coming due. An endpoint that let a client conjure one would be a
 * way to send a customer arbitrary text under the company's name.
 *
 * Addresses are masked everywhere and the stored event payload is never
 * returned. None of this is reachable from the public API.
 */
@ApiTags('notifications')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/notifications', version: '1' })
@AllowPlatformAccess()
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly scheduler: NotificationSchedulerService,
    private readonly context: RequestContextService,
  ) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'Notification history',
    description:
      'Every message this company has queued: type, channel, masked recipient, status, sent ' +
      'time and — when it failed — the reason, attempts used and when it will be retried.',
  })
  async list(@Query(new ZodValidationPipe(notificationQuerySchema)) query: NotificationQueryDto) {
    return this.notifications.list(query);
  }

  @Get('stats')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({ summary: 'Counts by status and channel, for the dashboard tile' })
  async stats() {
    return this.notifications.stats();
  }

  @Post('run')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Process this company’s queue now',
    description:
      'Schedules due reminders, turns pending events into notifications and sends what is due — ' +
      'for THIS company only. The background worker does the same on a timer; this is for ' +
      'environments where it is switched off, and for impatience. Safe to call repeatedly: every ' +
      'stage claims its work, so nothing is sent twice.',
  })
  async run() {
    return this.scheduler.runOnce({
      companyId: this.context.requireCompanyId('notifications.run'),
    });
  }

  @Get(':notificationId')
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'One notification, with its full text',
    description: 'The recipient stays masked; the underlying event payload is never returned.',
  })
  @ApiResponse({ status: 404, description: 'Not this company’s notification.' })
  async find(@Param('notificationId', uuidParam) notificationId: string) {
    return this.notifications.findById(notificationId);
  }
}
