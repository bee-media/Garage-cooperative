import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Post, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';
import { FilesModule, FilesService } from '../files/files.module';
import { PushService } from '../push/push.service';

const MAX_APK_BYTES = 120 * 1024 * 1024;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class UploadDto {
  @Transform(trim) @IsString() @Matches(/^\d+(\.\d+){0,3}([-+][0-9A-Za-z.]+)?$/, { message: 'Версия вида 1.2.3' }) versionName: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(2_100_000_000) versionCode: number;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(3000) notes?: string;
}

class LatestQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) current?: number;
}

@Injectable()
class ReleasesService {
  constructor(
    private prisma: PrismaService, private files: FilesService, private audit: AuditService,
    private jwt: JwtService, private push: PushService,
  ) {}

  private view(r: any) {
    return {
      id: r.id, versionName: r.versionName, versionCode: r.versionCode, notes: r.notes,
      size: r.size, sha256: r.sha256, createdAt: r.createdAt,
    };
  }

  async upload(file: Express.Multer.File | undefined, dto: UploadDto, u: AuthUser, req: Request) {
    if (!file) throw new BadRequestException('Файл не передан (поле file)');
    const b = file.buffer;
    // APK — это ZIP с AndroidManifest.xml
    const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
    if (!/\.apk$/i.test(file.originalname) || !isZip || !b.includes(Buffer.from('AndroidManifest.xml'))) {
      throw new BadRequestException('Это не APK-файл');
    }
    const latest = await this.prisma.appRelease.findFirst({ orderBy: { versionCode: 'desc' } });
    if (latest && dto.versionCode <= latest.versionCode) {
      throw new ConflictException(`versionCode должен быть больше текущего (${latest.versionCode})`);
    }
    const sha256 = createHash('sha256').update(b).digest('hex');
    const asset = await this.files.saveRaw(b, 'apk', '.apk', 'application/vnd.android.package-archive', u.id);
    const r = await this.prisma.appRelease.create({
      data: { versionName: dto.versionName, versionCode: dto.versionCode, notes: dto.notes, fileId: asset.id, createdById: u.id, sha256, size: b.length },
    });
    await this.audit.log({ action: 'release.upload', entity: 'AppRelease', entityId: r.id, after: this.view(r) }, req);
    return this.view(r);
  }

  list() {
    return this.prisma.appRelease.findMany({ orderBy: { versionCode: 'desc' } }).then((rows) => rows.map((r) => this.view(r)));
  }

  /** Для приложения: есть ли новая версия. Для личного кабинета — ссылка на последний APK. */
  async latest(current?: number) {
    const r = await this.prisma.appRelease.findFirst({ orderBy: { versionCode: 'desc' } });
    if (!r) return { available: false, updateAvailable: false };
    return { available: true, updateAvailable: current !== undefined && r.versionCode > current, ...this.view(r), downloadPath: `/api/releases/${r.id}/download` };
  }

  async link(id: number, u: AuthUser) {
    const r = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    const t = await this.jwt.signAsync(
      { sub: u.id, sid: u.sessionId, fid: String(id), typ: 'file' },
      { secret: this.files.linkSecret, expiresIn: '10m' },
    );
    return { url: `/api/releases/${id}/download?t=${t}`, expiresInSec: 600 };
  }

  async download(id: number, u: AuthUser, req: Request, res: Response) {
    const r = await this.prisma.appRelease.findUnique({ where: { id } });
    const f = r && (await this.prisma.fileAsset.findUnique({ where: { id: r.fileId } }));
    if (!r || !f) throw new NotFoundException();
    const abs = this.files.absPath(f.path);
    if (!existsSync(abs)) throw new NotFoundException();
    await this.audit.log({ action: 'release.download', entity: 'AppRelease', entityId: id }, req);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="gsk-rodnik-${r.versionName}.apk"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Checksum-Sha256', r.sha256);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(abs);
  }

  async remove(id: number, req: Request) {
    const r = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    await this.prisma.appRelease.delete({ where: { id } });
    await this.files.remove([r.fileId]);
    await this.audit.log({ action: 'release.delete', entity: 'AppRelease', entityId: id, before: this.view(r) }, req);
  }

  /** Сообщить пользователям о новой версии (по желанию администратора) */
  async announce(id: number, req: Request) {
    const r = await this.prisma.appRelease.findUnique({ where: { id } });
    if (!r) throw new NotFoundException();
    const res = await this.push.sendToUsers('all', {
      title: 'Доступна новая версия приложения', body: `Версия ${r.versionName}. Откройте приложение, чтобы обновиться.`, url: '/profile', tag: 'update',
    });
    await this.audit.log({ action: 'release.announce', entity: 'AppRelease', entityId: id, after: res }, req);
    return res;
  }
}

@Controller('releases')
class ReleasesController {
  constructor(private s: ReleasesService) {}

  @Post() @HttpCode(201) @RequirePermissions('releases.manage') @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_APK_BYTES, files: 1 } }))
  upload(@UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.s.upload(file, dto, u, req);
  }

  @Get() @RequirePermissions('releases.manage')
  list() { return this.s.list(); }

  @Get('latest')
  latest(@Query() q: LatestQuery) { return this.s.latest(q.current); }

  @Post(':id/link') @HttpCode(200)
  link(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) { return this.s.link(id, u); }

  @Get(':id/download') @Throttle({ default: { limit: 20, ttl: 60_000 } })
  download(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request, @Res() res: Response) {
    return this.s.download(id, u, req, res);
  }

  @Post(':id/announce') @HttpCode(200) @RequirePermissions('releases.manage')
  announce(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.announce(id, req); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('releases.manage')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.remove(id, req); }
}

@Module({ imports: [FilesModule], controllers: [ReleasesController], providers: [ReleasesService] })
export class ReleasesModule {}
