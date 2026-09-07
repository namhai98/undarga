import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig, ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { PlatformModule } from '../platform/platform.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AuthController, PlatformAuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserTokenRepository } from './user-token.repository';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MeController } from './me.controller';
import { IdentityRepository } from './identity.repository';
import { PasswordService } from './password.service';
import { SessionCookieService } from './session-cookie.service';
import { SessionDenyList } from './session-deny-list';
import { TokenHashService } from './token-hash.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    TenancyModule,
    PlatformModule,
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        secret: config.auth.jwtAccessSecret,
        signOptions: { expiresIn: config.auth.jwtAccessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController, PlatformAuthController, MeController, AccountController],
  providers: [
    AuthService,
    AccountService,
    IdentityRepository,
    UserTokenRepository,
    PasswordService,
    TokenService,
    TokenHashService,
    SessionDenyList,
    SessionCookieService,
    JwtAuthGuard,
  ],
  exports: [
    AuthService,
    TokenService,
    TokenHashService,
    SessionDenyList,
    JwtAuthGuard,
    // Exported for the invitation flow, which has to create and activate
    // accounts. Duplicating either would be worse: a second account-creation
    // path is a second place for the RLS and status rules to drift, and a
    // second hashing scheme is how peppers get mismatched. Reach is still
    // bounded — IdentityRepository's PlatformPrismaService use is allowlisted
    // by exact path in packages/eslint-config/nest.js, so a new consumer
    // cannot quietly copy the pattern elsewhere.
    IdentityRepository,
    PasswordService,
  ],
})
export class AuthModule {}
