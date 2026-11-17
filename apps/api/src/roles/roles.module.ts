import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Injectable, Module, NotFoundException, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { assertCanGrant } from '../common/hierarchy';
import { PERMISSIONS } from '../common/permissions';
import { PrismaService } from '../common/prisma.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';

class RoleDto {
  @IsString() @MinLength(2) @MaxLength(60) name: string;
  @IsOptional() @IsString() @MaxLength(200) description?: string;
  @IsBoolean() portalAccess: boolean;
  @IsArray() @IsString({ each: true }) permissions: string[];
}

@Injectable()
class RolesService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private check(dto: RoleDto) {
    const bad = dto.permissions.filter((p) => !(p in PERMISSIONS));
    if (bad.length) throw new BadRequestException(`Неизвестные права: ${bad.join(', ')}`);
  }

  list() {
    return this.prisma.role.findMany({ orderBy: { id: 'asc' }, include: { _count: { select: { users: true } } } });
  }

  async create(dto: RoleDto, actor: AuthUser, req: Request) {
    this.check(dto);
    assertCanGrant(actor, dto.permissions);
    const role = await this.prisma.role.create({ data: dto });
    await this.audit.log({ action: 'role.create', entity: 'Role', entityId: role.id, after: role }, req);
    return role;
  }

  async update(id: number, dto: RoleDto, actor: AuthUser, req: Request) {
    this.check(dto);
    const before = await this.prisma.role.findUnique({ where: { id } });
    if (!before) throw new NotFoundException();
    // роль с правами больше своих не трогаем, и новых прав сверх своих не выдаём
    assertCanGrant(actor, before.permissions);
    assertCanGrant(actor, dto.permissions);
    // Права администратора и роль жителя защищены от изменения
    if (before.isSystem && (before.name === 'Администратор' || before.name === 'Житель')) {
      throw new BadRequestException('Эту системную роль изменять нельзя');
    }
    const role = await this.prisma.role.update({ where: { id }, data: { ...dto, name: before.isSystem ? before.name : dto.name } });
    await this.audit.log({ action: 'role.update', entity: 'Role', entityId: id, before, after: role }, req);
    return role;
  }

  async remove(id: number, actor: AuthUser, req: Request) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
    if (!role) throw new NotFoundException();
    assertCanGrant(actor, role.permissions);
    if (role.isSystem) throw new BadRequestException('Системную роль удалить нельзя');
    if (role._count.users) throw new BadRequestException('Роль назначена пользователям');
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log({ action: 'role.delete', entity: 'Role', entityId: id, before: role }, req);
  }
}

@Controller('roles')
class RolesController {
  constructor(private s: RolesService) {}

  @Get('permissions')
  @RequirePermissions('roles.manage')
  catalog() {
    return Object.entries(PERMISSIONS).map(([key, title]) => ({ key, title }));
  }

  @Get()
  @RequirePermissions('users.view')
  list() {
    return this.s.list();
  }

  @Post()
  @RequirePermissions('roles.manage')
  create(@Body() dto: RoleDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.s.create(dto, u, req);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: RoleDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.s.update(id, dto, u, req);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('roles.manage')
  remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.s.remove(id, u, req);
  }
}

@Module({ controllers: [RolesController], providers: [RolesService] })
export class RolesModule {}
