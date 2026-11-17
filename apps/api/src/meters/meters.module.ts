import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';
import { mskParts } from '../common/time';
import { PushService } from '../push/push.service';

const MIN_PHOTOS = 2, MAX_PHOTOS = 6;
const MAX_VALUE = 99_999_999;
const MONEY = { maxDecimalPlaces: 2 };

class SubmitDto {
  @IsInt() garageId: number;
  @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(MAX_VALUE) value: number;
  /** Дата и время с телефона (ISO, с часовым поясом) */
  @IsDateString() takenAt: string;
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
  @IsArray() @ArrayMinSize(MIN_PHOTOS, { message: `Нужно минимум ${MIN_PHOTOS} фото` }) @ArrayMaxSize(MAX_PHOTOS)
  @IsUUID('4', { each: true }) fileIds: string[];
}

class EditDto {
  @IsNumber({ maxDecimalPlaces: 1 }) @Min(0) @Max(MAX_VALUE) value: number;
}

class AcceptDto {
  /** Ручная корректировка суммы начисления (нужно право charges.edit) */
  @IsOptional() @IsNumber(MONEY) @Min(0) @Max(10_000_000) amount?: number;
}

class ListQuery {
  @IsOptional() @Type(() => Number) @IsInt() garageId?: number;
  @IsOptional() @IsIn(['PENDING', 'ACCEPTED']) status?: 'PENDING' | 'ACCEPTED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

/**
 * Кто передал показание: сотрудникам (телефон — только при праве users.view) и самому автору. Жителю не показываем
 * чужих: история гаража видна и новому владельцу, и совладельцам, а ФИО и телефон прежнего владельца — его личные данные.
 */
function submitter(r: any, u: AuthUser) {
  if (!r.user) return undefined;
  const staff = u.portalAccess && u.permissions.includes('meters.view');
  if (!staff && r.user.id !== u.id) return undefined;
  const phone = r.user.id === u.id || (staff && u.permissions.includes('users.view'));
  return { id: r.user.id, fullName: r.user.fullName, ...(phone ? { phone: r.user.phone } : {}) };
}

const readingView = (r: any, u: AuthUser) => ({
  id: r.id, garageId: r.garageId, garageNumber: r.garage?.number, value: r.value.toNumber(),
  takenAt: r.takenAt, createdAt: r.createdAt, comment: r.comment, status: r.status,
  acceptedAt: r.acceptedAt, acceptedBy: r.acceptedBy ?? null,
  photos: (r.photos ?? []).map((p: any) => p.fileId),
  submittedBy: submitter(r, u),
  isMine: r.userId === u.id,
  charge: r.charge ? { id: r.charge.id, amount: r.charge.amount.toNumber(), voided: !!r.charge.voidedAt } : null,
});

@Injectable()
class MetersService {
  constructor(private prisma: PrismaService, private audit: AuditService, private finance: FinanceService, private push: PushService) {}

  private include = {
    garage: { select: { number: true } },
    photos: { orderBy: { id: 'asc' as const } },
    user: { select: { id: true, fullName: true, phone: true } },
    charge: true,
  };

