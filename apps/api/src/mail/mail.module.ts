import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '../config';
import { MailerService } from './mailer.service';

/**
 * Outbound email.
 *
 * `@Global` because the flows that send mail are spread across auth, members
 * and later notifications, and threading an import through each of them buys
 * nothing — there is exactly one implementation and it holds no state.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [MailerService],
  exports: [MailerService],
})
export class MailModule {}
