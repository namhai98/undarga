import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BranchRepository } from './branch.repository';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

/**
 * Branches, their policy overrides and their opening hours.
 *
 * Exports the service because the catalog and scheduling modules will need to
 * resolve a branch, and rule 5 says a module never queries another module's
 * tables — they will call this rather than reach for `tx.branch`.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [BranchesController],
  providers: [BranchesService, BranchRepository],
  exports: [BranchesService],
})
export class BranchesModule {}
