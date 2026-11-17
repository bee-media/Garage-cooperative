import {
  BadRequestException, Controller, ForbiddenException, Get, HttpCode, HttpException, HttpStatus, Injectable, Module, NotFoundException, OnModuleDestroy, OnModuleInit,
  Param, ParseUUIDPipe, Post, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { IsIn } from 'class-validator';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import sharp from 'sharp';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const KINDS = ['meter', 'ad', 'news', 'map'] as const;
/** Сколько часов загруженный, но не привязанный файл ждёт, прежде чем будет удалён */
export const ORPHAN_GRACE_HOURS = 24;
/** Предел размера картинки в пикселях (≈ 60 Мп): проверяется по заголовку и ещё раз самим декодером */
const MAX_PIXELS = 60_000_000;
/**
 * Суточная квота загрузок на пользователя. Лимит запросов считается по IP, а квота — по учётной записи: без неё один
 * житель мог бы за сутки (пока «сироты» не удалены) забить диск десятками гигабайт. Житель: показание — до 6 фото,
 * объявление — до 5, поэтому 100 в сутки с запасом.
 */
export const DAILY_UPLOADS = { resident: 100, staff: 1000 };
/** Одновременно перекодируется не больше стольких картинок: декодирование 60 Мп занимает сотни мегабайт памяти */
const MAX_PARALLEL_DECODES = 2;

let decoding = 0;
const waiting: (() => void)[] = [];
async function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (decoding >= MAX_PARALLEL_DECODES) await new Promise<void>((r) => waiting.push(r));
  decoding++;
  try {
    return await fn();
  } finally {
    decoding--;
    waiting.shift()?.();
  }
}
type Kind = (typeof KINDS)[number];

class UploadQuery {
  @IsIn(KINDS as unknown as string[]) kind: Kind;
}

