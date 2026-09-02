import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig, ConfigModule } from '../config';
import { DatabaseModule } from '../database/database.module';
import { PlatformModule } from '../platform/platform.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AuthController, PlatformAuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { IdentityRepository } from './identity.repository';
import { PasswordService } from './password.service';
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
        secret: config.jwtAccessSecret,
        signOptions: { expiresIn: config.jwtAccessTtlSeconds },
      }),
    }),
  ],
  controllers: [AuthController, PlatformAuthController],
  providers: [
    AuthService,
    IdentityRepository,
    PasswordService,
    TokenService,
    TokenHashService,
    SessionDenyList,
    JwtAuthGuard,
  ],
  exports: [AuthService, TokenService, TokenHashService, SessionDenyList, JwtAuthGuard],
})
export class AuthModule {}
