import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Injectable, Module,
  NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Req,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { defined } from '../common/defined';
import { PrismaService } from '../common/prisma.service';
import { FilesModule, FilesService } from '../files/files.module';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';

export const MARK_CATEGORIES = ['NO_LIGHT', 'DAMAGE', 'LEAK', 'TRASH', 'OTHER'] as const;
const COORD = { min: -100_000, max: 100_000 };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const NUMBER_RE = /^[0-9A-Za-zА-Яа-я\-/]{1,12}$/;

class RowDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) label?: string;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) x1: number;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) y1: number;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) x2: number;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) y2: number;
  @IsNumber() @Min(4) @Max(200) depth: number;
  /** Номера боксов по порядку от начала к концу; пустая строка — бокс без номера */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @IsString({ each: true }) @MaxLength(12, { each: true }) numbers: string[];
}

class UpdateRowDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(60) label?: string;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) x1?: number;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) y1?: number;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) x2?: number;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) y2?: number;
  @IsOptional() @IsNumber() @Min(4) @Max(200) depth?: number;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(300) @IsString({ each: true }) @MaxLength(12, { each: true }) numbers?: string[];
}

class MarkDto {
  @IsNumber() @Min(COORD.min) @Max(COORD.max) x: number;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) y: number;
  @IsIn(MARK_CATEGORIES as unknown as string[]) category: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID('4') fileId?: string;
  @IsOptional() @Transform(trim) @IsString() @Matches(NUMBER_RE) garageNumber?: string;
}

class UpdateMarkDto {
  @IsOptional() @IsIn(MARK_CATEGORIES as unknown as string[]) category?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID('4') fileId?: string;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) x?: number;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) y?: number;
}

class CloseDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) comment?: string;
}

class PoleDto {
  @IsNumber() @Min(COORD.min) @Max(COORD.max) x: number;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) y: number;
  @Transform(trim) @IsString() @Matches(/^[0-9A-Za-zА-Яа-я\-/. ]{1,20}$/, { message: 'Номер опоры: до 20 символов' }) number: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID('4') fileId?: string;
}

class UpdatePoleDto {
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) x?: number;
  @IsOptional() @IsNumber() @Min(COORD.min) @Max(COORD.max) y?: number;
  @IsOptional() @Transform(trim) @IsString() @Matches(/^[0-9A-Za-zА-Яа-я\-/. ]{1,20}$/) number?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID('4') fileId?: string;
}

export const LINE_STATUSES = ['OK', 'CHECK', 'EMERGENCY', 'OFF'] as const;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

class LinePointDto {
  @IsNumber() @Min(COORD.min) @Max(COORD.max) x: number;
  @IsNumber() @Min(COORD.min) @Max(COORD.max) y: number;
  /** вершина «приклеена» к опоре и следует за ней */
  @IsOptional() @IsInt() @Min(1) poleId?: number;
}

class LineDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) name?: string;
  @Matches(COLOR_RE) color: string;
  @IsIn(LINE_STATUSES as unknown as string[]) status: string;
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => LinePointDto) points: LinePointDto[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID('4') fileId?: string;
}

class UpdateLineDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) name?: string;
  @IsOptional() @Matches(COLOR_RE) color?: string;
  @IsOptional() @IsArray() @ArrayMinSize(2) @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => LinePointDto) points?: LinePointDto[];
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
  @IsOptional() @IsUUID('4') fileId?: string;
}

class LineStatusDto {
  @IsIn(LINE_STATUSES as unknown as string[]) status: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) comment?: string;
}

class LineNoteDto {
  @Transform(trim) @IsString() @MinLength(1) @MaxLength(1000) comment: string;
}

class SettingsDto {
  @IsBoolean() residentsCanView: boolean;
  @IsBoolean() residentsSeeMarks: boolean;
}

class BackgroundDto {
  @IsUUID('4') fileId: string;
  @IsInt() @Min(100) @Max(20_000) width: number;
  @IsInt() @Min(100) @Max(20_000) height: number;
}

