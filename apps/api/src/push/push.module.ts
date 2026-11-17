import { BadRequestException, Body, Controller, Delete, Get, Global, HttpCode, Module, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { FinanceModule } from '../finance/finance.module';
import { isPushServiceUrl } from '../common/push-url';
import { PushService, PushSettings } from './push.service';

class DeviceDto {
  @IsIn(['fcm', 'webpush']) platform: 'fcm' | 'webpush';
  /** FCM: токен. Web Push: JSON подписки (endpoint + keys) строкой */
  @IsString() @MaxLength(4000) token: string;
}

class TokenDto {
  @IsString() @MaxLength(4000) token: string;
}

class RunDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsBoolean() force?: boolean;
}

class SettingsDto implements PushSettings {
  @IsInt() @Min(1) @Max(28) debtReminderDay: number;
  @IsInt() @Min(0) @Max(23) windowFromHour: number;
  @IsInt() @Min(1) @Max(24) windowToHour: number;
}

@Controller('push')
class PushController {
  constructor(private push: PushService, private audit: AuditService) {}

  @Get('config')
  config() { return this.push.config(); }

  @Post('devices') @HttpCode(204)
  async register(@Body() dto: DeviceDto, @CurrentUser() u: AuthUser) {
    if (dto.platform === 'webpush') {
      try {
        const s = JSON.parse(dto.token);
        if (!s?.keys?.p256dh || !s?.keys?.auth || !isPushServiceUrl(s.endpoint)) throw new Error();
      } catch {
        throw new BadRequestException('Некорректная подписка Web Push');
      }
    }
    await this.push.registerDevice(u.id, dto.platform, dto.token);
  }

  @Delete('devices') @HttpCode(204)
  unregister(@Body() dto: TokenDto, @CurrentUser() u: AuthUser) { return this.push.unregisterDevice(u.id, dto.token); }

  /** Тестовое уведомление себе */
  @Post('test') @HttpCode(200) @Throttle({ default: { limit: 5, ttl: 60_000 } })
  test(@CurrentUser() u: AuthUser) {
    return this.push.sendToUsers([u.id], { title: 'ГСК «Родник»', body: 'Тестовое уведомление', url: '/' });
  }

  @Get('settings') @RequirePermissions('settings.finance')
  settings() { return this.push.settings(); }

  @Put('settings') @RequirePermissions('settings.finance')
  async setSettings(@Body() dto: SettingsDto, @Req() req: Request) {
    // при «с 18 до 9» окно пустое и напоминания не уходили бы никогда
    if (dto.windowFromHour >= dto.windowToHour) throw new BadRequestException('Начало окна отправки должно быть раньше конца');
    const before = await this.push.settings();
    await this.push.setSettings(dto);
    await this.audit.log({ action: 'push.settings', entity: 'Setting', entityId: 'push', before, after: dto }, req);
    return dto;
  }

  @Post('debt-reminders') @HttpCode(200) @RequirePermissions('charges.edit')
  async run(@Body() dto: RunDto, @Req() req: Request) {
    const r = await this.push.runDebtReminders({ dryRun: dto.dryRun, force: true });
    await this.audit.log({ action: 'push.debt_reminders.manual', after: { ...r, dryRun: !!dto.dryRun } }, req);
    return r;
  }
}

@Global()
@Module({ imports: [FinanceModule], controllers: [PushController], providers: [PushService], exports: [PushService] })
export class PushModule {}
