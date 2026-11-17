import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';

class AuditQuery {
  @IsOptional() @Type(() => Number) @IsInt() actorId?: number;
  @IsOptional() @IsString() @MaxLength(60) action?: string;
  @IsOptional() @IsString() @MaxLength(60) entity?: string;
  @IsOptional() @IsString() @MaxLength(40) entityId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

@Injectable()
class AuditQueryService {
  constructor(private prisma: PrismaService) {}

  async list(q: AuditQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 50;
    const where: any = {};
    if (q.actorId) where.actorId = q.actorId;
    if (q.action) where.action = { startsWith: q.action };
    if (q.entity) where.entity = q.entity;
    if (q.entityId) where.entityId = q.entityId;
    if (q.from || q.to) where.at = { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size }),
    ]);
    return { total, page, pageSize: size, items: rows.map((r) => ({ ...r, id: r.id.toString() })) };
  }

  /** Хранение журнала — 3 года */
  async purgeOld() {
    const border = new Date();
    border.setFullYear(border.getFullYear() - 3);
    return this.prisma.auditLog.deleteMany({ where: { at: { lt: border } } });
  }
}

@Controller('audit')
class AuditController {
  constructor(private s: AuditQueryService) {}

  @Get() @RequirePermissions('audit.view')
  list(@Query() q: AuditQuery) { return this.s.list(q); }
}

@Module({ controllers: [AuditController], providers: [AuditQueryService], exports: [AuditQueryService] })
export class AuditModule {}
