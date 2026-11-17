import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable,
  Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { assertCanAssignRole, assertCanManage } from '../common/hierarchy';
import { generatePassword, hashPassword } from '../common/password';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../common/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class CreateUserDto {
  @IsString() phone: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(150) fullName?: string;
  @IsOptional() @Transform(trim) @ValidateIf((_, v) => v !== '' && v != null) @IsEmail() email?: string;
  @IsOptional() @IsInt() roleId?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) garageNumbers?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(150) fullName?: string;
  @IsOptional() @Transform(trim) @ValidateIf((_, v) => v !== '' && v != null) @IsEmail() email?: string | null;
  @IsOptional() @IsInt() roleId?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class ListQuery {
  @IsOptional() @IsString() @MaxLength(60) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() roleId?: number;
  @IsOptional() @IsIn(['blocked', 'active', 'noconsent']) status?: 'blocked' | 'active' | 'noconsent';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
}

const publicUser = {
  id: true, phone: true, fullName: true, email: true, roleId: true, isBlocked: true, lockedAt: true,
  pushEnabled: true, consentAt: true, lastLoginAt: true, note: true, createdAt: true, totpEnabled: true,
} as const;

@Injectable()
class UsersService {
  constructor(private prisma: PrismaService, private audit: AuditService, private cfg: ConfigService) {}

  private phoneOrThrow(p: string) {
    const n = normalizePhone(p);
    if (!n) throw new BadRequestException('Телефон должен быть в формате 909-111-22-77');
    return n;
  }

