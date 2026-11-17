import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Req,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { canSeeContacts, maskContacts } from '../common/contacts';
import { PrismaService } from '../common/prisma.service';

const NUMBER_RE = /^[0-9A-Za-zА-Яа-я\-/]{1,12}$/;

class GarageDto {
  @IsString() @Matches(NUMBER_RE, { message: 'Номер: до 12 символов (цифры, буквы, - /)' }) number: string;
  @IsOptional() @IsNumber() @Min(1) @Max(1000) areaM2?: number;
  @IsOptional() @IsInt() @Min(1900) @Max(2100) buildYear?: number;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() hasBenefit?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) benefitPercent?: number;
}

class UpdateGarageDto {
  @IsOptional() @IsString() @Matches(NUMBER_RE) number?: string;
  @IsOptional() @IsNumber() @Min(1) @Max(1000) areaM2?: number | null;
  @IsOptional() @IsInt() @Min(1900) @Max(2100) buildYear?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @IsOptional() @IsBoolean() hasBenefit?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) benefitPercent?: number;
}

class BulkDto {
  @IsInt() @Min(1) @Max(100000) from: number;
  @IsInt() @Min(1) @Max(100000) to: number;
}

class OwnerDto {
  @IsInt() userId: number;
}

class ListQuery {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED']) status?: 'ACTIVE' | 'ARCHIVED';
  @IsOptional() @IsString() benefit?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) pageSize?: number;
}

const naturalSort = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });

@Injectable()
class GaragesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async list(q: ListQuery, u: AuthUser) {
    const page = q.page ?? 1, size = q.pageSize ?? 50;
    const where: any = { status: q.status ?? 'ACTIVE' };
    if (q.benefit === '1') where.hasBenefit = true;
    if (q.q) {
      const digits = q.q.replace(/\D/g, '');
      where.OR = [
        { number: { contains: q.q, mode: 'insensitive' } },
        { owners: { some: { toDate: null, user: { fullName: { contains: q.q, mode: 'insensitive' } } } } },
        // поиск по телефону — только тем, кому телефоны видны
        ...(digits.length >= 3 && canSeeContacts(u) ? [{ owners: { some: { toDate: null, user: { phone: { contains: digits } } } } }] : []),
      ];
    }
    // Номера чаще числовые: сортировка «естественная», поэтому сортируем и режем страницу в памяти (≈700 записей)
    const [rows] = await Promise.all([
      this.prisma.garage.findMany({
        where,
        include: { owners: { where: { toDate: null }, include: { user: { select: { id: true, fullName: true, phone: true } } } } },
      }),
    ]);
    rows.sort((a, b) => naturalSort(a.number, b.number));
    const items = rows.slice((page - 1) * size, page * size).map((g) => ({
      ...g,
      owners: g.owners.map((o) => maskContacts({ ...o.user, isPrimary: false }, u)),
    }));
    return { total: rows.length, page, pageSize: size, items };
  }

  /** Карточка для сотрудника: контакты владельцев — по праву users.view */
  async view(id: number, u: AuthUser) {
    const g = await this.get(id);
    return { ...g, owners: g.owners.map((o) => ({ ...o, user: maskContacts(o.user, u) })) };
  }

  async get(id: number) {
    const g = await this.prisma.garage.findUnique({
      where: { id },
      include: { owners: { include: { user: { select: { id: true, fullName: true, phone: true, email: true } } }, orderBy: { fromDate: 'desc' } } },
    });
    if (!g) throw new NotFoundException('Гараж не найден');
    return g;
  }

  async create(dto: GarageDto, req: Request) {
    if (await this.prisma.garage.findUnique({ where: { number: dto.number } })) throw new ConflictException('Гараж с таким номером уже есть');
    const g = await this.prisma.garage.create({ data: dto });
    await this.audit.log({ action: 'garage.create', entity: 'Garage', entityId: g.id, after: g }, req);
    return g;
  }

  async bulk(dto: BulkDto, req: Request) {
    if (dto.to < dto.from) throw new BadRequestException('«До» не может быть меньше «От»');
    if (dto.to - dto.from > 2000) throw new BadRequestException('Слишком большой диапазон (максимум 2000 за раз)');
    const numbers = Array.from({ length: dto.to - dto.from + 1 }, (_, i) => String(dto.from + i));
    const r = await this.prisma.garage.createMany({ data: numbers.map((number) => ({ number })), skipDuplicates: true });
    await this.audit.log({ action: 'garage.bulk_create', entity: 'Garage', after: { from: dto.from, to: dto.to, created: r.count, skipped: numbers.length - r.count } }, req);
    return { created: r.count, skipped: numbers.length - r.count };
  }

  async update(id: number, dto: UpdateGarageDto, req: Request) {
    const before = await this.get(id);
    if (dto.number && dto.number !== before.number) {
      if (await this.prisma.garage.findUnique({ where: { number: dto.number } })) throw new ConflictException('Номер занят');
    }
    const data: any = { ...dto };
    if (dto.hasBenefit === false) data.benefitPercent = 0;
    const g = await this.prisma.garage.update({ where: { id }, data });
    const { owners: _o, ...b } = before;
    await this.audit.log({ action: 'garage.update', entity: 'Garage', entityId: id, before: b, after: g }, req);
    return g;
  }

  async archive(id: number, req: Request) {
    const g = await this.get(id);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.garage.update({ where: { id }, data: { status: 'ARCHIVED', archivedAt: now } }),
      this.prisma.garageOwner.updateMany({ where: { garageId: id, toDate: null }, data: { toDate: now } }),
    ]);
    await this.audit.log({ action: 'garage.archive', entity: 'Garage', entityId: id, before: { number: g.number } }, req);
  }

  async restore(id: number, req: Request) {
    await this.get(id);
    await this.prisma.garage.update({ where: { id }, data: { status: 'ACTIVE', archivedAt: null } });
    await this.audit.log({ action: 'garage.restore', entity: 'Garage', entityId: id }, req);
  }

  async addOwner(garageId: number, userId: number, req: Request) {
    const g = await this.get(garageId);
    if (g.status === 'ARCHIVED') throw new BadRequestException('Гараж в архиве');
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new NotFoundException('Пользователь не найден');
    const open = await this.prisma.garageOwner.findFirst({ where: { garageId, userId, toDate: null } });
    if (open) throw new ConflictException('Уже является владельцем');
    const o = await this.prisma.garageOwner.create({ data: { garageId, userId } });
    await this.audit.log({ action: 'garage.owner.add', entity: 'Garage', entityId: garageId, after: { userId, phone: user.phone } }, req);
    return o;
  }

  async removeOwner(garageId: number, userId: number, req: Request) {
    const r = await this.prisma.garageOwner.updateMany({ where: { garageId, userId, toDate: null }, data: { toDate: new Date() } });
    if (!r.count) throw new NotFoundException('Владелец не найден');
    await this.audit.log({ action: 'garage.owner.remove', entity: 'Garage', entityId: garageId, before: { userId } }, req);
  }
}