@Injectable()
export class FilesService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  readonly root: string;

  constructor(
    private prisma: PrismaService,
    private cfg: ConfigService,
    private jwt: JwtService,
    private audit: AuditService,
  ) {
    this.root = path.resolve(this.cfg.get<string>('STORAGE_DIR') ?? './storage');
  }

  /** Секрет для ссылок на файлы отличается от секрета access-токена: ссылка не годится как токен API. */
  get linkSecret() {
    return this.cfg.getOrThrow<string>('JWT_ACCESS_SECRET') + ':file-link';
  }

  /**
   * Принимает «сырую» картинку, проверяет, что это действительно jpeg/png/webp,
   * перекодирует в JPEG (так удаляются EXIF/GPS и любой «довесок» внутри файла), ограничивает размер.
   */
  async saveImage(buf: Buffer, kind: Kind, ownerId: number) {
    return withDecodeSlot(() => this.saveImageNow(buf, kind, ownerId));
  }

  /** Сколько файлов пользователь загрузил за сутки; при превышении квоты — 429 */
  async assertUploadQuota(u: AuthUser) {
    const limit = u.portalAccess ? DAILY_UPLOADS.staff : DAILY_UPLOADS.resident;
    const n = await this.prisma.fileAsset.count({ where: { ownerId: u.id, kind: { in: [...KINDS] }, createdAt: { gt: new Date(Date.now() - 86400_000) } } });
    if (n >= limit) throw new HttpException('Слишком много загрузок за сутки. Попробуйте завтра или обратитесь в правление', HttpStatus.TOO_MANY_REQUESTS);
  }

  private async saveImageNow(buf: Buffer, kind: Kind, ownerId: number) {
    let meta;
    try {
      meta = await sharp(buf, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
    } catch {
      throw new BadRequestException('Файл не является изображением');
    }
    if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
      throw new BadRequestException('Допустимы только JPEG, PNG и WebP');
    }
    if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_PIXELS) throw new BadRequestException('Слишком большое изображение');

    // схема карты — крупнее обычных фото, чтобы оставалась читаемой при увеличении
    const max = kind === 'map' ? 4000 : 2400;
    const out = await sharp(buf, { limitInputPixels: MAX_PIXELS })
      .rotate() // применить EXIF-ориентацию до удаления метаданных
      .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();

    const id = randomUUID();
    const d = new Date();
    const rel = path.join(kind, String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), `${id}.jpg`);
    const abs = path.join(this.root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, out);
    const created = await this.prisma.fileAsset.create({
      data: { id, path: rel, mime: 'image/jpeg', size: out.length, ownerId, kind },
    });
    const dim = await sharp(out).metadata();
    return { ...created, width: dim.width ?? 0, height: dim.height ?? 0 };
  }

  /** Сохраняет произвольный файл без обработки (например APK). Читается только через свой модуль. */
  async saveRaw(buf: Buffer, kind: string, ext: string, mime: string, ownerId: number) {
    const id = randomUUID();
    const rel = path.join(kind, `${id}${ext}`);
    const abs = path.join(this.root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    return this.prisma.fileAsset.create({ data: { id, path: rel, mime, size: buf.length, ownerId, kind } });
  }

  /** Удаляет файлы с диска и из БД (когда на них больше никто не ссылается). */
  async remove(ids: string[]) {
    if (!ids.length) return;
    const files = await this.prisma.fileAsset.findMany({ where: { id: { in: ids } } });
    for (const f of files) {
      try {
        await rm(this.absPath(f.path), { force: true });
      } catch {
        /* файл уже удалён */
      }
    }
    await this.prisma.fileAsset.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  }

  onModuleInit() {
    // Раз в час; первый запуск через минуту после старта, чтобы не мешать запуску
    const run = () => void this.purgeOrphans().then((r) => {
      if (r.orphanRecords || r.strayFiles) void this.audit.log({ action: 'files.purge_orphans', after: r, actor: null });
    }).catch((e) => console.error('files purge', e));
    setTimeout(run, 60_000).unref();
    this.timer = setInterval(run, 3600_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ───────── очистка «сирот» ─────────

  /**
   * Файл загружают отдельным запросом, а привязывают к показанию/объявлению/новости следующим. Если человек
   * передумал или приложение закрылось, фото остаётся без владельца. Через ORPHAN_GRACE_HOURS такие файлы удаляются.
   * Кроме того, удаляются файлы на диске, о которых нет записи в БД (например, после сбоя между записью на диск и в БД).
   */
  async purgeOrphans(graceHours = ORPHAN_GRACE_HOURS) {
    const border = new Date(Date.now() - graceHours * 3600_000);
    const [meters, ads, news, poles, marks, lines, releases, setting] = await Promise.all([
      this.prisma.meterPhoto.findMany({ select: { fileId: true } }),
      this.prisma.adPhoto.findMany({ select: { fileId: true } }),
      this.prisma.newsPhoto.findMany({ select: { fileId: true } }),
      this.prisma.mapPole.findMany({ where: { fileId: { not: null } }, select: { fileId: true } }),
      this.prisma.mapMark.findMany({ where: { fileId: { not: null } }, select: { fileId: true } }),
      this.prisma.mapLine.findMany({ where: { fileId: { not: null } }, select: { fileId: true } }),
      this.prisma.appRelease.findMany({ select: { fileId: true } }),
      this.prisma.setting.findUnique({ where: { key: 'map' } }),
    ]);
    const used = new Set<string>();
    for (const r of [...meters, ...ads, ...news, ...poles, ...marks, ...lines, ...releases]) if (r.fileId) used.add(r.fileId);
    const bg = (setting?.value as { backgroundFileId?: string | null } | null)?.backgroundFileId;
    if (bg) used.add(bg);

    // 1. записи БД без ссылок (APK не трогаем: они принадлежат релизам)
    const candidates = await this.prisma.fileAsset.findMany({ where: { createdAt: { lt: border }, kind: { in: [...KINDS] } }, select: { id: true } });
    const orphanIds = candidates.map((f) => f.id).filter((id) => !used.has(id));
    for (let i = 0; i < orphanIds.length; i += 200) await this.remove(orphanIds.slice(i, i + 200));

    // 2. файлы на диске без записи в БД
    const known = new Set((await this.prisma.fileAsset.findMany({ select: { path: true } })).map((f) => f.path));
    let strays = 0;
    for (const kind of KINDS) strays += await this.sweepDir(path.join(this.root, kind), kind, known, border);

    return { orphanRecords: orphanIds.length, strayFiles: strays };
  }

  private async sweepDir(dir: string, rel: string, known: Set<string>, border: Date): Promise<number> {
    let removed = 0;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = path.join(rel, e.name);
      if (e.isDirectory()) { removed += await this.sweepDir(abs, r, known, border); continue; }
      if (!e.isFile() || known.has(r)) continue;
      try {
        if ((await stat(abs)).mtime < border) { await rm(abs, { force: true }); removed++; }
      } catch { /* файл исчез или занят — пропускаем */ }
    }
    return removed;
  }

  absPath(rel: string) {
    const abs = path.resolve(this.root, rel);
    if (!abs.startsWith(this.root + path.sep)) throw new ForbiddenException();
    return abs;
  }

  /** Кто может видеть файл */
  async canRead(user: AuthUser, file: { id: string; kind: string; ownerId: number | null }): Promise<boolean> {
    const staff = (p: string) => user.portalAccess && user.permissions.includes(p);
    if (file.ownerId === user.id) return true;
    switch (file.kind) {
      case 'meter': {
        if (staff('meters.view')) return true;
        const photo = await this.prisma.meterPhoto.findFirst({ where: { fileId: file.id }, include: { reading: true } });
        if (!photo) return false;
        return !!(await this.prisma.garageOwner.findFirst({ where: { garageId: photo.reading.garageId, userId: user.id, toDate: null } }));
      }
      case 'ad': {
        if (staff('ads.moderate')) return true;
        const photo = await this.prisma.adPhoto.findFirst({ where: { fileId: file.id }, include: { ad: true } });
        return !!photo && (photo.ad.status === 'APPROVED' || photo.ad.userId === user.id);
      }
      case 'news': {
        if (staff('news.edit')) return true;
        // фото скрытой новости видно только правлению; не привязанные к новости (черновик) — только автору (проверено выше)
        const photo = await this.prisma.newsPhoto.findFirst({ where: { fileId: file.id }, include: { news: true } });
        return !!photo && photo.news.status === 'PUBLISHED';
      }
      case 'map': {
        if (staff('map.view')) return true;
        const s = (await this.prisma.setting.findUnique({ where: { key: 'map' } }))?.value as
          { residentsCanView?: boolean; residentsSeeMarks?: boolean; backgroundFileId?: string | null } | null;
        if (!s?.residentsCanView) return false;
        // жителю доступны только схема, фото опор и (если включено) фото открытых пометок; фото линий и закрытых пометок — нет
        if (s.backgroundFileId === file.id) return true;
        if (await this.prisma.mapPole.findFirst({ where: { fileId: file.id }, select: { id: true } })) return true;
        return !!s.residentsSeeMarks && !!(await this.prisma.mapMark.findFirst({ where: { fileId: file.id, status: 'OPEN' }, select: { id: true } }));
      }
      default:
        return false;
    }
  }
}

@Controller('files')
class FilesController {
  constructor(private files: FilesService, private prisma: PrismaService, private jwt: JwtService, private audit: AuditService) {}

  @Post()
  @HttpCode(201)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query() q: UploadQuery,
    @CurrentUser() u: AuthUser,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException('Файл не передан (поле file)');
    if (q.kind === 'news' && !(u.portalAccess && u.permissions.includes('news.edit'))) throw new ForbiddenException('Недостаточно прав');
    if (q.kind === 'map' && !(u.portalAccess && (u.permissions.includes('map.edit') || u.permissions.includes('map.marks')))) throw new ForbiddenException('Недостаточно прав');
    await this.files.assertUploadQuota(u);
    const a = await this.files.saveImage(file.buffer, q.kind, u.id);
    await this.audit.log({ action: 'file.upload', entity: 'File', entityId: a.id, after: { kind: q.kind, size: a.size } }, req);
    return { id: a.id, size: a.size, width: a.width, height: a.height };
  }

  /** Короткоживущая ссылка для <img src>, привязана к пользователю и его сессии. */
  @Post(':id/link')
  @HttpCode(200)
  async link(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser) {
    const f = await this.prisma.fileAsset.findUnique({ where: { id } });
    if (!f || !(await this.files.canRead(u, f))) throw new NotFoundException();
    const t = await this.jwt.signAsync(
      { sub: u.id, sid: u.sessionId, fid: id, typ: 'file' },
      { secret: this.files.linkSecret, expiresIn: '10m' },
    );
    return { url: `/api/files/${id}?t=${t}`, expiresInSec: 600 };
  }

  @Get(':id')
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: AuthUser, @Res() res: Response) {
    const f = await this.prisma.fileAsset.findUnique({ where: { id } });
    // одинаковый ответ и для «нет файла», и для «нет доступа»
    if (!f || !(await this.files.canRead(u, f))) throw new NotFoundException();
    const abs = this.files.absPath(f.path);
    if (!existsSync(abs)) throw new NotFoundException();
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.sendFile(abs);
  }
}

@Module({ controllers: [FilesController], providers: [FilesService], exports: [FilesService] })
export class FilesModule {}
