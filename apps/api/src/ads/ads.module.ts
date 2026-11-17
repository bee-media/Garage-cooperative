import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module,
  NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseIntPipe, Patch, Post, Put, Query, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { FilesModule, FilesService } from '../files/files.module';
import { PushService } from '../push/push.service';

const MAX_PHOTOS = 5;
const DEFAULT_TTL_DAYS = 30;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const TYPES = ['SALE', 'RENT'];

class AdDto {
  @Transform(trim) @IsString() @Matches(/^[0-9A-Za-zА-Яа-я\-/]{1,12}$/, { message: 'Некорректный номер гаража' }) garageNumber: string;
  @IsIn(TYPES) type: 'SALE' | 'RENT';
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000_000) price: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PHOTOS, { message: `Не более ${MAX_PHOTOS} фото` }) @IsUUID('4', { each: true }) fileIds?: string[];
}

class UpdateAdDto {
  @IsOptional() @Transform(trim) @IsString() @Matches(/^[0-9A-Za-zА-Яа-я\-/]{1,12}$/) garageNumber?: string;
  @IsOptional() @IsIn(TYPES) type?: 'SALE' | 'RENT';
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000_000) price?: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PHOTOS) @IsUUID('4', { each: true }) fileIds?: string[];
}

class RejectDto {
  @Transform(trim) @IsString() @MinLength(3, { message: 'Укажите причину отклонения' }) @MaxLength(500) reason: string;
}

class ReportDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(500) reason: string;
}

class SettingsDto {
  @IsInt() @Min(1) @Max(365) ttlDays: number;
}

class ListQuery {
  @IsOptional() @IsIn(TYPES) type?: 'SALE' | 'RENT';
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) q?: string;
  @IsOptional() @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'ARCHIVED']) status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ARCHIVED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
}

class ModerationQuery extends ListQuery {
  @IsOptional() @IsIn(["1"]) reported?: string;
}

const INCLUDE = {
  photos: { orderBy: { sort: 'asc' as const } },
  user: { select: { id: true, fullName: true, phone: true, deletedAt: true } },
  _count: { select: { reports: true } },
};

/**
 * Признак «объявление было опубликовано в текущей редакции»: срок показа задаёт только одобрение, а правка (возврат
 * на модерацию) его сбрасывает. По `moderatedAt` судить нельзя: его ставит и отклонение — тогда отклонённое
 * объявление, отправленное автором в архив, становилось видно всем.
 */
const WAS_PUBLISHED: Prisma.AdWhereInput = { expiresAt: { not: null } };

