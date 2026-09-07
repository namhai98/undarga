import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ServiceCategoriesController } from './service-categories.controller';
import {
  ServiceCategoriesService,
  ServiceCategoryRepository,
} from './service-categories.service';
import { ServicesController } from './services.controller';
import { ServiceRepository, ServicesService } from './services.service';

/**
 * The catalogue: services and the categories that group them.
 *
 * One module rather than two, because they are one thing to administer —
 * nobody manages categories without managing the services in them, and the
 * category delete rule needs the service count. Splitting them would mean two
 * modules importing each other.
 *
 * Exports both services: availability, appointments and the public booking
 * page will all need to resolve a service, and rule 5 says a module never
 * queries another module's tables.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [ServicesController, ServiceCategoriesController],
  providers: [
    ServicesService,
    ServiceRepository,
    ServiceCategoriesService,
    ServiceCategoryRepository,
  ],
  exports: [ServicesService, ServiceCategoriesService],
})
export class CatalogModule {}