  async list(q: ListQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 25;
    const digits = q.q?.replace(/\D/g, '');
    const where: any = { deletedAt: null };
    if (q.roleId) where.roleId = q.roleId;
    if (q.status === 'blocked') where.OR = [{ isBlocked: true }, { lockedAt: { not: null } }];
    if (q.status === 'noconsent') where.consentAt = null;
    if (q.q) {
      const or: any[] = [
        { fullName: { contains: q.q, mode: 'insensitive' } },
        { garages: { some: { toDate: null, garage: { number: { equals: q.q } } } } },
      ];
      if (digits) or.push({ phone: { contains: digits } });
      where.AND = [{ OR: or }];
    }
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where, skip: (page - 1) * size, take: size, orderBy: { id: 'desc' },
        select: { ...publicUser, role: { select: { name: true } }, garages: { where: { toDate: null }, select: { garage: { select: { id: true, number: true, hasBenefit: true } } } } },
      }),
    ]);
    return {
      total, page, pageSize: size,
      items: rows.map(({ garages, ...u }) => ({ ...u, garages: garages.map((g) => g.garage) })),
    };
  }

  async get(id: number) {
    const u = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { ...publicUser, role: { select: { id: true, name: true } }, garages: { include: { garage: true }, orderBy: { fromDate: 'desc' } } },
    });
    if (!u) throw new NotFoundException('Пользователь не найден');
    return u;
  }

  async create(dto: CreateUserDto, actor: AuthUser, req: Request) {
    const phone = this.phoneOrThrow(dto.phone);
    if (await this.prisma.user.findUnique({ where: { phone } })) throw new ConflictException('Пользователь с таким телефоном уже есть');
    const roleId = dto.roleId ?? (await this.prisma.role.findUniqueOrThrow({ where: { name: 'Житель' } })).id;
    if (dto.roleId !== undefined) await assertCanAssignRole(this.prisma, actor, dto.roleId);

    const garages = dto.garageNumbers?.length
      ? await this.prisma.garage.findMany({ where: { number: { in: dto.garageNumbers }, status: 'ACTIVE' } })
      : [];
    const missing = (dto.garageNumbers ?? []).filter((n) => !garages.some((g) => g.number === n));
    if (missing.length) throw new BadRequestException(`Гараж не найден: ${missing.join(', ')}`);

    const user = await this.prisma.user.create({
      data: {
        phone, fullName: dto.fullName, email: dto.email || null, roleId, note: dto.note,
        // неизвестный пароль: реальный выдаётся кнопкой «Выдать пароль»
        passwordHash: await hashPassword(generatePassword(24)),
        garages: { create: garages.map((g) => ({ garageId: g.id })) },
      },
      select: publicUser,
    });
    await this.audit.log({ action: 'user.create', entity: 'User', entityId: user.id, after: { ...user, garages: dto.garageNumbers } }, req);
    return user;
  }

  async update(id: number, dto: UpdateUserDto, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, id, { self: true });
    if (dto.roleId !== undefined && id === actor.id && dto.roleId !== actor.roleId) throw new BadRequestException('Свою роль менять нельзя');
    if (dto.roleId !== undefined) await assertCanAssignRole(this.prisma, actor, dto.roleId);
    const before = await this.get(id);
    const data: any = { fullName: dto.fullName, note: dto.note, roleId: dto.roleId };
    if (dto.email !== undefined) data.email = dto.email || null;
    if (dto.phone !== undefined) {
      data.phone = this.phoneOrThrow(dto.phone);
      const dup = await this.prisma.user.findFirst({ where: { phone: data.phone, NOT: { id } } });
      if (dup) throw new ConflictException('Телефон уже занят');
    }
    const after = await this.prisma.user.update({ where: { id }, data, select: publicUser });
    if (dto.roleId !== undefined && dto.roleId !== before.roleId) {
      await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.log({ action: 'user.update', entity: 'User', entityId: id, before, after }, req);
    return after;
  }

  async remove(id: number, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, id);
    const before = await this.get(id);
    const now = new Date();
    await this.prisma.$transaction([
      // Номер — это логин, и его можно снова выдать (вернулся житель, номер перешёл другому человеку): освобождаем его.
      // Новая учётная запись не наследует чужие показания, объявления и фото, как было бы при «оживлении» старой.
      this.prisma.user.update({ where: { id }, data: { deletedAt: now, phone: `${before.phone}~${id}` } }),
      // объявления удалённого не остаются на доске с его телефоном
      this.prisma.ad.updateMany({ where: { userId: id, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'ARCHIVED', archivedAt: now } }),
      this.prisma.garageOwner.updateMany({ where: { userId: id, toDate: null }, data: { toDate: now } }),
      this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.pushDevice.deleteMany({ where: { userId: id } }),
    ]);
    await this.audit.log({ action: 'user.delete', entity: 'User', entityId: id, before }, req);
  }

  async issuePassword(id: number, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, id);
    const u = await this.get(id);
    const password = generatePassword(10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), failedAttempts: 0, lockedAt: null, isBlocked: false } }),
      this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ action: 'user.password.issue', entity: 'User', entityId: id }, req);
    const pwa = (this.cfg.get<string>('PWA_URL') ?? '').replace(/\/$/, '');
    // В QR только ссылка и телефон, пароль в нём не передаётся
    return { phone: u.phone, password, loginUrl: `${pwa}/login?phone=${u.phone}` };
  }

  async unblock(id: number, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, id, { self: true });
    await this.prisma.user.update({ where: { id }, data: { failedAttempts: 0, lockedAt: null, isBlocked: false } });
    await this.audit.log({ action: 'user.unblock', entity: 'User', entityId: id }, req);
  }

  async block(id: number, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, id);
    await this.prisma.user.update({ where: { id }, data: { isBlocked: true } });
    await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'user.block', entity: 'User', entityId: id }, req);
  }

  async sessions(id: number) {
    return this.prisma.session.findMany({
      where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, client: true, deviceName: true, ip: true, createdAt: true, lastUsedAt: true },
    });
  }

  async revokeSessions(id: number, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, id, { self: true });
    const r = await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'user.sessions.revoke', entity: 'User', entityId: id, after: { count: r.count } }, req);
    return { revoked: r.count };
  }
}

@Controller('users')
class UsersController {
  constructor(private s: UsersService) {}

  @Get() @RequirePermissions('users.view')
  list(@Query() q: ListQuery) { return this.s.list(q); }

  @Get(':id') @RequirePermissions('users.view')
  get(@Param('id', ParseIntPipe) id: number) { return this.s.get(id); }

  @Post() @RequirePermissions('users.edit')
  create(@Body() dto: CreateUserDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.create(dto, u, req); }

  @Patch(':id') @RequirePermissions('users.edit')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.update(id, dto, u, req); }

  @Delete(':id') @HttpCode(204) @RequirePermissions('users.delete')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.remove(id, u, req); }

  @Post(':id/password') @HttpCode(200) @RequirePermissions('passwords.issue')
  issue(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.issuePassword(id, u, req); }

  @Post(':id/unblock') @HttpCode(204) @RequirePermissions('passwords.issue')
  unblock(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.unblock(id, u, req); }

  @Post(':id/block') @HttpCode(204) @RequirePermissions('passwords.issue')
  block(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.block(id, u, req); }

  @Get(':id/sessions') @RequirePermissions('users.view')
  sessions(@Param('id', ParseIntPipe) id: number) { return this.s.sessions(id); }

  @Post(':id/sessions/revoke') @HttpCode(200) @RequirePermissions('passwords.issue')
  revoke(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.revokeSessions(id, u, req); }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}