interface LinePoint { x: number; y: number; poleId?: number }

interface MapSettings {
  backgroundFileId: string | null;
  width: number;
  height: number;
  residentsCanView: boolean;
  residentsSeeMarks: boolean;
}

const DEFAULT_SETTINGS: MapSettings = { backgroundFileId: null, width: 1600, height: 1000, residentsCanView: false, residentsSeeMarks: false };

@Injectable()
class MapService {
  constructor(
    private prisma: PrismaService, private audit: AuditService, private files: FilesService, private finance: FinanceService,
  ) {}

  async settings(): Promise<MapSettings> {
    const s = await this.prisma.setting.findUnique({ where: { key: 'map' } });
    return { ...DEFAULT_SETTINGS, ...((s?.value as Partial<MapSettings>) ?? {}) };
  }

  private async saveSettings(s: MapSettings) {
    await this.prisma.setting.upsert({ where: { key: 'map' }, update: { value: s as any }, create: { key: 'map', value: s as any } });
  }

  private has(u: AuthUser, p: string) {
    return u.portalAccess && u.permissions.includes(p);
  }

  /** Сцена карты целиком. Сотрудникам — по праву map.view; жителям — только если включено в настройках. */
  async scene(u: AuthUser) {
    const settings = await this.settings();
    const staff = this.has(u, 'map.view');
    if (!staff && !settings.residentsCanView) throw new ForbiddenException('Карта недоступна');
    const canDebts = this.has(u, 'debts.view');

    const [rows, poles, marks, lines] = await Promise.all([
      this.prisma.mapRow.findMany({ orderBy: { id: 'asc' } }),
      this.prisma.mapPole.findMany({ orderBy: { id: 'asc' } }),
      staff || settings.residentsSeeMarks
        ? this.prisma.mapMark.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'desc' } })
        : Promise.resolve([]),
      staff ? this.prisma.mapLine.findMany({ orderBy: { id: 'asc' } }) : Promise.resolve([]),
    ]);

    const numbers = [...new Set(rows.flatMap((r) => r.numbers.filter(Boolean)))];
    const garages = numbers.length
      ? await this.prisma.garage.findMany({
          where: { number: { in: numbers } },
          include: { owners: { where: { toDate: null }, include: { user: { select: { id: true, fullName: true } } } } },
        })
      : [];
    const byNumber = new Map(garages.map((g) => [g.number, g]));
    const balances = canDebts && garages.length ? await this.finance.balances(garages.map((g) => g.id)) : null;

    const seen = new Map<string, number>();
    rows.forEach((r) => r.numbers.filter(Boolean).forEach((n) => seen.set(n, (seen.get(n) ?? 0) + 1)));
    const duplicates = [...seen.entries()].filter(([, c]) => c > 1).map(([n]) => n);

    const mineIds = new Set(
      (await this.prisma.garageOwner.findMany({ where: { userId: u.id, toDate: null }, select: { garageId: true } })).map((o) => o.garageId),
    );

    const rowsOut = rows.map((r) => ({
      id: r.id, label: r.label, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, depth: r.depth,
      boxes: r.numbers.map((n) => {
        const g = n ? byNumber.get(n) : undefined;
        return {
          number: n,
          garageId: g?.id ?? null,
          archived: g?.status === 'ARCHIVED',
          // сведения о льготе — сотрудникам и владельцу гаража, остальным жителям не показываем
          hasBenefit: !!g && (staff || mineIds.has(g.id)) && g.hasBenefit,
          mine: g ? mineIds.has(g.id) : false,
          // цвет долга раскрывает финансы, поэтому только тем, у кого есть право видеть задолженности
          color: g && balances ? balances.get(g.id)?.color ?? 'GREEN' : null,
          owners: staff && g ? g.owners.map((o) => o.user.fullName ?? '—') : undefined,
        };
      }),
    }));

    const names = staff
      ? new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(marks.map((m) => m.createdById))] } }, select: { id: true, fullName: true } })).map((x) => [x.id, x.fullName]))
      : new Map<number, string | null>();

    const allBoxes = rowsOut.flatMap((r) => r.boxes);
    return {
      settings: { backgroundFileId: settings.backgroundFileId, width: settings.width, height: settings.height, residentsCanView: settings.residentsCanView, residentsSeeMarks: settings.residentsSeeMarks },
      access: { staff, edit: this.has(u, 'map.edit'), mark: this.has(u, 'map.marks'), debts: canDebts },
      rows: rowsOut,
      lines: lines.map((l) => ({ id: l.id, name: l.name, color: l.color, status: l.status, points: l.points, comment: l.comment, fileId: l.fileId, createdAt: l.createdAt, updatedAt: l.updatedAt })),
      poles: poles.map((p) => ({ id: p.id, x: p.x, y: p.y, number: p.number, comment: p.comment, fileId: p.fileId, createdAt: p.createdAt })),
      marks: marks.map((m) => ({
        id: m.id, x: m.x, y: m.y, category: m.category, comment: m.comment, fileId: m.fileId, garageNumber: m.garageNumber,
        status: m.status, createdAt: m.createdAt, createdBy: staff ? names.get(m.createdById) ?? null : undefined,
      })),
      stats: {
        boxes: allBoxes.length, linked: allBoxes.filter((b) => b.garageId).length, unlinked: allBoxes.filter((b) => b.number && !b.garageId).length,
        poles: poles.length, openMarks: marks.length, duplicates,
        lines: lines.length, emergencyLines: lines.filter((l) => l.status === 'EMERGENCY').length,
      },
    };
  }

  // ───────── настройки и подложка ─────────

  async setSettings(dto: SettingsDto, req: Request) {
    const before = await this.settings();
    const next = { ...before, ...defined(dto) };
    await this.saveSettings(next);
    await this.audit.log({ action: 'map.settings', entity: 'Setting', entityId: 'map', before: { residentsCanView: before.residentsCanView, residentsSeeMarks: before.residentsSeeMarks }, after: dto }, req);
    return dto;
  }

  async setBackground(dto: BackgroundDto, u: AuthUser, req: Request) {
    const f = await this.prisma.fileAsset.findFirst({ where: { id: dto.fileId, kind: 'map', ownerId: u.id } });
    if (!f) throw new BadRequestException('Файл не найден (загрузите заново)');
    const before = await this.settings();
    if (dto.fileId !== before.backgroundFileId) await this.assertFileFree(dto.fileId, before);
    await this.saveSettings({ ...before, backgroundFileId: dto.fileId, width: dto.width, height: dto.height });
    if (before.backgroundFileId && before.backgroundFileId !== dto.fileId) await this.files.remove([before.backgroundFileId]);
    await this.audit.log({ action: 'map.background', entity: 'Setting', entityId: 'map', after: { fileId: dto.fileId, width: dto.width, height: dto.height } }, req);
  }

  async removeBackground(req: Request) {
    const before = await this.settings();
    await this.saveSettings({ ...before, backgroundFileId: null });
    if (before.backgroundFileId) await this.files.remove([before.backgroundFileId]);
    await this.audit.log({ action: 'map.background_remove', entity: 'Setting', entityId: 'map' }, req);
  }

  // ───────── ряды ─────────

  private checkRow(x1: number, y1: number, x2: number, y2: number, numbers: string[]) {
    if (Math.hypot(x2 - x1, y2 - y1) < 10) throw new BadRequestException('Ряд слишком короткий');
    for (const n of numbers) if (n && !NUMBER_RE.test(n)) throw new BadRequestException(`Некорректный номер бокса: ${n}`);
  }

  async createRow(dto: RowDto, req: Request) {
    this.checkRow(dto.x1, dto.y1, dto.x2, dto.y2, dto.numbers);
    const r = await this.prisma.mapRow.create({ data: dto });
    await this.audit.log({ action: 'map.row.create', entity: 'MapRow', entityId: r.id, after: { label: r.label, count: r.numbers.length, first: r.numbers[0], last: r.numbers[r.numbers.length - 1] } }, req);
    return r;
  }

  async updateRow(id: number, dto: UpdateRowDto, req: Request) {
    const before = await this.prisma.mapRow.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Ряд не найден');
    const m = { ...before, ...defined(dto) };
    this.checkRow(m.x1, m.y1, m.x2, m.y2, m.numbers);
    const r = await this.prisma.mapRow.update({ where: { id }, data: dto });
    await this.audit.log({ action: 'map.row.update', entity: 'MapRow', entityId: id, before: { label: before.label, count: before.numbers.length }, after: { label: r.label, count: r.numbers.length } }, req);
    return r;
  }

  async deleteRow(id: number, req: Request) {
    const r = await this.prisma.mapRow.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Ряд не найден');
    await this.prisma.mapRow.delete({ where: { id } });
    await this.audit.log({ action: 'map.row.delete', entity: 'MapRow', entityId: id, before: { label: r.label, numbers: r.numbers } }, req);
  }

  // ───────── пометки ─────────

  /**
   * Фото пометки, опоры или линии: своё, типа «карта» и ещё не занятое другим объектом карты. Иначе удаление одного
   * объекта стирало бы фото у другого, а закрытое от жителей фото линии становилось бы видно им через опору.
   * Вызывается только для нового (сменившегося) файла.
   */
  private async ownFile(fileId: string | undefined, u: AuthUser) {
    if (!fileId) return;
    const f = await this.prisma.fileAsset.findFirst({ where: { id: fileId, kind: 'map', ownerId: u.id } });
    if (!f) throw new BadRequestException('Фото не найдено (загрузите заново)');
    await this.assertFileFree(fileId, await this.settings());
  }

  private async assertFileFree(fileId: string, s: MapSettings) {
    const [m, p, l] = await Promise.all([
      this.prisma.mapMark.findFirst({ where: { fileId }, select: { id: true } }),
      this.prisma.mapPole.findFirst({ where: { fileId }, select: { id: true } }),
      this.prisma.mapLine.findFirst({ where: { fileId }, select: { id: true } }),
    ]);
    if (m || p || l || s.backgroundFileId === fileId) throw new BadRequestException('Это фото уже используется на карте');
  }

  async createMark(dto: MarkDto, u: AuthUser, req: Request) {
    await this.ownFile(dto.fileId, u);
    const m = await this.prisma.mapMark.create({ data: { ...dto, createdById: u.id } });
    await this.audit.log({ action: 'map.mark.create', entity: 'MapMark', entityId: m.id, after: { category: m.category, comment: m.comment, garage: m.garageNumber } }, req);
    return m;
  }

  async updateMark(id: number, dto: UpdateMarkDto, u: AuthUser, req: Request) {
    const before = await this.prisma.mapMark.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Пометка не найдена');
    if (before.createdById !== u.id && !this.has(u, 'map.edit')) throw new ForbiddenException('Менять чужую пометку может только администратор карты');
    await this.ownFile(dto.fileId && dto.fileId !== before.fileId ? dto.fileId : undefined, u);
    const m = await this.prisma.mapMark.update({ where: { id }, data: dto });
    if (dto.fileId && before.fileId && before.fileId !== dto.fileId) await this.files.remove([before.fileId]);
    await this.audit.log({ action: 'map.mark.update', entity: 'MapMark', entityId: id, before: { category: before.category, comment: before.comment }, after: { category: m.category, comment: m.comment } }, req);
    return m;
  }

  async closeMark(id: number, dto: CloseDto, u: AuthUser, req: Request) {
    const m = await this.prisma.mapMark.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Пометка не найдена');
    if (m.status === 'CLOSED') throw new BadRequestException('Пометка уже снята');
    await this.prisma.mapMark.update({ where: { id }, data: { status: 'CLOSED', closedAt: new Date(), closedById: u.id, closeComment: dto.comment } });
    await this.audit.log({ action: 'map.mark.close', entity: 'MapMark', entityId: id, after: { comment: dto.comment } }, req);
  }

  async reopenMark(id: number, req: Request) {
    const m = await this.prisma.mapMark.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Пометка не найдена');
    await this.prisma.mapMark.update({ where: { id }, data: { status: 'OPEN', closedAt: null, closedById: null, closeComment: null } });
    await this.audit.log({ action: 'map.mark.reopen', entity: 'MapMark', entityId: id }, req);
  }

  async deleteMark(id: number, req: Request) {
    const m = await this.prisma.mapMark.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Пометка не найдена');
    await this.prisma.mapMark.delete({ where: { id } });
    if (m.fileId) await this.files.remove([m.fileId]);
    await this.audit.log({ action: 'map.mark.delete', entity: 'MapMark', entityId: id, before: { category: m.category, comment: m.comment } }, req);
  }

  /** История снятых пометок (для раздела «Журнал пометок») */
  async closedMarks() {
    const rows = await this.prisma.mapMark.findMany({ where: { status: 'CLOSED' }, orderBy: { closedAt: 'desc' }, take: 100 });
    const ids = [...new Set(rows.flatMap((m) => [m.createdById, m.closedById].filter((x): x is number => !!x)))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
    const n = new Map(users.map((x) => [x.id, x.fullName]));
    return rows.map((m) => ({ ...m, createdBy: n.get(m.createdById) ?? null, closedBy: m.closedById ? n.get(m.closedById) ?? null : null }));
  }

  // ───────── линии электропередачи ─────────

  /** Вершина с poleId получает координаты опоры; несуществующая опора — просто обычная точка */
  private async normalizePoints(points: LinePoint[]): Promise<LinePoint[]> {
    const ids = [...new Set(points.map((p) => p.poleId).filter((x): x is number => !!x))];
    const poles = ids.length ? await this.prisma.mapPole.findMany({ where: { id: { in: ids } }, select: { id: true, x: true, y: true } }) : [];
    const byId = new Map(poles.map((p) => [p.id, p]));
    return points.map((p) => {
      const pole = p.poleId ? byId.get(p.poleId) : undefined;
      return pole ? { x: pole.x, y: pole.y, poleId: pole.id } : { x: p.x, y: p.y };
    });
  }

  private checkLine(points: LinePoint[]) {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    if (len < 5) throw new BadRequestException('Линия слишком короткая');
  }

  async createLine(dto: LineDto, u: AuthUser, req: Request) {
    await this.ownFile(dto.fileId, u);
    const points = await this.normalizePoints(dto.points);
    this.checkLine(points);
    const l = await this.prisma.mapLine.create({
      data: {
        name: dto.name, color: dto.color, status: dto.status, points: points as any, comment: dto.comment, fileId: dto.fileId, createdById: u.id,
        events: { create: { userId: u.id, action: 'CREATE', status: dto.status, comment: dto.comment } },
      },
    });
    await this.audit.log({ action: 'map.line.create', entity: 'MapLine', entityId: l.id, after: { name: l.name, status: l.status, points: points.length } }, req);
    return l;
  }

  async updateLine(id: number, dto: UpdateLineDto, u: AuthUser, req: Request) {
    const before = await this.prisma.mapLine.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Линия не найдена');
    await this.ownFile(dto.fileId && dto.fileId !== before.fileId ? dto.fileId : undefined, u);
    const data: Record<string, unknown> = { ...defined({ name: dto.name, color: dto.color, comment: dto.comment, fileId: dto.fileId }) };
    if (dto.points) {
      const points = await this.normalizePoints(dto.points);
      this.checkLine(points);
      data.points = points;
    }
    const l = await this.prisma.mapLine.update({ where: { id }, data: data as any });
    if (dto.fileId && before.fileId && before.fileId !== dto.fileId) await this.files.remove([before.fileId]);
    await this.audit.log({ action: 'map.line.update', entity: 'MapLine', entityId: id, before: { name: before.name, color: before.color }, after: { name: l.name, color: l.color, geometry: !!dto.points } }, req);
    return l;
  }

  /** Смена состояния всегда пишется в журнал линии */
  async setLineStatus(id: number, dto: LineStatusDto, u: AuthUser, req: Request) {
    const before = await this.prisma.mapLine.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Линия не найдена');
    if (before.status === dto.status && !dto.comment) throw new BadRequestException('Состояние не изменилось');
    await this.prisma.$transaction([
      this.prisma.mapLine.update({ where: { id }, data: { status: dto.status } }),
      this.prisma.mapLineEvent.create({ data: { lineId: id, userId: u.id, action: before.status === dto.status ? 'NOTE' : 'STATUS', status: dto.status, comment: dto.comment } }),
    ]);
    await this.audit.log({ action: 'map.line.status', entity: 'MapLine', entityId: id, before: { status: before.status }, after: { status: dto.status, comment: dto.comment } }, req);
  }

  async addLineNote(id: number, dto: LineNoteDto, u: AuthUser, req: Request) {
    const l = await this.prisma.mapLine.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!l) throw new NotFoundException('Линия не найдена');
    await this.prisma.mapLineEvent.create({ data: { lineId: id, userId: u.id, action: 'NOTE', status: l.status, comment: dto.comment } });
    await this.audit.log({ action: 'map.line.note', entity: 'MapLine', entityId: id, after: { comment: dto.comment } }, req);
  }

  async lineEvents(id: number) {
    const l = await this.prisma.mapLine.findUnique({ where: { id }, select: { id: true } });
    if (!l) throw new NotFoundException('Линия не найдена');
    const events = await this.prisma.mapLineEvent.findMany({ where: { lineId: id }, orderBy: { at: 'desc' }, take: 200 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(events.map((e) => e.userId))] } }, select: { id: true, fullName: true } });
    const n = new Map(users.map((x) => [x.id, x.fullName]));
    return events.map((e) => ({ id: e.id, at: e.at, action: e.action, status: e.status, comment: e.comment, user: n.get(e.userId) ?? null }));
  }

  async deleteLine(id: number, req: Request) {
    const l = await this.prisma.mapLine.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('Линия не найдена');
    await this.prisma.mapLine.delete({ where: { id } });
    if (l.fileId) await this.files.remove([l.fileId]);
    await this.audit.log({ action: 'map.line.delete', entity: 'MapLine', entityId: id, before: { name: l.name, status: l.status } }, req);
  }

  // ───────── опоры ─────────

  async createPole(dto: PoleDto, u: AuthUser, req: Request) {
    await this.ownFile(dto.fileId, u);
    const p = await this.prisma.mapPole.create({ data: { ...dto, createdById: u.id } });
    await this.audit.log({ action: 'map.pole.create', entity: 'MapPole', entityId: p.id, after: { number: p.number, comment: p.comment } }, req);
    return p;
  }

  async updatePole(id: number, dto: UpdatePoleDto, u: AuthUser, req: Request) {
    const before = await this.prisma.mapPole.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Опора не найдена');
    await this.ownFile(dto.fileId && dto.fileId !== before.fileId ? dto.fileId : undefined, u);
    const p = await this.prisma.mapPole.update({ where: { id }, data: dto });
    if (dto.fileId && before.fileId && before.fileId !== dto.fileId) await this.files.remove([before.fileId]);
    await this.audit.log({ action: 'map.pole.update', entity: 'MapPole', entityId: id, before: { number: before.number, comment: before.comment }, after: { number: p.number, comment: p.comment } }, req);
    return p;
  }

  /** Перед удалением опоры линии «отклеиваются» от неё и остаются на месте опоры */
  private async detachPole(p: { id: number; x: number; y: number }) {
    const lines = await this.prisma.mapLine.findMany();
    for (const l of lines) {
      const pts = l.points as unknown as LinePoint[];
      if (!pts.some((q) => q.poleId === p.id)) continue;
      await this.prisma.mapLine.update({ where: { id: l.id }, data: { points: pts.map((q) => (q.poleId === p.id ? { x: p.x, y: p.y } : q)) as any } });
    }
  }

  async deletePole(id: number, req: Request) {
    const p = await this.prisma.mapPole.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Опора не найдена');
    await this.detachPole(p);
    await this.prisma.mapPole.delete({ where: { id } });
    if (p.fileId) await this.files.remove([p.fileId]);
    await this.audit.log({ action: 'map.pole.delete', entity: 'MapPole', entityId: id, before: { number: p.number } }, req);
  }
}

