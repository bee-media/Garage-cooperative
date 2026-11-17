import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException,
  Param, ParseIntPipe, Patch, Post, Put, Req,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { RequirePermissions } from '../auth/decorators';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../common/prisma.service';
import { mskParts } from '../common/time';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class DayDto {
  @IsInt() @Min(1) @Max(7) weekday: number; // 1 = понедельник
  @IsBoolean() isClosed: boolean;
  @IsOptional() @Matches(HHMM, { message: 'Время в формате ЧЧ:ММ' }) opensAt?: string;
  @IsOptional() @Matches(HHMM, { message: 'Время в формате ЧЧ:ММ' }) closesAt?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(200) note?: string;
}

class WeeklyDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @ValidateNested({ each: true }) @Type(() => DayDto) days: DayDto[];
  /** Общее примечание (адрес приёма, где найти правление и т.п.) */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(1000) note?: string;
}

class ExceptionDto {
  @IsDateString() date: string; // YYYY-MM-DD
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(300) note: string;
}

class ContactDto {
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) position: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(150) fullName: string;
  @IsString() phone: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sort?: number;
}

class UpdateContactDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(100) position?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(150) fullName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sort?: number;
}

@Injectable()
class ScheduleService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private phone(p: string) {
    const n = normalizePhone(p);
    if (!n) throw new BadRequestException('Телефон должен быть в формате 909-111-22-77');
    return n;
  }

  async schedule() {
    const [days, exceptions, note] = await Promise.all([
      this.prisma.scheduleEntry.findMany({ orderBy: { weekday: 'asc' } }),
      this.prisma.scheduleException.findMany({ where: { date: { gte: this.todayMsk() } }, orderBy: { date: 'asc' } }),
      this.prisma.setting.findUnique({ where: { key: 'scheduleNote' } }),
    ]);
    const m = mskParts();
    return {
      days: days.map(({ id, ...d }) => d),
      exceptions: exceptions.map((e) => ({ id: e.id, date: e.date.toISOString().slice(0, 10), note: e.note })),
      note: ((note?.value as any)?.text as string) ?? '',
      todayWeekday: this.weekdayMsk(),
      generatedAtMsk: `${m.year}-${String(m.month).padStart(2, '0')}-${String(m.day).padStart(2, '0')}`,
    };
  }

  private todayMsk() {
    const m = mskParts();
    return new Date(Date.UTC(m.year, m.month - 1, m.day));
  }

  private weekdayMsk() {
    const d = this.todayMsk().getUTCDay(); // 0 = вс
    return d === 0 ? 7 : d;
  }

  async setWeekly(dto: WeeklyDto, req: Request) {
    const seen = new Set<number>();
    for (const d of dto.days) {
      if (seen.has(d.weekday)) throw new BadRequestException('День недели указан дважды');
      seen.add(d.weekday);
      if (!d.isClosed) {
        if (!d.opensAt || !d.closesAt) throw new BadRequestException('Укажите время начала и конца или отметьте «выходной»');
        if (d.opensAt >= d.closesAt) throw new BadRequestException('Время начала должно быть раньше конца');
      }
    }
    const before = await this.schedule();
    await this.prisma.$transaction([
      this.prisma.scheduleEntry.deleteMany(),
      this.prisma.scheduleEntry.createMany({
        data: dto.days.map((d) => ({
          weekday: d.weekday, isClosed: d.isClosed, opensAt: d.isClosed ? null : d.opensAt, closesAt: d.isClosed ? null : d.closesAt, note: d.note || null,
        })),
      }),
      this.prisma.setting.upsert({ where: { key: 'scheduleNote' }, update: { value: { text: dto.note ?? '' } }, create: { key: 'scheduleNote', value: { text: dto.note ?? '' } } }),
    ]);
    await this.audit.log({ action: 'schedule.update', entity: 'Schedule', before: { days: before.days, note: before.note }, after: dto }, req);
    return this.schedule();
  }

  async addException(dto: ExceptionDto, req: Request) {
    const date = new Date(dto.date.slice(0, 10));
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Некорректная дата');
    const e = await this.prisma.scheduleException.create({ data: { date, note: dto.note } });
    await this.audit.log({ action: 'schedule.exception.add', entity: 'ScheduleException', entityId: e.id, after: dto }, req);
    return e;
  }

  async removeException(id: number, req: Request) {
    const e = await this.prisma.scheduleException.findUnique({ where: { id } });
    if (!e) throw new NotFoundException();
    await this.prisma.scheduleException.delete({ where: { id } });
    await this.audit.log({ action: 'schedule.exception.remove', entity: 'ScheduleException', entityId: id, before: e }, req);
  }

  // ───────── контакты ─────────

  contacts() {
    return this.prisma.contact.findMany({ orderBy: [{ sort: 'asc' }, { id: 'asc' }] });
  }

  async addContact(dto: ContactDto, req: Request) {
    const c = await this.prisma.contact.create({ data: { position: dto.position, fullName: dto.fullName, phone: this.phone(dto.phone), sort: dto.sort ?? 0 } });
    await this.audit.log({ action: 'contact.create', entity: 'Contact', entityId: c.id, after: c }, req);
    return c;
  }

  async updateContact(id: number, dto: UpdateContactDto, req: Request) {
    const before = await this.prisma.contact.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    const after = await this.prisma.contact.update({
      where: { id }, data: { position: dto.position, fullName: dto.fullName, sort: dto.sort, phone: dto.phone ? this.phone(dto.phone) : undefined },
    });
    await this.audit.log({ action: 'contact.update', entity: 'Contact', entityId: id, before, after }, req);
    return after;
  }

  async removeContact(id: number, req: Request) {
    const c = await this.prisma.contact.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    await this.prisma.contact.delete({ where: { id } });
    await this.audit.log({ action: 'contact.delete', entity: 'Contact', entityId: id, before: c }, req);
  }
}

// Чтение — любому авторизованному (данные правления закрыты для посторонних)
@Controller()
class ScheduleController {
  constructor(private s: ScheduleService) {}

  @Get('schedule') schedule() { return this.s.schedule(); }

  @Put('schedule') @RequirePermissions('schedule.edit')
  setWeekly(@Body() dto: WeeklyDto, @Req() req: Request) { return this.s.setWeekly(dto, req); }

  @Post('schedule/exceptions') @RequirePermissions('schedule.edit')
  addException(@Body() dto: ExceptionDto, @Req() req: Request) { return this.s.addException(dto, req); }

  @Delete('schedule/exceptions/:id') @HttpCode(204) @RequirePermissions('schedule.edit')
  removeException(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.removeException(id, req); }

  @Get('contacts') contacts() { return this.s.contacts(); }

  @Post('contacts') @RequirePermissions('schedule.edit')
  addContact(@Body() dto: ContactDto, @Req() req: Request) { return this.s.addContact(dto, req); }

  @Patch('contacts/:id') @RequirePermissions('schedule.edit')
  updateContact(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateContactDto, @Req() req: Request) { return this.s.updateContact(id, dto, req); }

  @Delete('contacts/:id') @HttpCode(204) @RequirePermissions('schedule.edit')
  removeContact(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.removeContact(id, req); }
}

@Module({ controllers: [ScheduleController], providers: [ScheduleService] })
export class ScheduleModule {}
