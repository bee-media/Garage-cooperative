import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import { AuditService, AuthUser, clientIp } from '../audit/audit.service';
import { dummyVerify, verifyPassword } from '../common/password';
import { normalizePhone } from '../common/phone';
import { PrismaService } from '../common/prisma.service';
import { TwoFactorService } from './twofactor.service';

export const MAX_FAILED_ATTEMPTS = 5;
export const CONSENT_VERSION = '2026-10-16';
const CLIENTS = ['web-admin', 'pwa', 'android'] as const;
export type ClientKind = (typeof CLIENTS)[number];

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const BAD_CREDENTIALS = 'Неверный телефон или пароль';
/** Сколько после ротации ещё принимается предыдущий refresh: параллельные запросы (несколько вкладок одного браузера) */
export const REFRESH_GRACE_MS = 30_000;

type SessionWithUser = { id: string; userId: number; revokedAt: Date | null; expiresAt: Date; rotatedAt: Date | null; user: { phone: string; deletedAt: Date | null; isBlocked: boolean; lockedAt: Date | null } };
const usable = (s: SessionWithUser | null): s is SessionWithUser =>
  !!s && !s.revokedAt && s.expiresAt >= new Date() && !s.user.deletedAt && !s.user.isBlocked && !s.user.lockedAt;

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private cfg: ConfigService,
    private audit: AuditService,
    private twoFactor: TwoFactorService,
  ) {}

  private refreshTtlMs() {
    return Number(this.cfg.get('REFRESH_TTL_DAYS') ?? 30) * 86400_000;
  }

  private async issueTokens(sessionId: string, userId: number) {
    const accessToken = await this.jwt.signAsync({ sub: userId, sid: sessionId });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        refreshHash: sha256(refreshToken),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      },
    });
    return { accessToken, refreshToken };
  }

  async login(
    dto: { phone: string; password: string; client: ClientKind; deviceName?: string },
    req: Request,
  ) {
    const phone = normalizePhone(dto.phone);
    const user = phone
      ? await this.prisma.user.findFirst({ where: { phone, deletedAt: null }, include: { role: true } })
      : null;

    if (!user) {
      await dummyVerify(dto.password);
      await this.audit.log({ action: 'auth.login.fail', after: { phone: phone ?? 'некорректный формат', reason: 'unknown' }, actor: null }, req);
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    const alreadyLocked = user.isBlocked || !!user.lockedAt;
    const ok = await verifyPassword(user.passwordHash, dto.password);

    if (!ok) {
      if (!alreadyLocked) await this.registerFailure(user.id, user.phone, 'auth.login.fail', req);
      throw new UnauthorizedException(BAD_CREDENTIALS);
    }

    if (alreadyLocked) {
      await this.audit.log({ action: 'auth.login.blocked', entity: 'User', entityId: user.id, actor: { id: user.id, phone: user.phone } }, req);
      throw new ForbiddenException({ code: 'ACCOUNT_LOCKED', message: 'Учётная запись заблокирована. Обратитесь к председателю правления.' });
    }
    if (dto.client === 'web-admin' && !user.role.portalAccess) {
      throw new ForbiddenException('Нет доступа к порталу администрирования');
    }

    // Сотрудники портала с включённой 2FA получают вторую ступень: сессия выдаётся только после кода.
    // Это относится ко ВСЕМ клиентам (портал, PWA, Android): права сотрудника не зависят от того, откуда он вошёл.
    if (user.role.portalAccess && user.totpEnabled) {
      const challengeToken = await this.jwt.signAsync(
        { sub: user.id, typ: '2fa', client: dto.client, dn: dto.deviceName?.slice(0, 100) },
        { secret: this.challengeSecret(), expiresIn: '5m' },
      );
      await this.audit.log({ action: 'auth.2fa.challenge', entity: 'User', entityId: user.id, actor: { id: user.id, phone: user.phone } }, req);
      return { twoFactorRequired: true as const, challengeToken };
    }
    return this.startSession(user, dto.client, dto.deviceName, req, false);
  }

  /**
   * Учёт неудачной попытки. Счётчик увеличивается атомарно в БД: при параллельных запросах
   * (перебор пароля пачкой запросов) каждая попытка засчитывается, и блокировка наступает ровно на пятой.
   */
  private async registerFailure(userId: number, phone: string, action: string, req: Request) {
    const u = await this.prisma.user.update({ where: { id: userId }, data: { failedAttempts: { increment: 1 } }, select: { failedAttempts: true } });
    const lock = u.failedAttempts >= MAX_FAILED_ATTEMPTS;
    if (lock) await this.prisma.user.updateMany({ where: { id: userId, lockedAt: null }, data: { lockedAt: new Date() } });
    await this.audit.log({ action: lock ? 'auth.lock' : action, entity: 'User', entityId: userId, after: { attempts: u.failedAttempts }, actor: { id: userId, phone } }, req);
  }

  private challengeSecret() {
    return this.cfg.getOrThrow<string>('JWT_ACCESS_SECRET') + ':2fa';
  }

  /** Вторая ступень входа: код из приложения или резервный код */
  async verifyTwoFactor(dto: { challengeToken: string; code: string }, req: Request) {
    let payload: { sub: number; typ: string; client: ClientKind; dn?: string };
    try {
      payload = await this.jwt.verifyAsync(dto.challengeToken, { secret: this.challengeSecret() });
    } catch {
      throw new UnauthorizedException('Время подтверждения истекло. Войдите заново');
    }
    if (payload.typ !== '2fa') throw new UnauthorizedException('Недействительный запрос');
    const user = await this.prisma.user.findFirst({ where: { id: payload.sub, deletedAt: null }, include: { role: true } });
    if (!user || !user.totpEnabled) throw new UnauthorizedException('Недействительный запрос');
    if (user.isBlocked || user.lockedAt) {
      throw new ForbiddenException({ code: 'ACCOUNT_LOCKED', message: 'Учётная запись заблокирована. Обратитесь к председателю правления.' });
    }

    const kind = await this.twoFactor.verifyCode(user.id, dto.code);
    if (!kind) {
      // Неверный код считается так же, как неверный пароль: пять ошибок — блокировка
      await this.registerFailure(user.id, user.phone, 'auth.2fa.fail', req);
      throw new UnauthorizedException('Неверный код');
    }
    if (kind === 'backup') {
      await this.audit.log({ action: 'auth.2fa.backup_used', entity: 'User', entityId: user.id, actor: { id: user.id, phone: user.phone } }, req);
    }
    const res = await this.startSession(user, payload.client, payload.dn, req, true);
    return { ...res, client: payload.client, backupCodeUsed: kind === 'backup' };
  }

  private async startSession(
    user: { id: number; phone: string; consentAt: Date | null },
    client: ClientKind, deviceName: string | undefined, req: Request, twoFactor: boolean,
  ) {
    await this.prisma.user.update({ where: { id: user.id }, data: { failedAttempts: 0, lastLoginAt: new Date() } });
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshHash: sha256(randomBytes(16).toString('hex')),
        client,
        deviceName: deviceName?.slice(0, 100),
        userAgent: req.headers['user-agent']?.slice(0, 300),
        ip: clientIp(req),
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      },
    });
    const tokens = await this.issueTokens(session.id, user.id);
    await this.audit.log({ action: 'auth.login', entity: 'User', entityId: user.id, after: { client, twoFactor }, actor: { id: user.id, phone: user.phone } }, req);
    return { ...tokens, consentRequired: !user.consentAt, consentVersion: CONSENT_VERSION };
  }

  /**
   * Обмен refresh-токена на новую пару. Ротация атомарна (условие на текущий хэш в самом запросе): один и тот же токен
   * поворачивается ровно один раз. Без нового refresh (`refreshToken` отсутствует) ответ означает: клиент уже получил
   * новый токен параллельным запросом и должен оставить его у себя.
   */
  async refresh(refreshToken: string | undefined, req: Request): Promise<{ accessToken: string; refreshToken?: string }> {
    if (!refreshToken) throw new UnauthorizedException('Требуется вход');
    const hash = sha256(refreshToken);
    const session = await this.prisma.session.findUnique({ where: { refreshHash: hash }, include: { user: true } });
    if (!session) return this.refreshWithPrevious(hash, req);
    if (!usable(session)) throw new UnauthorizedException('Сессия недействительна');

    const next = randomBytes(48).toString('base64url');
    const now = new Date();
    const r = await this.prisma.session.updateMany({
      where: { id: session.id, refreshHash: hash, revokedAt: null },
      data: { refreshHash: sha256(next), prevRefreshHash: hash, rotatedAt: now, lastUsedAt: now, expiresAt: new Date(now.getTime() + this.refreshTtlMs()) },
    });
    if (!r.count) return this.refreshWithPrevious(hash, req); // параллельный запрос успел повернуть токен
    return { accessToken: await this.jwt.signAsync({ sub: session.userId, sid: session.id }), refreshToken: next };
  }

  /**
   * Предъявлен предыдущий (уже повёрнутый) refresh. В коротком окне — это параллельный запрос того же клиента: выдаём
   * только access. Позже — токен скопирован (кража cookie/хранилища): сессия завершается, владелец войдёт заново.
   */
  private async refreshWithPrevious(hash: string, req: Request) {
    const s = await this.prisma.session.findUnique({ where: { prevRefreshHash: hash }, include: { user: true } });
    if (!usable(s)) throw new UnauthorizedException('Сессия недействительна');
    if (s.rotatedAt && Date.now() - s.rotatedAt.getTime() <= REFRESH_GRACE_MS) {
      return { accessToken: await this.jwt.signAsync({ sub: s.userId, sid: s.id }) };
    }
    await this.prisma.session.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'auth.refresh.reuse', entity: 'Session', entityId: s.id, actor: { id: s.userId, phone: s.user.phone } }, req);
    throw new UnauthorizedException('Сессия недействительна');
  }

  async logout(user: AuthUser, req: Request) {
    await this.prisma.session.update({ where: { id: user.sessionId }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'auth.logout' }, req);
  }

  async me(user: AuthUser) {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: {
        role: true,
        garages: { where: { toDate: null }, include: { garage: true } },
      },
    });
    return {
      id: u.id,
      phone: u.phone,
      fullName: u.fullName,
      email: u.email,
      pushEnabled: u.pushEnabled,
      consentAt: u.consentAt,
      consentRequired: !u.consentAt,
      consentVersion: CONSENT_VERSION,
      role: { id: u.role.id, name: u.role.name },
      portalAccess: u.role.portalAccess,
      permissions: u.role.permissions,
      garages: u.garages.map((g) => ({ id: g.garage.id, number: g.garage.number, hasBenefit: g.garage.hasBenefit })),
      twoFactor: await this.twoFactor.status(u.id),
    };
  }

  async updateProfile(user: AuthUser, data: { email?: string | null; pushEnabled?: boolean }, req: Request) {
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const after = await this.prisma.user.update({
      where: { id: user.id },
      data: { email: data.email === undefined ? undefined : data.email || null, pushEnabled: data.pushEnabled },
    });
    await this.audit.log({ action: 'profile.update', entity: 'User', entityId: user.id, before: { email: before.email, pushEnabled: before.pushEnabled }, after: { email: after.email, pushEnabled: after.pushEnabled } }, req);
    return this.me(user);
  }

  async acceptConsent(user: AuthUser, req: Request) {
    await this.prisma.user.update({ where: { id: user.id }, data: { consentAt: new Date(), consentVersion: CONSENT_VERSION } });
    await this.audit.log({ action: 'auth.consent', entity: 'User', entityId: user.id, after: { version: CONSENT_VERSION } }, req);
    return { ok: true };
  }

  sessions(user: AuthUser) {
    return this.prisma.session
      .findMany({
        where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, client: true, deviceName: true, userAgent: true, ip: true, createdAt: true, lastUsedAt: true },
      })
      .then((rows) => rows.map((r) => ({ ...r, current: r.id === user.sessionId })));
  }

  async revokeSession(user: AuthUser, id: string, req: Request) {
    const r = await this.prisma.session.updateMany({ where: { id, userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (!r.count) throw new NotFoundException('Сессия не найдена');
    await this.audit.log({ action: 'auth.session.revoke', entity: 'Session', entityId: id }, req);
  }

  async revokeOthers(user: AuthUser, req: Request) {
    const r = await this.prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null, id: { not: user.sessionId } },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({ action: 'auth.session.revoke_others', after: { count: r.count } }, req);
    return { revoked: r.count };
  }
}