@Controller('map')
class MapController {
  constructor(private s: MapService) {}

  @Get() scene(@CurrentUser() u: AuthUser) { return this.s.scene(u); }

  @Put('settings') @RequirePermissions('map.edit')
  settings(@Body() dto: SettingsDto, @Req() req: Request) { return this.s.setSettings(dto, req); }

  @Put('background') @HttpCode(204) @RequirePermissions('map.edit')
  background(@Body() dto: BackgroundDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.setBackground(dto, u, req); }

  @Delete('background') @HttpCode(204) @RequirePermissions('map.edit')
  removeBackground(@Req() req: Request) { return this.s.removeBackground(req); }

  @Post('rows') @RequirePermissions('map.edit')
  createRow(@Body() dto: RowDto, @Req() req: Request) { return this.s.createRow(dto, req); }

  @Patch('rows/:id') @RequirePermissions('map.edit')
  updateRow(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRowDto, @Req() req: Request) { return this.s.updateRow(id, dto, req); }

  @Delete('rows/:id') @HttpCode(204) @RequirePermissions('map.edit')
  deleteRow(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.deleteRow(id, req); }

  @Get('marks/closed') @RequirePermissions('map.view')
  closed() { return this.s.closedMarks(); }

  @Post('marks') @RequirePermissions('map.marks')
  createMark(@Body() dto: MarkDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.createMark(dto, u, req); }