@Injectable()
class AdsService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(private prisma: PrismaService, private audit: AuditService, private files: FilesService, private push: PushService) {}

  onModuleInit() {
    // Автоархив по сроку: проверяем раз в час
    this.timer = setInterval(() => void this.archiveExpired().catch((e) => console.error('ads auto-archive', e)), 3600_000);
    this.timer.unref();
    void this.archiveExpired().catch(() => undefined);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async ttlDays() {
    const s = await this.prisma.setting.findUnique({ where: { key: 'ads' } });
    return Number((s?.value as any)?.ttlDays) || DEFAULT_TTL_DAYS;
  }

  async archiveExpired() {
    const now = new Date();
    const r = await this.prisma.ad.updateMany({
      where: { status: 'APPROVED', expiresAt: { lte: now } },
      data: { status: 'ARCHIVED', archivedAt: now },
    });
    if (r.count) await this.audit.log({ action: 'ad.auto_archive', entity: 'Ad', after: { count: r.count }, actor: null });
    return r.count;
  }

  private isModerator(u: AuthUser) {
    return u.portalAccess && u.permissions.includes('ads.moderate');
  }

  private view(a: any, u: AuthUser) {
    const mod = this.isModerator(u);
    const own = a.userId === u.id;
    return {
      id: a.id, garageNumber: a.garageNumber, type: a.type, price: a.price.toNumber(), description: a.description,
      status: a.status, createdAt: a.createdAt, updatedAt: a.updatedAt, expiresAt: a.expiresAt, archivedAt: a.archivedAt,
      photos: a.photos.map((p: any) => p.fileId),
      phone: a.user.deletedAt ? null : a.user.phone, // виден всем авторизованным (требование заказчика); удалённого — нет
      isMine: own,
      // служебные поля: автору и модераторам
      ...(own || mod ? { rejectReason: a.rejectReason } : {}),
      ...(mod ? { author: { id: a.user.id, fullName: a.user.fullName }, reportCount: a._count?.reports ?? 0, moderatedAt: a.moderatedAt } : {}),
    };
  }

  private async checkFiles(adId: number | null, fileIds: string[], u: AuthUser) {
    if (new Set(fileIds).size !== fileIds.length) throw new BadRequestException('Повторяющиеся фото');
    if (!fileIds.length) return;
    const own = await this.prisma.fileAsset.findMany({ where: { id: { in: fileIds }, kind: 'ad', ownerId: u.id } });
    if (own.length !== fileIds.length) throw new BadRequestException('Фото не найдены (загрузите заново)');
    const used = await this.prisma.adPhoto.count({ where: { fileId: { in: fileIds }, ...(adId ? { adId: { not: adId } } : {}) } });
    if (used) throw new BadRequestException('Фото уже используются в другом объявлении');
  }

  /** Объявление можно подать только по своему гаражу (модератор — по любому) */
  private async garageByNumber(number: string, u: AuthUser) {
    const g = await this.prisma.garage.findFirst({ where: { number, status: 'ACTIVE' } });
    if (!g) throw new BadRequestException(`Гараж №${number} не найден`);
    if (!this.isModerator(u)) {
      const own = await this.prisma.garageOwner.findFirst({ where: { garageId: g.id, userId: u.id, toDate: null } });
      if (!own) throw new ForbiddenException(`Гараж №${number} не числится за вами`);
    }
    return g;
  }

  // ───────── доска ─────────

  /** Публичная доска: только одобренные, новые сверху */
  async board(u: AuthUser, q: ListQuery, archive = false) {
    const page = q.page ?? 1, size = q.pageSize ?? 10;
    const where: Prisma.AdWhereInput = archive
      ? { status: 'ARCHIVED', ...WAS_PUBLISHED } // в архив попадают только те, что были опубликованы
      : { status: 'APPROVED' };
    if (q.type) where.type = q.type;
    if (q.q) where.garageNumber = { contains: q.q, mode: 'insensitive' };
    const order: Prisma.AdOrderByWithRelationInput[] = archive
      ? [{ archivedAt: 'desc' }, { id: 'desc' }]
      : [{ moderatedAt: 'desc' }, { id: 'desc' }];
    const [total, rows] = await Promise.all([
      this.prisma.ad.count({ where }),
      this.prisma.ad.findMany({ where, orderBy: order, skip: (page - 1) * size, take: size, include: INCLUDE }),
    ]);
    return { total, page, pageSize: size, items: rows.map((a) => this.view(a, u)) };
  }

  async mine(u: AuthUser, q: ListQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 20;
    const where: Prisma.AdWhereInput = { userId: u.id, ...(q.status ? { status: q.status } : {}) };
    const [total, rows] = await Promise.all([
      this.prisma.ad.count({ where }),
      this.prisma.ad.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size, include: INCLUDE }),
    ]);
    return { total, page, pageSize: size, items: rows.map((a) => this.view(a, u)) };
  }

  async get(id: number, u: AuthUser) {
    const a = await this.prisma.ad.findUnique({ where: { id }, include: INCLUDE });
    if (!a) throw new NotFoundException('Объявление не найдено');
    const visible = a.status === 'APPROVED' || (a.status === 'ARCHIVED' && a.expiresAt) || a.userId === u.id || this.isModerator(u);
    if (!visible) throw new NotFoundException('Объявление не найдено');
    return this.view(a, u);
  }

  async create(dto: AdDto, u: AuthUser, req: Request) {
    const g = await this.garageByNumber(dto.garageNumber, u);
    await this.checkFiles(null, dto.fileIds ?? [], u);
    const a = await this.prisma.ad.create({
      data: {
        userId: u.id, garageId: g.id, garageNumber: g.number, type: dto.type, price: dto.price, description: dto.description,
        photos: { create: (dto.fileIds ?? []).map((fileId, sort) => ({ fileId, sort })) },
      },
      include: INCLUDE,
    });
    await this.audit.log({ action: 'ad.create', entity: 'Ad', entityId: a.id, after: { garage: g.number, type: a.type, price: dto.price } }, req);
    return this.view(a, u);
  }

  /** Правка автором (или модератором) возвращает объявление на модерацию. */
  async update(id: number, dto: UpdateAdDto, u: AuthUser, req: Request) {
    const before = await this.prisma.ad.findUnique({ where: { id }, include: { photos: true } });
    if (!before) throw new NotFoundException('Объявление не найдено');
    if (before.userId !== u.id && !this.isModerator(u)) throw new NotFoundException('Объявление не найдено');
    const data: Prisma.AdUncheckedUpdateInput = {
      type: dto.type, price: dto.price, description: dto.description,
      status: 'PENDING', rejectReason: null, moderatedAt: null, moderatedById: null, expiresAt: null, archivedAt: null,
    };
    if (dto.garageNumber) {
      const g = await this.garageByNumber(dto.garageNumber, u);
      data.garageId = g.id; data.garageNumber = g.number;
    }
    // фото принадлежат автору объявления
    const owner = before.userId === u.id ? u : ({ ...u, id: before.userId } as AuthUser);
    if (dto.fileIds) await this.checkFiles(id, dto.fileIds, owner);
    const removed = dto.fileIds ? before.photos.filter((p) => !dto.fileIds!.includes(p.fileId)).map((p) => p.fileId) : [];

    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.fileIds) {
        await tx.adPhoto.deleteMany({ where: { adId: id } });
        await tx.adPhoto.createMany({ data: dto.fileIds.map((fileId, sort) => ({ adId: id, fileId, sort })) });
      }
      return tx.ad.update({ where: { id }, data, include: INCLUDE });
    });
    await this.files.remove(removed);
    await this.audit.log({ action: 'ad.update', entity: 'Ad', entityId: id, before: { garage: before.garageNumber, type: before.type, price: before.price, description: before.description, status: before.status }, after: { garage: after.garageNumber, type: after.type, price: after.price, description: after.description, status: after.status } }, req);
    return this.view(after, u);
  }

  async archive(id: number, u: AuthUser, req: Request) {
    const a = await this.prisma.ad.findUnique({ where: { id } });
    if (!a || (a.userId !== u.id && !this.isModerator(u))) throw new NotFoundException('Объявление не найдено');
    if (a.status === 'ARCHIVED') throw new BadRequestException('Уже в архиве');
    await this.prisma.ad.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    await this.audit.log({ action: 'ad.archive', entity: 'Ad', entityId: id, before: { status: a.status } }, req);
  }

  async remove(id: number, req: Request) {
    const a = await this.prisma.ad.findUnique({ where: { id }, include: { photos: true } });
    if (!a) throw new NotFoundException();
    await this.prisma.ad.delete({ where: { id } });
    await this.files.remove(a.photos.map((p) => p.fileId));
    await this.audit.log({ action: 'ad.delete', entity: 'Ad', entityId: id, before: { garage: a.garageNumber, type: a.type, price: a.price, description: a.description, userId: a.userId } }, req);
  }

  // ───────── модерация ─────────

  async moderationList(u: AuthUser, q: ModerationQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 25;
    const where: Prisma.AdWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.reported === '1' ? { reports: { some: {} } } : {}),
      ...(q.q ? { garageNumber: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [total, rows, pending] = await Promise.all([
      this.prisma.ad.count({ where }),
      // непроверенные сверху, дальше по дате
      this.prisma.ad.findMany({ where, orderBy: [{ status: 'asc' }, { id: 'desc' }], skip: (page - 1) * size, take: size, include: INCLUDE }),
      this.prisma.ad.count({ where: { status: 'PENDING' } }),
    ]);
    return { total, page, pageSize: size, pendingCount: pending, items: rows.map((a) => this.view(a, u)) };
  }

  async approve(id: number, u: AuthUser, req: Request) {
    const a = await this.prisma.ad.findUnique({ where: { id } });
    if (!a) throw new NotFoundException();
    if (a.status !== 'PENDING') throw new BadRequestException('Объявление не на модерации');
    const ttl = await this.ttlDays();
    const now = new Date();
    await this.prisma.ad.update({
      where: { id },
      data: { status: 'APPROVED', moderatedAt: now, moderatedById: u.id, rejectReason: null, expiresAt: new Date(now.getTime() + ttl * 86400_000) },
    });
    await this.audit.log({ action: 'ad.approve', entity: 'Ad', entityId: id, after: { ttlDays: ttl } }, req);
    this.push.notify([a.userId], { title: 'Объявление опубликовано', body: `Гараж №${a.garageNumber}: объявление одобрено`, url: `/ads/${id}`, tag: 'ad' });
  }

  async reject(id: number, dto: RejectDto, u: AuthUser, req: Request) {
    const a = await this.prisma.ad.findUnique({ where: { id } });
    if (!a) throw new NotFoundException();
    if (a.status !== 'PENDING') throw new BadRequestException('Объявление не на модерации');
    await this.prisma.ad.update({
      where: { id }, data: { status: 'REJECTED', rejectReason: dto.reason, moderatedAt: new Date(), moderatedById: u.id },
    });
    await this.audit.log({ action: 'ad.reject', entity: 'Ad', entityId: id, after: { reason: dto.reason } }, req);
    this.push.notify([a.userId], { title: 'Объявление отклонено', body: dto.reason, url: `/ads/${id}`, tag: 'ad' });
  }

  // ───────── жалобы ─────────

  async report(id: number, dto: ReportDto, u: AuthUser, req: Request) {
    const a = await this.prisma.ad.findUnique({ where: { id } });
    if (!a || a.status !== 'APPROVED') throw new NotFoundException('Объявление не найдено');
    if (a.userId === u.id) throw new BadRequestException('Нельзя жаловаться на своё объявление');
    if (await this.prisma.adReport.findFirst({ where: { adId: id, userId: u.id } })) throw new BadRequestException('Вы уже отправляли жалобу на это объявление');
    await this.prisma.adReport.create({ data: { adId: id, userId: u.id, reason: dto.reason } });
    await this.audit.log({ action: 'ad.report', entity: 'Ad', entityId: id, after: { reason: dto.reason } }, req);
  }

  async reports(id: number) {
    const rows = await this.prisma.adReport.findMany({ where: { adId: id }, orderBy: { createdAt: 'desc' } });
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true, phone: true } });
    const m = new Map(users.map((x) => [x.id, x]));
    return rows.map((r) => ({ id: r.id, reason: r.reason, createdAt: r.createdAt, user: m.get(r.userId) ?? null }));
  }

  async dismissReports(id: number, req: Request) {
    const r = await this.prisma.adReport.deleteMany({ where: { adId: id } });
    await this.audit.log({ action: 'ad.reports_dismiss', entity: 'Ad', entityId: id, after: { count: r.count } }, req);
  }

  async setTtl(dto: SettingsDto, req: Request) {
    const before = await this.ttlDays();
    await this.prisma.setting.upsert({ where: { key: 'ads' }, update: { value: { ttlDays: dto.ttlDays } }, create: { key: 'ads', value: { ttlDays: dto.ttlDays } } });
    await this.audit.log({ action: 'ads.settings', entity: 'Setting', entityId: 'ads', before: { ttlDays: before }, after: dto }, req);
    return dto;
  }
}

