import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { DatabaseModule } from '../database/database.module';
import { RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import {
  createTimeOffSchema,
  timeOffQuerySchema,
  TimeOffRepository,
  TimeOffService,
  updateTimeOffSchema,
  type CreateTimeOffDto,
  type TimeOffQueryDto,
  type UpdateTimeOffDto,
} from './time-off.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());
const EITHER = [
  COMPANY_PERMISSIONS.TIME_OFF_REQUEST,
  COMPANY_PERMISSIONS.TIME_OFF_APPROVE,
] as const;

@ApiTags('time off')
@ApiParam({ name: 'companyId', description: 'Validated against your memberships; 404 if not.' })
@Controller({ path: 'companies/:companyId/time-off', version: '1' })
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  @Get()
  @RequirePermission(...EITHER)
  @ApiOperation({
    summary: 'Time off',
    description: 'With timeoff:approve, everyone’s; with timeoff:request, only your own.',
  })
  async list(@Query(new ZodValidationPipe(timeOffQuerySchema)) query: TimeOffQueryDto) {
    return this.timeOff.list(query);
  }

  @Post()
  @RequirePermission(...EITHER)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Record time off (managers) or request it (employees)',
    description:
      'Vacation, sick, personal leave and other unavailable periods. Approved time off removes ' +
      'those times from availability at once. Over booked appointments it is refused with the ' +
      'appointments listed, unless `allowConflicts: true`.',
  })
  @ApiResponse({ status: 409, description: 'TIME_OFF_CONFLICT — details.appointments.' })
  async create(@Body(new ZodValidationPipe(createTimeOffSchema)) dto: CreateTimeOffDto) {
    return this.timeOff.create(dto);
  }

  @Patch(':timeOffId')
  @RequirePermission(...EITHER)
  @RequiresWrite()
  @ApiOperation({ summary: 'Change, approve, reject or withdraw time off' })
  async update(
    @Param('timeOffId', uuidParam) timeOffId: string,
    @Body(new ZodValidationPipe(updateTimeOffSchema)) dto: UpdateTimeOffDto,
  ) {
    return this.timeOff.update(timeOffId, dto);
  }

  @Delete(':timeOffId')
  @RequirePermission(...EITHER)
  @RequiresWrite()
  @ApiOperation({ summary: 'Cancel time off (kept as history)' })
  async remove(@Param('timeOffId', uuidParam) timeOffId: string) {
    return this.timeOff.remove(timeOffId);
  }
}

@Module({
  imports: [DatabaseModule],
  controllers: [TimeOffController],
  providers: [TimeOffService, TimeOffRepository],
})
export class TimeOffModule {}
