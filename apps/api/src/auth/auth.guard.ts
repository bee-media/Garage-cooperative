import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { IS_PUBLIC, NO_2FA, NO_CONSENT, PERMS, PORTAL_ONLY } from './decorators';
import { SecurityPolicyService } from './twofactor.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private jwt: JwtService,
    private prisma: PrismaService,
    private cfg: ConfigService,
    private policy: SecurityPolicyService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    // Подписанная ссылка на файл (?t=) допустима только для GET /files/:id и только для этого файла
    const linkToken =
      !bearer && req.method === 'GET' && typeof req.query?.t === 'string' && /^\/api\/(files\/[^/]+|releases\/\d+\/download)$/.test(req.path)
        ? (req.query.t as string)
        : undefined;
    const token = bearer ?? linkToken;
    if (!token) throw new UnauthorizedException('Требуется вход');

    let payload: { sub: number; sid: string; fid?: string; typ?: string };
    try {
      payload = linkToken
        ? await this.jwt.verifyAsync(token, { secret: this.cfg.getOrThrow<string>('JWT_ACCESS_SECRET') + ':file-link' })
        : await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Сессия истекла');
    }
    if (!payload.sid) throw new UnauthorizedException('Сессия недействительна');
    if (linkToken && (payload.typ !== 'file' || payload.fid !== req.params?.id)) {
      throw new UnauthorizedException('Ссылка недействительна');
    }
    if (!linkToken && payload.typ === 'file') throw new UnauthorizedException('Сессия недействительна');

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: { include: { role: true } } },
    });
    const u = session?.user;
    if (
      !session || session.revokedAt || session.expiresAt < new Date() ||
      !u || u.deletedAt || u.isBlocked || u.lockedAt || u.id !== payload.sub
    ) {
      throw new UnauthorizedException('Сессия недействительна');
    }

    const user: AuthUser = {
      id: u.id,
      phone: u.phone,
      fullName: u.fullName,
      roleId: u.roleId,
      roleName: u.role.name,
      permissions: u.role.permissions,
      portalAccess: u.role.portalAccess,
      sessionId: session.id,
      consentAt: u.consentAt,
      totpEnabled: u.totpEnabled,
    };
    req.user = user;

    if (!user.consentAt && !this.reflector.getAllAndOverride<boolean>(NO_CONSENT, targets)) {
      throw new ForbiddenException({ code: 'CONSENT_REQUIRED', message: 'Требуется согласие на обработку персональных данных' });
    }

    // Сотрудник портала без настроенной 2FA (при включённой политике) может только настроить её или выйти.
    // Проверка на сервере, поэтому обойти её, войдя через другой клиент, нельзя.
    if (user.portalAccess && !user.totpEnabled && !this.reflector.getAllAndOverride<boolean>(NO_2FA, targets) && (await this.policy.require2fa())) {
      throw new ForbiddenException({ code: 'TWO_FACTOR_SETUP_REQUIRED', message: 'Для работы нужно настроить двухфакторную защиту' });
    }

    if (this.reflector.getAllAndOverride<boolean>(PORTAL_ONLY, targets) && !user.portalAccess) {
      throw new ForbiddenException('Недостаточно прав');
    }

    const need = this.reflector.getAllAndOverride<string[]>(PERMS, targets);
    if (need?.length) {
      if (!user.portalAccess || !need.every((p) => user.permissions.includes(p))) {
        throw new ForbiddenException('Недостаточно прав');
      }
    }
    return true;
  }
}
