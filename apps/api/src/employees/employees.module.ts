import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MembersModule } from '../members/members.module';
import { EmployeeRepository } from './employee.repository';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

/**
 * Employees: the people a company books work against.
 *
 * Imports MembersModule for InvitationsService and AuthModule for
 * IdentityRepository, rather than creating accounts or memberships itself.
 * Rule 5 — a module never queries another module's tables — and rule 8: a
 * second account-creation path is a second place for the RLS and status rules
 * to drift.
 *
 * Exports the service because the catalog, scheduling and booking modules will
 * all need to resolve an employee, and they should call this rather than reach
 * for `tx.employee`.
 */
@Module({
  imports: [DatabaseModule, AuthModule, MembersModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeRepository],
  exports: [EmployeesService],
})
export class EmployeesModule {}
