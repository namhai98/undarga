import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { CalendarConnectionsService } from './calendar-connections.service';
import {
  completeOAuthSchema,
  startOAuthSchema,
  updateConnectionSchema,
  type CompleteOAuthDto,
  type StartOAuthDto,
  type UpdateConnectionDto,
} from './dto/calendar.dto';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const MANAGE = [
  COMPANY_PERMISSIONS.SCHEDULE_WRITE_OWN,
  COMPANY_PERMISSIONS.SCHEDULE_WRITE_ANY,
] as const;

/**
 * Employees' external calendars (Google, Microsoft). One-way: appointments are
 * written to the calendar; its busy periods are optionally read back into
 * availability; nothing in the calendar changes an appointment.
 *
 * `schedule:write:any` manages anyone's calendar; `schedule:write:own` only
 * the employee linked to your own login (checked per record). No platform
 * access: these are personal accounts.
 */
@ApiTags('calendar')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/calendar-connections', version: '1' })
export class CalendarController {
  constructor(private readonly calendars: CalendarConnectionsService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.SCHEDULE_READ)
  @ApiOperation({
    summary: 'Providers, and the calendars of the employees you may manage',
    description:
      'Per employee: provider, status (ACTIVE, NEEDS_REAUTH, ERROR), account, chosen calendar, ' +
      'last sync and last error. Tokens are never returned.',
  })
  async overview() {
    return this.calendars.overview();
  }

  @Post('oauth/start')
  @HttpCode(200)
  @RequirePermission(...MANAGE)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start connecting (or reconnecting) a calendar',
    description:
      'Returns the provider’s consent URL. Send the browser there; the provider returns it to the ' +
      'configured redirect URL with `code` and `state`, to be posted to `oauth/callback`. The state ' +
      'is single-use, ten minutes, and bound to you.',
  })
  @ApiResponse({
    status: 503,
    description: 'CALENDAR_PROVIDER_UNAVAILABLE — not configured on this server.',
  })
  async start(@Body(new ZodValidationPipe(startOAuthSchema)) dto: StartOAuthDto) {
    return this.calendars.start(dto);
  }

  @Post('oauth/callback')
  @HttpCode(200)
  @RequirePermission(...MANAGE)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Finish connecting: exchange the code, store the tokens encrypted' })
  @ApiResponse({
    status: 400,
    description: 'CALENDAR_OAUTH_INVALID — unknown, expired, used, or not yours.',
  })
  async callback(@Body(new ZodValidationPipe(completeOAuthSchema)) dto: CompleteOAuthDto) {
    return this.calendars.complete(dto);
  }

  @Get(':connectionId/calendars')
  @RequirePermission(...MANAGE)
  @ApiOperation({ summary: 'Calendars the connected account can write to' })
  async calendarsOf(@Param('connectionId', uuidParam) connectionId: string) {
    return this.calendars.calendars(connectionId);
  }

  @Patch(':connectionId')
  @RequirePermission(...MANAGE)
  @ApiOperation({
    summary: 'Choose the calendar, and whether completed appointments and busy times are used',
  })
  async update(
    @Param('connectionId', uuidParam) connectionId: string,
    @Body(new ZodValidationPipe(updateConnectionSchema)) dto: UpdateConnectionDto,
  ) {
    return this.calendars.update(connectionId, dto);
  }

  @Get(':connectionId/sync')
  @RequirePermission(...MANAGE)
  @ApiOperation({ summary: 'Sync status: queue, last sync, recent errors' })
  async status(@Param('connectionId', uuidParam) connectionId: string) {
    return this.calendars.syncStatus(connectionId);
  }

  @Post(':connectionId/sync')
  @HttpCode(200)
  @RequirePermission(...MANAGE)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Sync now (manual retry)',
    description:
      'Re-queues the employee’s upcoming appointments, failed ones included, and re-reads busy times.',
  })
  async resync(@Param('connectionId', uuidParam) connectionId: string) {
    return this.calendars.resync(connectionId);
  }

  @Delete(':connectionId')
  @RequirePermission(...MANAGE)
  @ApiOperation({
    summary: 'Disconnect',
    description:
      'Removes our upcoming events from the calendar (best effort), revokes the grant where the ' +
      'provider supports it, and deletes the stored tokens and busy times.',
  })
  async disconnect(@Param('connectionId', uuidParam) connectionId: string) {
    return this.calendars.disconnect(connectionId);
  }
}
