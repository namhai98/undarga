import { Controller, Delete, Get, HttpCode, Param, Post, Put, Req, Body } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import {
  PlatformOnly,
  RequireAllPermissions,
  RequirePermission,
} from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS, PLATFORM_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import type { RequestWithContext } from '../tenancy/guards/request-with-context';
import {
  providerChannelSchema,
  saveProviderConfigSchema,
  type ProviderChannel,
  type SaveProviderConfigDto,
} from './dto/notification-provider.dto';
import { NotificationProvidersService } from './notification-providers.service';
import { NotificationReceiptsService } from './notification-receipts.service';

const channelParam = new ZodValidationPipe(providerChannelSchema);

/**
 * A company's own email / SMS accounts.
 *
 * Reading needs `settings:read` and shows masked values only. Changing who
 * sends — which hands the company's customer messages, and its sender
 * reputation, to an account — needs both `settings:write` and `billing:write`:
 * by default only the owner holds both.
 */
@ApiTags('notifications')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/notification-providers', version: '1' })
@AllowPlatformAccess()
export class NotificationProvidersController {
  constructor(private readonly providers: NotificationProvidersService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_READ)
  @ApiOperation({
    summary: 'Who sends each channel, and whether it works',
    description:
      'Per channel: the platform provider, the company’s own account if any (masked — the ' +
      'secret is never returned, only its last four characters), its connection status and ' +
      'the receipt URL to give the provider.',
  })
  async list() {
    return this.providers.list();
  }

  @Put(':channel')
  @RequireAllPermissions(COMPANY_PERMISSIONS.SETTINGS_WRITE, COMPANY_PERMISSIONS.BILLING_WRITE)
  @RequiresWrite()
  @ApiParam({ name: 'channel', enum: ['EMAIL', 'SMS'] })
  @ApiOperation({
    summary: 'Use the company’s own account for a channel',
    description:
      'EMAIL: SendGrid. SMS: Twilio. The secret is encrypted at rest and write-only; omit ' +
      '`secrets` to keep the stored one. Saving resets the status to UNVERIFIED — call verify.',
  })
  @ApiResponse({
    status: 503,
    description: 'NOTIFICATION_PROVIDERS_UNAVAILABLE — no encryption key on the server.',
  })
  async save(
    @Param('channel', channelParam) channel: ProviderChannel,
    @Body(new ZodValidationPipe(saveProviderConfigSchema)) dto: SaveProviderConfigDto,
  ) {
    return this.providers.save(channel, dto);
  }

  @Delete(':channel')
  @RequireAllPermissions(COMPANY_PERMISSIONS.SETTINGS_WRITE, COMPANY_PERMISSIONS.BILLING_WRITE)
  @ApiParam({ name: 'channel', enum: ['EMAIL', 'SMS'] })
  @ApiOperation({
    summary: 'Stop using the company’s own account',
    description: 'The channel falls back to the platform provider. The stored secret is deleted.',
  })
  async remove(@Param('channel', channelParam) channel: ProviderChannel) {
    return this.providers.remove(channel);
  }

  @Post(':channel/verify')
  @HttpCode(200)
  @RequirePermission(COMPANY_PERMISSIONS.SETTINGS_WRITE)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiParam({ name: 'channel', enum: ['EMAIL', 'SMS'] })
  @ApiOperation({
    summary: 'Check the stored credentials with the provider',
    description: 'Sends nothing. Records CONNECTED or FAILED with the provider’s reason.',
  })
  async verify(@Param('channel', channelParam) channel: ProviderChannel) {
    return this.providers.verify(channel);
  }
}

@ApiTags('platform')
@Controller({ path: 'platform/notification-providers', version: '1' })
export class PlatformNotificationProvidersController {
  constructor(private readonly providers: NotificationProvidersService) {}

  @Get()
  @PlatformOnly(PLATFORM_PERMISSIONS.OPERATOR_MANAGE)
  @ApiOperation({
    summary: 'The platform’s notification providers',
    description:
      'Which provider each channel uses and whether receipts can be verified. No secrets.',
  })
  status() {
    return this.providers.platformStatus();
  }
}

/**
 * Delivery receipts. Public — a provider has no token — so every request is
 * verified (SendGrid: ECDSA over timestamp + raw body; Twilio: HMAC-SHA1 over
 * URL + parameters) before anything in it is read.
 */
@ApiTags('notifications')
@Controller({ path: 'notifications/receipts', version: '1' })
@Public()
export class NotificationReceiptsController {
  constructor(private readonly receipts: NotificationReceiptsService) {}

  @Post('sendgrid/:source')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiParam({ name: 'source', description: '`platform`, or the company configuration id.' })
  @ApiOperation({ summary: 'SendGrid Event Webhook' })
  @ApiResponse({ status: 401, description: 'WEBHOOK_SIGNATURE_INVALID' })
  async sendgrid(
    @Param('source') source: string,
    @Req() request: RequestWithContext & { rawBody?: Buffer },
  ) {
    return this.receipts.sendgrid(source, {
      headers: request.headers,
      rawBody: request.rawBody ?? null,
      body: request.body as unknown,
    });
  }

  @Post('twilio/:source')
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiParam({ name: 'source', description: '`platform`, or the company configuration id.' })
  @ApiOperation({ summary: 'Twilio message StatusCallback' })
  @ApiResponse({ status: 401, description: 'WEBHOOK_SIGNATURE_INVALID' })
  async twilio(
    @Param('source') source: string,
    @Req() request: RequestWithContext & { rawBody?: Buffer },
  ) {
    return this.receipts.twilio(source, {
      headers: request.headers,
      rawBody: request.rawBody ?? null,
      body: request.body as unknown,
      originalUrl: request.originalUrl,
      query: request.query,
    });
  }
}
