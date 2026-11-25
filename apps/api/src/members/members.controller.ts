import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequirePermission } from '../authz/decorators/authz.decorators';
import { COMPANY_PERMISSIONS } from '../authz/permissions';
import { ZodValidationPipe } from '../common/pipes';
import { AllowPlatformAccess, RequiresWrite } from '../tenancy/decorators/tenant.decorators';
import { MembersService } from './members.service';

const uuidParam = new ZodValidationPipe(z.string().uuid());

const setRolesSchema = z
  .object({
    roleKeys: z
      .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
      .min(1)
      .max(10),
  })
  .strict();
type SetRolesDto = z.infer<typeof setRolesSchema>;

const roleKeyParam = new ZodValidationPipe(
  z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .max(48),
);

const roleSchema = z
  .object({
    name: z.string().trim().min(1).max(96),
    description: z.string().trim().max(256).nullable().optional(),
    permissions: z.array(z.string().min(3).max(96)).min(1).max(200),
  })
  .strict();
type RoleDto = z.infer<typeof roleSchema>;

@ApiTags('members')
@Controller({ path: 'members', version: '1' })
@AllowPlatformAccess()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_READ)
  @ApiOperation({ summary: 'Everyone who can sign in to this company, with their roles' })
  async list() {
    return this.members.list();
  }

  @Get('roles')
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_READ)
  @ApiOperation({ summary: 'The roles a member can be given, with their permissions' })
  async roles() {
    return this.members.roles();
  }

  @Get('permissions')
  @RequirePermission(COMPANY_PERMISSIONS.ROLE_READ)
  @ApiOperation({ summary: 'Every permission a company role can carry' })
  permissions() {
    return this.members.permissions();
  }

  @Post('roles')
  @RequirePermission(COMPANY_PERMISSIONS.ROLE_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: 'Create a role of your own',
    description: 'Only permissions you hold yourself. The key is derived from the name.',
  })
  @ApiResponse({ status: 403, description: 'PRIVILEGE_ESCALATION_BLOCKED.' })
  async createRole(@Body(new ZodValidationPipe(roleSchema)) dto: RoleDto) {
    return this.members.createRole(dto);
  }

  @Patch('roles/:key')
  @RequirePermission(COMPANY_PERMISSIONS.ROLE_WRITE)
  @RequiresWrite()
  @ApiOperation({ summary: 'Change a role of your own; built-in roles cannot be changed' })
  @ApiResponse({ status: 409, description: 'SYSTEM_ROLE_IMMUTABLE.' })
  async updateRole(
    @Param('key', roleKeyParam) key: string,
    @Body(new ZodValidationPipe(roleSchema.partial())) dto: Partial<RoleDto>,
  ) {
    return this.members.updateRole(key, dto);
  }

  @Delete('roles/:key')
  @RequirePermission(COMPANY_PERMISSIONS.ROLE_WRITE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiResponse({ status: 409, description: 'SYSTEM_ROLE_IMMUTABLE or ROLE_IN_USE.' })
  async deleteRole(@Param('key', roleKeyParam) key: string): Promise<void> {
    await this.members.deleteRole(key);
  }

  @Put(':companyUserId/roles')
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_WRITE)
  @RequiresWrite()
  @ApiOperation({
    summary: "Replace a member's roles",
    description:
      'Not your own, not the owner, not someone with access you lack, and only roles whose ' +
      'permissions you hold. Takes effect on their next request.',
  })
  @ApiResponse({
    status: 403,
    description: 'SELF_MODIFICATION_BLOCKED or PRIVILEGE_ESCALATION_BLOCKED.',
  })
  @ApiResponse({
    status: 409,
    description: 'LAST_OWNER, or the member has access you lack (CONFLICT).',
  })
  async setRoles(
    @Param('companyUserId', uuidParam) companyUserId: string,
    @Body(new ZodValidationPipe(setRolesSchema)) dto: SetRolesDto,
  ) {
    return this.members.setRoles(companyUserId, dto.roleKeys);
  }

  @Delete(':companyUserId')
  @RequirePermission(COMPANY_PERMISSIONS.MEMBER_REMOVE)
  @RequiresWrite()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a member from this company',
    description: 'Their login is kept (they may belong elsewhere); access here ends at once.',
  })
  async remove(@Param('companyUserId', uuidParam) companyUserId: string): Promise<void> {
    await this.members.remove(companyUserId);
  }
}
