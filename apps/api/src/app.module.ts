import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditCoreModule } from './audit/audit.service';
import { AuditModule } from './audit/audit.module';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { Public } from './auth/decorators';
import { SecurityPolicyController, TwoFactorController } from './auth/twofactor.controller';
import { SecurityPolicyService, TwoFactorService } from './auth/twofactor.service';
import { PrismaModule, PrismaService } from './common/prisma.service';
import { ExcelModule } from './excel/excel.module';
import { FinanceModule } from './finance/finance.module';
import { AdsModule } from './ads/ads.module';
import { FilesModule } from './files/files.module';
import { GaragesModule } from './garages/garages.module';
import { MailModule } from './mail/mail.module';
import { MapModule } from './map/map.module';
import { MetersModule } from './meters/meters.module';
import { PushModule } from './push/push.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { ReleasesModule } from './releases/releases.module';
import { ScheduleModule } from './schedule/schedule.module';
import { NewsModule } from './news/news.module';
import { RolesModule } from './roles/roles.module';
import { UsersModule } from './users/users.module';

@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  /** Проверка для деплоя и мониторинга: процесс жив и база отвечает */
  @Public() @Get()
  async ok() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: { expiresIn: `${Number(cfg.get('ACCESS_TTL_MIN') ?? 15)}m` },
      }),
    }),
    PrismaModule,
    AuditCoreModule,
    AuditModule,
    UsersModule,
    GaragesModule,
    FinanceModule,
    FilesModule,
    MetersModule,
    NewsModule,
    AdsModule,
    PushModule,
    ScheduleModule,
    ReleasesModule,
    MapModule,
    MailModule,
    ExcelModule,
    ReceiptsModule,
    RolesModule,
  ],
  controllers: [AuthController, TwoFactorController, SecurityPolicyController, HealthController],
  providers: [
    AuthService,
    TwoFactorService,
    SecurityPolicyService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
