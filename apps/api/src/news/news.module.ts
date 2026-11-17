import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Query, Req,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { FilesModule, FilesService } from '../files/files.module';
import { PushService } from '../push/push.service';

const MAX_PHOTOS = 10;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class NewsDto {
  @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) title: string;
  /** Обычный текст (переносы строк сохраняются). HTML не поддерживается намеренно. */
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(10000) body: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PHOTOS) @IsUUID('4', { each: true }) fileIds?: string[];
}

class UpdateNewsDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(10000) body?: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_PHOTOS) @IsUUID('4', { each: true }) fileIds?: string[];
}

class ListQuery {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) pageSize?: number;
  @IsOptional() @IsIn(['PUBLISHED', 'HIDDEN']) status?: 'PUBLISHED' | 'HIDDEN';
}

@Injectable()
export class NewsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private files: FilesService, private push: PushService) {}

  private view(n: any, readSet?: Set<number>) {
    return {
      id: n.id, title: n.title, body: n.body, pinned: n.pinned, status: n.status,
      publishedAt: n.publishedAt, updatedAt: n.updatedAt,
      photos: (n.photos ?? []).map((p: any) => p.fileId),
      ...(readSet ? { isRead: readSet.has(n.id) } : {}),
      ...(n._count ? { readCount: n._count.reads } : {}),
    };
  }

  private async attachFiles(newsId: number | null, fileIds: string[], u: AuthUser) {
    if (new Set(fileIds).size !== fileIds.length) throw new BadRequestException('Повторяющиеся фото');
    if (!fileIds.length) return;
    const files = await this.prisma.fileAsset.findMany({
      where: { id: { in: fileIds }, kind: 'news', OR: [{ ownerId: u.id }, ...(newsId ? [{ newsPhotos: { some: { newsId } } }] : [])] },
    });
    if (files.length !== fileIds.length) throw new BadRequestException('Фото не найдены (загрузите заново)');
    const used = await this.prisma.newsPhoto.count({ where: { fileId: { in: fileIds }, ...(newsId ? { newsId: { not: newsId } } : {}) } });
    if (used) throw new BadRequestException('Фото уже используются в другой новости');
  }

  // ───────── жители ─────────

  async list(u: AuthUser, q: ListQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 5;
    const where: Prisma.NewsWhereInput = {
      status: 'PUBLISHED',
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { body: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    // Закреплённые выше, дальше новые сверху
    const [total, rows, unread] = await Promise.all([
      this.prisma.news.count({ where }),
      this.prisma.news.findMany({
        where, orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * size, take: size, include: { photos: { orderBy: { sort: 'asc' } } },
      }),
      this.prisma.news.count({ where: { status: 'PUBLISHED', reads: { none: { userId: u.id } } } }),
    ]);
    const reads = await this.prisma.newsRead.findMany({ where: { userId: u.id, newsId: { in: rows.map((r) => r.id) } } });
    const set = new Set(reads.map((r) => r.newsId));
    return { total, page, pageSize: size, unreadCount: unread, items: rows.map((r) => this.view(r, set)) };
  }

  async get(id: number, u: AuthUser) {
    const staff = u.portalAccess && u.permissions.includes('news.edit');
    const n = await this.prisma.news.findUnique({ where: { id }, include: { photos: { orderBy: { sort: 'asc' } }, _count: { select: { reads: true } } } });
    if (!n || (n.status !== 'PUBLISHED' && !staff)) throw new NotFoundException('Новость не найдена');
    const read = await this.prisma.newsRead.findUnique({ where: { newsId_userId: { newsId: id, userId: u.id } } });
    const v = this.view(n, new Set(read ? [id] : []));
    if (!staff) delete (v as any).readCount;
    return v;
  }

  /** Идемпотентно: повторная отметка ничего не меняет. */
  async markRead(id: number, u: AuthUser) {
    const n = await this.prisma.news.findFirst({ where: { id, status: 'PUBLISHED' }, select: { id: true } });
    if (!n) throw new NotFoundException('Новость не найдена');
    await this.prisma.newsRead.upsert({
      where: { newsId_userId: { newsId: id, userId: u.id } }, update: {}, create: { newsId: id, userId: u.id },
    });
  }

  async markAllRead(u: AuthUser) {
    const unread = await this.prisma.news.findMany({ where: { status: 'PUBLISHED', reads: { none: { userId: u.id } } }, select: { id: true } });
    await this.prisma.newsRead.createMany({ data: unread.map((n) => ({ newsId: n.id, userId: u.id })), skipDuplicates: true });
    return { marked: unread.length };
  }

  // ───────── правление ─────────

  async adminList(q: ListQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 20;
    const where: Prisma.NewsWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.q ? { OR: [{ title: { contains: q.q, mode: 'insensitive' } }, { body: { contains: q.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.news.count({ where }),
      this.prisma.news.findMany({
        where, orderBy: [{ pinned: 'desc' }, { publishedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * size, take: size,
        include: { photos: { orderBy: { sort: 'asc' } }, _count: { select: { reads: true } } },
      }),
    ]);
    return { total, page, pageSize: size, items: rows.map((r) => this.view(r)) };
  }

  async create(dto: NewsDto, u: AuthUser, req: Request) {
    await this.attachFiles(null, dto.fileIds ?? [], u);
    const n = await this.prisma.news.create({
      data: {
        title: dto.title, body: dto.body, pinned: dto.pinned ?? false, authorId: u.id,
        photos: { create: (dto.fileIds ?? []).map((fileId, sort) => ({ fileId, sort })) },
      },
      include: { photos: true },
    });
    await this.audit.log({ action: 'news.create', entity: 'News', entityId: n.id, after: { title: n.title, pinned: n.pinned, photos: n.photos.length } }, req);
    this.push.notify('all', { title: 'Новость правления', body: n.title, url: `/news/${n.id}`, tag: 'news' });
    return this.view(n);
  }

  async update(id: number, dto: UpdateNewsDto, u: AuthUser, req: Request) {
    const before = await this.prisma.news.findUnique({ where: { id }, include: { photos: true } });
    if (!before) throw new NotFoundException();
    if (dto.fileIds) await this.attachFiles(id, dto.fileIds, u);
    const removed = dto.fileIds ? before.photos.filter((p) => !dto.fileIds!.includes(p.fileId)).map((p) => p.fileId) : [];
    const after = await this.prisma.$transaction(async (tx) => {
      if (dto.fileIds) {
        await tx.newsPhoto.deleteMany({ where: { newsId: id } });
        await tx.newsPhoto.createMany({ data: dto.fileIds.map((fileId, sort) => ({ newsId: id, fileId, sort })) });
      }
      return tx.news.update({ where: { id }, data: { title: dto.title, body: dto.body, pinned: dto.pinned }, include: { photos: true } });
    });
    await this.files.remove(removed);
    await this.audit.log({ action: 'news.update', entity: 'News', entityId: id, before: { title: before.title, body: before.body, pinned: before.pinned }, after: { title: after.title, body: after.body, pinned: after.pinned } }, req);
    return this.view(after);
  }

  async setStatus(id: number, status: 'PUBLISHED' | 'HIDDEN', req: Request) {
    const n = await this.prisma.news.findUnique({ where: { id } });
    if (!n) throw new NotFoundException();
    await this.prisma.news.update({ where: { id }, data: { status } });
    await this.audit.log({ action: status === 'HIDDEN' ? 'news.hide' : 'news.show', entity: 'News', entityId: id, before: { status: n.status }, after: { status } }, req);
  }

  async remove(id: number, req: Request) {
    const n = await this.prisma.news.findUnique({ where: { id }, include: { photos: true } });
    if (!n) throw new NotFoundException();
    await this.prisma.news.delete({ where: { id } });
    await this.files.remove(n.photos.map((p) => p.fileId));
    await this.audit.log({ action: 'news.delete', entity: 'News', entityId: id, before: { title: n.title, body: n.body } }, req);
  }

  /** Кто прочитал: счётчик и список по именам. */
  async readers(id: number) {
    const n = await this.prisma.news.findUnique({ where: { id } });
    if (!n) throw new NotFoundException();
    const [reads, residents] = await Promise.all([
      this.prisma.newsRead.findMany({ where: { newsId: id }, orderBy: { readAt: 'desc' } }),
      this.prisma.user.count({ where: { deletedAt: null, garages: { some: { toDate: null } } } }),
    ]);
    const users = await this.prisma.user.findMany({ where: { id: { in: reads.map((r) => r.userId) } }, select: { id: true, fullName: true, phone: true } });
    const m = new Map(users.map((x) => [x.id, x]));
    return { readCount: reads.length, audience: residents, readers: reads.map((r) => ({ ...m.get(r.userId), readAt: r.readAt })) };
  }
}

@Controller('news')
class NewsController {
  constructor(private s: NewsService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.s.list(u, q); }

  @Post('read-all') @HttpCode(200)
  readAll(@CurrentUser() u: AuthUser) { return this.s.markAllRead(u); }

  @Get('admin') @RequirePermissions('news.edit')
  adminList(@Query() q: ListQuery) { return this.s.adminList(q); }

  @Post() @RequirePermissions('news.edit')
  create(@Body() dto: NewsDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.create(dto, u, req); }

  @Get(':id') get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) { return this.s.get(id, u); }

  @Post(':id/read') @HttpCode(204)
  read(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) { return this.s.markRead(id, u); }

  @Patch(':id') @RequirePermissions('news.edit')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateNewsDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.update(id, dto, u, req); }

  @Post(':id/hide') @HttpCode(204) @RequirePermissions('news.edit')
  hide(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.setStatus(id, 'HIDDEN', req); }

  @Post(':id/show') @HttpCode(204) @RequirePermissions('news.edit')
  show(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.setStatus(id, 'PUBLISHED', req); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('news.edit')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.remove(id, req); }

  @Get(':id/readers') @RequirePermissions('news.edit')
  readers(@Param('id', ParseIntPipe) id: number) { return this.s.readers(id); }
}

@Module({ imports: [FilesModule], controllers: [NewsController], providers: [NewsService], exports: [NewsService] })
export class NewsModule {}
