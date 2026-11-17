import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, NoTwoFactor, RequirePermissions } from './decorators';
import { SecurityPolicyService, TwoFactorService } from './twofactor.service';

class CodeDto {
  @IsString() @MinLength(6) @MaxLength(32) code: string;
}

class PolicyDto {
  @IsBoolean() require2fa: boolean;
}

/** Управление двухфакторной защитой своей учётной записи */
@Controller('auth/2fa')
export class TwoFactorController {
  constructor(private tf: TwoFactorService) {}

  @Get('status')
  @NoTwoFactor()
  status(@CurrentUser() u: AuthUser) {
    return this.tf.status(u.id);
  }

  /** Шаг 1: получить секрет и ссылку для QR-кода */
  @Post('setup')
  @NoTwoFactor()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  setup(@CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.tf.setup(u, req);
  }

  /** Шаг 2: подтвердить первым кодом; в ответе резервные коды (показываются один раз) */
  @Post('enable')
  @NoTwoFactor()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  enable(@CurrentUser() u: AuthUser, @Body() dto: CodeDto, @Req() req: Request) {
    return this.tf.enable(u, dto.code, req);
  }

  @Post('disable')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  disable(@CurrentUser() u: AuthUser, @Body() dto: CodeDto, @Req() req: Request) {
    return this.tf.disable(u, dto.code, req);
  }

  /** Сброс 2FA сотруднику (потерян телефон). Права как у выдачи паролей; сессии пользователя завершаются */
  @Post('reset/:userId')
  @HttpCode(204)
  @RequirePermissions('passwords.issue')
  reset(@Param('userId', ParseIntPipe) userId: number, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.tf.reset(userId, u, req);
  }

  @Post('backup-codes')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  backupCodes(@CurrentUser() u: AuthUser, @Body() dto: CodeDto, @Req() req: Request) {
    return this.tf.regenerateBackupCodes(u, dto.code, req);
  }
}

/** Политика: обязательна ли 2FA для сотрудников правления */
@Controller('auth/security-policy')
export class SecurityPolicyController {
  constructor(private policy: SecurityPolicyService, private audit: AuditService) {}

  @Get()
  @NoTwoFactor()
  async get() {
    return { require2fa: await this.policy.require2fa() };
  }

  @Put()
  @RequirePermissions('roles.manage')
  async set(@Body() dto: PolicyDto, @Req() req: Request) {
    const before = await this.policy.require2fa();
    await this.policy.set(dto.require2fa);
    await this.audit.log({ action: 'security.policy', entity: 'Setting', entityId: 'security', before: { require2fa: before }, after: dto }, req);
    return dto;
  }
}
