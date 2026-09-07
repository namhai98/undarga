import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersController } from './users.controller';

/**
 * The caller's own account.
 *
 * No providers of its own: the one repository it needs is `IdentityRepository`,
 * exported by AuthModule. Wrapping it in a `UsersService` that forwarded three
 * calls would be indirection with nothing in it (rule 9) — the controller does
 * no business work, it reads and writes one row that belongs to the caller.
 */
@Module({
  imports: [AuthModule],
  controllers: [UsersController],
})
export class UsersModule {}
