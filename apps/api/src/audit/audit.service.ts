import { Global, Injectable, Module } from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../common/prisma.service';

export interface AuthUser {
  id: number;
  phone: string;
  fullName: string | null;
  roleId: number;
  roleName: string;
  permissions: string[];
  portalAccess: boolean;
  sessionId: string;
  consentAt: Date | null;
  totpEnabled: boolean;
}

export interface AuditEntry {
  action: string; // например: user.create, auth.login.fail
  entity?: string;
  entityId?: string | number;
  before?: unknown;
  after?: unknown;
  actor?: { id?: number; phone?: string } | null;
}

const SENSITIVE = new Set(['passwordHash', 'totpSecret', 'refreshHash', 'password']);

function scrub(v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  return JSON.parse(
    JSON.stringify(v, (k, val) => {
      if (SENSITIVE.has(k)) return '***';
      if (typeof val === 'bigint') return val.toString();
      return val;
    }),
  );
}

export const clientIp = (req?: Request) =>
  (req?.ip ?? req?.socket?.remoteAddress ?? '').replace('::ffff:', '') || undefined;

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(entry: AuditEntry, req?: Request) {
    const user = (req as any)?.user as AuthUser | undefined;
    const actor = entry.actor ?? (user ? { id: user.id, phone: user.phone } : null);
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: actor?.id,
          actorPhone: actor?.phone,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId !== undefined ? String(entry.entityId) : undefined,
          before: scrub(entry.before) as any,
          after: scrub(entry.after) as any,
          ip: clientIp(req),
          userAgent: req?.headers['user-agent']?.slice(0, 300),
        },
      });
    } catch (e) {
      // Журнал не должен ронять основной запрос, но ошибка не теряется
      console.error('audit write failed', e);
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditCoreModule {}