  private async withAcceptor(rows: any[]) {
    const ids = [...new Set(rows.map((r) => r.acceptedById).filter(Boolean))] as number[];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } }) : [];
    const m = new Map(users.map((u) => [u.id, u]));
    return rows.map((r) => ({ ...r, acceptedBy: r.acceptedById ? m.get(r.acceptedById) ?? { id: r.acceptedById, fullName: null } : null }));
  }

  private isOwner(userId: number, garageId: number) {
    return this.prisma.garageOwner.findFirst({ where: { userId, garageId, toDate: null } });
  }

  async submit(dto: SubmitDto, u: AuthUser, req: Request) {
    if (!(await this.isOwner(u.id, dto.garageId))) throw new ForbiddenException('Это не ваш гараж');
    const takenAt = new Date(dto.takenAt);
    const now = Date.now();
    if (takenAt.getTime() > now + 10 * 60_000) throw new BadRequestException('Дата с телефона в будущем. Проверьте дату и время на телефоне');
    if (takenAt.getTime() < now - 3 * 86400_000) throw new BadRequestException('Дата с телефона слишком старая. Проверьте дату и время на телефоне');
    if (new Set(dto.fileIds).size !== dto.fileIds.length) throw new BadRequestException('Повторяющиеся фото');

    const files = await this.prisma.fileAsset.findMany({ where: { id: { in: dto.fileIds }, kind: 'meter', ownerId: u.id } });
    if (files.length !== dto.fileIds.length) throw new BadRequestException('Фото не найдены (загрузите заново)');
    const used = await this.prisma.meterPhoto.count({ where: { fileId: { in: dto.fileIds } } });
    if (used) throw new BadRequestException('Фото уже использованы в другом показании');

    const last = await this.prisma.meterReading.findFirst({ where: { garageId: dto.garageId }, orderBy: [{ takenAt: 'desc' }, { id: 'desc' }] });
    if (last && new Prisma.Decimal(dto.value).lt(last.value)) {
      throw new BadRequestException(`Показание меньше предыдущего (${last.value}). Проверьте цифры на счётчике`);
    }

    const r = await this.prisma.meterReading.create({
      data: {
        garageId: dto.garageId, userId: u.id, value: dto.value, takenAt, comment: dto.comment,
        photos: { create: dto.fileIds.map((fileId) => ({ fileId })) },
      },
      include: this.include,
    });
    await this.audit.log({ action: 'meter.submit', entity: 'MeterReading', entityId: r.id, after: { garageId: r.garageId, value: dto.value, photos: dto.fileIds.length } }, req);
    return readingView({ ...r, acceptedBy: null }, u);
  }

  async my(u: AuthUser, q: ListQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 20;
    const owned = (await this.prisma.garageOwner.findMany({ where: { userId: u.id, toDate: null }, select: { garageId: true } })).map((o) => o.garageId);
    const garageIds = q.garageId ? owned.filter((g) => g === q.garageId) : owned;
    const where = { garageId: { in: garageIds } };
    const [total, rows, last] = await Promise.all([
      this.prisma.meterReading.count({ where }),
      this.prisma.meterReading.findMany({ where, orderBy: [{ takenAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * size, take: size, include: this.include }),
      q.garageId && garageIds.length
        ? this.prisma.meterReading.findFirst({ where, orderBy: [{ takenAt: 'desc' }, { id: 'desc' }] })
        : null,
    ]);
    return { total, page, pageSize: size, lastValue: last?.value.toNumber() ?? null, items: (await this.withAcceptor(rows)).map((x) => readingView(x, u)) };
  }

  async list(q: ListQuery, u: AuthUser) {
    const page = q.page ?? 1, size = q.pageSize ?? 25;
    const where: Prisma.MeterReadingWhereInput = { garageId: q.garageId, status: q.status };
    const [total, rows] = await Promise.all([
      this.prisma.meterReading.count({ where }),
      this.prisma.meterReading.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], skip: (page - 1) * size, take: size, include: this.include }),
    ]);
    return { total, page, pageSize: size, items: (await this.withAcceptor(rows)).map((x) => readingView(x, u)) };
  }

  async get(id: number, u: AuthUser) {
    const r = await this.prisma.meterReading.findUnique({ where: { id }, include: this.include });
    if (!r) throw new NotFoundException('Показание не найдено');
    const staff = u.portalAccess && u.permissions.includes('meters.view');
    if (!staff && !(await this.isOwner(u.id, r.garageId))) throw new NotFoundException('Показание не найдено');
    return readingView((await this.withAcceptor([r]))[0], u);
  }

  async edit(id: number, dto: EditDto, u: AuthUser, req: Request) {
    const before = await this.prisma.meterReading.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    if (before.status !== 'PENDING') throw new BadRequestException('Принятое показание изменить нельзя');
    // условие status в самом запросе: если показание приняли между проверкой и записью, значение не изменится
    const upd = await this.prisma.meterReading.updateMany({ where: { id, status: 'PENDING' }, data: { value: dto.value } });
    if (!upd.count) throw new BadRequestException('Принятое показание изменить нельзя');
    const after = await this.prisma.meterReading.findUniqueOrThrow({ where: { id } });
    await this.audit.log({ action: 'meter.edit', entity: 'MeterReading', entityId: id, before: { value: before.value }, after: { value: after.value } }, req);
    return this.get(id, u);
  }

  async accept(id: number, dto: AcceptDto, u: AuthUser, req: Request) {
    const r = await this.prisma.meterReading.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    if (r.status === 'ACCEPTED') throw new BadRequestException('Уже принято');
    if (dto.amount !== undefined && !u.permissions.includes('charges.edit')) throw new ForbiddenException('Корректировать сумму может только бухгалтер');

    const calc = await this.finance.electricityCalc(r.garageId, r.value.toNumber(), r.id);
    const amount = dto.amount ?? calc.amount;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // защита от гонки: принимаем только если всё ещё PENDING
      const upd = await tx.meterReading.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'ACCEPTED', acceptedAt: now, acceptedById: u.id } });
      if (!upd.count) throw new BadRequestException('Уже принято');
      if (amount > 0) {
        await tx.charge.create({
          data: {
            garageId: r.garageId, type: 'ELECTRICITY', amount, readingId: id, createdById: u.id, period: mskParts(now).ym,
            description: `Электроэнергия: ${calc.previous ?? '—'} → ${r.value} (${calc.consumption} кВт·ч × ${calc.price} ₽)`,
          },
        });
      }
    });
    await this.audit.log({ action: 'meter.accept', entity: 'MeterReading', entityId: id, after: { calc, charged: amount, overridden: dto.amount !== undefined } }, req);
    this.push.notify([r.userId], { title: 'Показания приняты', body: `Показание ${r.value} кВт·ч принято правлением`, url: '/meters', tag: 'meter' });
    return { ...(await this.get(id, u)), calc };
  }
}

@Controller('meters')
class MetersController {
  constructor(private s: MetersService) {}

  @Post() @HttpCode(201)
  submit(@Body() dto: SubmitDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.submit(dto, u, req); }

  @Get('my')
  my(@Query() q: ListQuery, @CurrentUser() u: AuthUser) { return this.s.my(u, q); }

  @Get() @RequirePermissions('meters.view')
  list(@Query() q: ListQuery, @CurrentUser() u: AuthUser) { return this.s.list(q, u); }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }

  @Patch(':id') @RequirePermissions('meters.accept')
  edit(@Param("id", ParseIntPipe) id: number, @Body() dto: EditDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.edit(id, dto, u, req); }

  @Post(':id/accept') @HttpCode(200) @RequirePermissions('meters.accept')
  accept(@Param('id', ParseIntPipe) id: number, @Body() dto: AcceptDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.accept(id, dto, u, req); }
}

@Module({ imports: [FinanceModule], controllers: [MetersController], providers: [MetersService] })
export class MetersModule {}