@Controller('ads')
class AdsController {
  constructor(private s: AdsService) {}

  @Get() board(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.s.board(u, q); }
  @Get('archive') archiveList(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.s.board(u, q, true); }
  @Get('my') mine(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.s.mine(u, q); }

  @Get('moderation') @RequirePermissions('ads.moderate')
  moderation(@CurrentUser() u: AuthUser, @Query() q: ModerationQuery) { return this.s.moderationList(u, q); }

  @Get('settings') @RequirePermissions('ads.moderate')
  async getSettings() { return { ttlDays: await this.s.ttlDays() }; }

  @Put('settings') @RequirePermissions('ads.moderate')
  setSettings(@Body() dto: SettingsDto, @Req() req: Request) { return this.s.setTtl(dto, req); }

  @Post() @HttpCode(201)
  create(@Body() dto: AdDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.create(dto, u, req); }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateAdDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.update(id, dto, u, req); }

  @Post(':id/archive') @HttpCode(204)
  archive(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.archive(id, u, req); }

  @Post(':id/report') @HttpCode(204)
  report(@Param('id', ParseIntPipe) id: number, @Body() dto: ReportDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.report(id, dto, u, req); }

  @Post(':id/approve') @HttpCode(204) @RequirePermissions('ads.moderate')
  approve(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.approve(id, u, req); }

  @Post(':id/reject') @HttpCode(204) @RequirePermissions('ads.moderate')
  reject(@Param('id', ParseIntPipe) id: number, @Body() dto: RejectDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.reject(id, dto, u, req); }

  @Get(':id/reports') @RequirePermissions('ads.moderate')
  reports(@Param('id', ParseIntPipe) id: number) { return this.s.reports(id); }

  @Delete(':id/reports') @HttpCode(204) @RequirePermissions('ads.moderate')
  dismiss(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.dismissReports(id, req); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('ads.moderate')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.remove(id, req); }
}

@Module({ imports: [FilesModule], controllers: [AdsController], providers: [AdsService] })
export class AdsModule {}
