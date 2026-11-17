import { Body, Controller, Get, HttpCode, Module, Param, ParseIntPipe, Post, Put, Query, Req } from '@nestjs/common';
import { ChargeType } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuditService, type AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { canSeeContacts, maskContacts } from '../common/contacts';
import { FinanceService } from './finance.service';
import { FinanceSettings, FinanceSettingsService } from './finance.settings';

const TYPES = ['ELECTRICITY', 'MEMBERSHIP', 'PENALTY'];
const MONEY = { maxDecimalPlaces: 2 };

class ChargeDto {
  @IsInt() garageId: number;
  @IsIn(TYPES) type: ChargeType;
  @IsNumber(MONEY) @Min(-10_000_000) @Max(10_000_000) amount: number;
  @IsOptional() @IsString() @Matches(/^[0-9A-Za-z\-]{1,20}$/) period?: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
}

class BulkMembershipDto {
  @IsOptional() @IsString() @Matches(/^\d{4}(-Q[1-4])?$/, { message: 'Период: 2026 или 2026-Q4' }) period?: string;
  @IsOptional() @IsNumber(MONEY) @Min(0.01) @Max(10_000_000) amount?: number;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class PaymentDto {
  @IsInt() garageId: number;
  @IsIn(TYPES) type: ChargeType;
  @IsNumber(MONEY) @Min(0.01) @Max(10_000_000) amount: number;
  @IsOptional() @IsDateString() paidAt?: string;
  @IsOptional() @IsIn(['cash', 'card', 'transfer']) method?: string;
  @IsOptional() @IsString() @MaxLength(300) comment?: string;
}

class DryRunDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class DebtsQuery {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(['GREEN', 'ORANGE', 'RED']) color?: 'GREEN' | 'ORANGE' | 'RED';
  @IsOptional() @IsIn(['number', 'debt']) sort?: 'number' | 'debt';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) pageSize?: number;
}

class PreviewQuery {
  @Type(() => Number) @IsInt() garageId: number;
  @Type(() => Number) @IsNumber() @Min(0) value: number;
}

@Controller('finance')
class FinanceController {
  constructor(private s: FinanceService, private settings: FinanceSettingsService, private audit: AuditService) {}

  // — для жителя —
  @Get('my')
  my(@CurrentUser() u: AuthUser) { return this.s.myDebt(u.id); }

  // — настройки —
  @Get('settings') @RequirePermissions('debts.view')
  getSettings() { return this.settings.get(); }

  @Put('settings') @RequirePermissions('settings.finance')
  async putSettings(@Body() dto: FinanceSettings, @Req() req: Request) {
    const before = await this.settings.get();
    await this.settings.set(dto);
    await this.audit.log({ action: 'finance.settings', entity: 'Setting', entityId: 'finance', before, after: dto }, req);
    return dto;
  }

  // — долги —
  @Get('debts') @RequirePermissions('debts.view')
  async debts(@Query() q: DebtsQuery, @CurrentUser() u: AuthUser) {
    const r = await this.s.debts({ ...q, phoneSearch: canSeeContacts(u) });
    return { ...r, items: r.items.map((i) => ({ ...i, owners: i.owners.map((o) => maskContacts(o, u)) })) };
  }

  @Get('summary') @RequirePermissions('debts.view')
  summary() { return this.s.summary(); }

  @Get('garages/:id') @RequirePermissions('debts.view')
  ledger(@Param('id', ParseIntPipe) id: number) { return this.s.ledger(id); }

  // — начисления —
  @Post('charges') @RequirePermissions('charges.edit')
  createCharge(@Body() dto: ChargeDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.createCharge(dto, u.id, req); }

  @Post('charges/membership') @HttpCode(200) @RequirePermissions('charges.edit')
  bulk(@Body() dto: BulkMembershipDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.bulkMembership(dto, u.id, req); }

  @Post('charges/penalties') @HttpCode(200) @RequirePermissions('charges.edit')
  penalties(@Body() dto: DryRunDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.runPenalties(dto, u.id, req); }

  @Post('charges/:id/void') @HttpCode(204) @RequirePermissions('charges.edit')
  voidCharge(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.voidCharge(id, u.id, req); }

  @Get('electricity/preview') @RequirePermissions('charges.edit')
  preview(@Query() q: PreviewQuery) { return this.s.electricityCalc(q.garageId, q.value); }

  // — оплаты —
  @Post('payments') @RequirePermissions('payments.edit')
  createPayment(@Body() dto: PaymentDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.createPayment(dto, u.id, req); }

  @Post('payments/:id/void') @HttpCode(204) @RequirePermissions('payments.edit')
  voidPayment(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.voidPayment(id, u.id, req); }
}

@Module({
  controllers: [FinanceController],
  providers: [FinanceService, FinanceSettingsService],
  exports: [FinanceService, FinanceSettingsService],
})
export class FinanceModule {}
