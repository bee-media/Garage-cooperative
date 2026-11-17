import { Injectable } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsNumber, Max, Min, ValidateNested } from 'class-validator';
import { PrismaService } from '../common/prisma.service';

export class PenaltySettings {
  @IsBoolean() enabled: boolean;
  /** процент от просроченной суммы в день */
  @IsNumber() @Min(0) @Max(5) ratePerDayPercent: number;
  /** дней после начисления, пока пеня не идёт */
  @IsNumber() @Min(0) @Max(365) graceDays: number;
  /** потолок пени, % от просроченного долга */
  @IsNumber() @Min(0) @Max(1000) capPercent: number;
}

export class FinanceSettings {
  /** тариф электроэнергии, ₽ за кВт·ч */
  @IsNumber() @Min(0) @Max(1000) kwhPrice: number;
  /** членский взнос за гараж за один период, ₽ */
  @IsNumber() @Min(0) @Max(10_000_000) membershipFee: number;
  @IsIn(['quarter', 'year']) membershipPeriod: 'quarter' | 'year';
  @ValidateNested() @Type(() => PenaltySettings) penalty: PenaltySettings;
}

export const DEFAULT_FINANCE: FinanceSettings = {
  kwhPrice: 0,
  membershipFee: 0,
  membershipPeriod: 'quarter',
  penalty: { enabled: false, ratePerDayPercent: 0.1, graceDays: 30, capPercent: 100 },
};

@Injectable()
export class FinanceSettingsService {
  constructor(private prisma: PrismaService) {}

  async get(): Promise<FinanceSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'finance' } });
    const v = (row?.value ?? {}) as Partial<FinanceSettings>;
    return { ...DEFAULT_FINANCE, ...v, penalty: { ...DEFAULT_FINANCE.penalty, ...(v.penalty ?? {}) } };
  }

  async set(s: FinanceSettings) {
    await this.prisma.setting.upsert({
      where: { key: 'finance' },
      update: { value: s as any },
      create: { key: 'finance', value: s as any },
    });
  }
}