@Controller('garages')
class GaragesController {
  constructor(private s: GaragesService) {}

  @Get() @RequirePermissions('garages.view')
  list(@Query() q: ListQuery, @CurrentUser() u: AuthUser) { return this.s.list(q, u); }

  @Get(':id') @RequirePermissions('garages.view')
  get(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser) { return this.s.view(id, u); }

  @Post() @RequirePermissions('garages.edit')
  create(@Body() dto: GarageDto, @Req() req: Request) { return this.s.create(dto, req); }

  @Post('bulk') @HttpCode(200) @RequirePermissions('garages.edit')
  bulk(@Body() dto: BulkDto, @Req() req: Request) { return this.s.bulk(dto, req); }

  @Patch(':id') @RequirePermissions('garages.edit')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGarageDto, @Req() req: Request) { return this.s.update(id, dto, req); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('garages.delete')
  archive(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.archive(id, req); }

  @Post(':id/restore') @HttpCode(204) @RequirePermissions('garages.delete')
  restore(@Param('id', ParseIntPipe) id: number, @Req() req: Request) { return this.s.restore(id, req); }

  @Post(':id/owners') @RequirePermissions('garages.edit')
  addOwner(@Param('id', ParseIntPipe) id: number, @Body() dto: OwnerDto, @Req() req: Request) { return this.s.addOwner(id, dto.userId, req); }

  @Delete(':id/owners/:userId') @HttpCode(204) @RequirePermissions('garages.edit')
  removeOwner(@Param('id', ParseIntPipe) id: number, @Param('userId', ParseIntPipe) userId: number, @Req() req: Request) { return this.s.removeOwner(id, userId, req); }
}

@Module({ controllers: [GaragesController], providers: [GaragesService], exports: [GaragesService] })
export class GaragesModule {}