  @Patch('marks/:id') @RequirePermissions('map.marks')
  updateMark(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateMarkDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.updateMark(id, dto, u, req); }

  @Post('marks/:id/close') @HttpCode(204) @RequirePermissions('map.marks')
  closeMark(@Param('id', ParseIntPipe) id: number, @Body() dto: CloseDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.closeMark(id, dto, u, req); }

  @Post('marks/:id/reopen') @HttpCode(204) @RequirePermissions('map.marks')
  reopenMark(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.reopenMark(id, req); }

  @Delete('marks/:id') @HttpCode(204) @RequirePermissions('map.edit')
  deleteMark(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.deleteMark(id, req); }

  @Post('lines') @RequirePermissions('map.marks')
  createLine(@Body() dto: LineDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.createLine(dto, u, req); }

  @Patch('lines/:id') @RequirePermissions('map.marks')
  updateLine(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLineDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.updateLine(id, dto, u, req); }

  @Post('lines/:id/status') @HttpCode(204) @RequirePermissions('map.marks')
  lineStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: LineStatusDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.setLineStatus(id, dto, u, req); }

  @Post('lines/:id/notes') @HttpCode(204) @RequirePermissions('map.marks')
  lineNote(@Param('id', ParseIntPipe) id: number, @Body() dto: LineNoteDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.addLineNote(id, dto, u, req); }

  @Get('lines/:id/events') @RequirePermissions('map.view')
  lineEvents(@Param('id', ParseIntPipe) id: number) { return this.s.lineEvents(id); }

  // удаление линии стирает и её журнал, опоры — привязку линий: как и удаление пометки, только администратору карты
  @Delete('lines/:id') @HttpCode(204) @RequirePermissions('map.edit')
  deleteLine(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.deleteLine(id, req); }

  @Post('poles') @RequirePermissions('map.marks')
  createPole(@Body() dto: PoleDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.createPole(dto, u, req); }

  @Patch('poles/:id') @RequirePermissions('map.marks')
  updatePole(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdatePoleDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.updatePole(id, dto, u, req); }

  @Delete('poles/:id') @HttpCode(204) @RequirePermissions('map.edit')
  deletePole(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.deletePole(id, req); }
}

@Module({ imports: [FilesModule, FinanceModule], controllers: [MapController], providers: [MapService] })
export class MapModule {}
