import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CustomersController } from './customers.controller';
import { CustomerRepository, CustomersService } from './customers.service';

/**
 * Customer records, tenant-scoped.
 *
 * Exported because appointments, payments and the public booking flow will all
 * need to resolve a customer, and rule 5 says a module never queries another
 * module's tables.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [CustomersController],
  providers: [CustomersService, CustomerRepository],
  exports: [CustomersService],
})
export class CustomersModule {}
