import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { assertCanManage } from '../common/hierarchy';
import { PrismaService } from '../common/prisma.service';
import {
  decryptSecret, encryptSecret, generateBackupCodes, hashBackupCode, looksLikeBackupCode, newTotpSecret,
  otpauthUrl, verifyTotp,
} from './totp';

/** Политика безопасности: обязательна ли 2FA для сотрудников портала (по умолчанию — да) */
@Injectable()
export class SecurityPolicyService {
  private cache: { at: number; require2fa: boolean } | null = null;

  constructor(private prisma: PrismaService) {}

  async require2fa(): Promise<boolean> {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache.require2fa;
    const row = await this.prisma.setting.findUnique({ where: { key: 'security' } });
    const v = (row?.value as { require2fa?: boolean } | null)?.require2fa;
    const require2fa = v === undefined ? true : !!v;
    this.cache = { at: Date.now(), require2fa };
    return require2fa;
  }

  async set(require2fa: boolean) {
    await this.prisma.setting.upsert({ where: { key: 'security' }, update: { value: { require2fa } }, create: { key: 'security', value: { require2fa } } });
    this.cache = null;
  }
}

export type CodeKind = 'totp' | 'backup';

@Injectable()
export class TwoFactorService {
  constructor(private prisma: PrismaService, private audit: AuditService, private policy: SecurityPolicyService) {}

  async status(userId: number) {
    const [u, left, required] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: true } }),
      this.prisma.backupCode.count({ where: { userId, usedAt: null } }),
      this.policy.require2fa(),
    ]);
    const enabled = u.totpEnabled;
    return {
      enabled,
      /** политика требует 2FA от сотрудников портала */
      required: required && u.role.portalAccess,
      setupRequired: required && u.role.portalAccess && !enabled,
      backupCodesLeft: enabled ? left : 0,
    };
  }

  /** Начало настройки: новый секрет (хранится зашифрованным, пока не подтверждён кодом) */
  async setup(user: AuthUser, req: Request) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (u.totpEnabled) throw new ConflictException('Двухфакторная защита уже включена');
    const secret = newTotpSecret();
    await this.prisma.user.update({ where: { id: u.id }, data: { totpSecret: encryptSecret(secret), totpLastStep: null } });
    await this.audit.log({ action: 'auth.2fa.setup_start' }, req);
    return { secret, otpauthUrl: otpauthUrl(secret, `+7${u.phone}`) };
  }

  /** Подтверждение первым кодом: включает 2FA и выдаёт резервные коды (показываются один раз) */
  async enable(user: AuthUser, code: string, req: Request) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (u.totpEnabled) throw new ConflictException('Двухфакторная защита уже включена');
    if (!u.totpSecret) throw new BadRequestException('Сначала начните настройку');
    const step = verifyTotp(decryptSecret(u.totpSecret), code.trim(), null);
    if (step === null) throw new BadRequestException('Неверный код. Проверьте время на телефоне и попробуйте ещё раз');
    const codes = generateBackupCodes(10);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: u.id }, data: { totpEnabled: true, totpLastStep: step } }),
      this.prisma.backupCode.deleteMany({ where: { userId: u.id } }),
      this.prisma.backupCode.createMany({ data: codes.map((c) => ({ userId: u.id, codeHash: hashBackupCode(c) })) }),
      // Остальные сессии открыты без второго фактора (например, тем, кто знал пароль до настройки) — завершаем их
      this.prisma.session.updateMany({ where: { userId: u.id, revokedAt: null, id: { not: user.sessionId } }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ action: 'auth.2fa.enable' }, req);
    return { backupCodes: codes };
  }

  /**
   * Проверка кода пользователя (вход, отключение, перевыпуск). Резервный код действует один раз.
   * `totpOnly` — принимать только код из приложения (для управления защитой).
   */
  async verifyCode(userId: number, code: string, opts: { totpOnly?: boolean } = {}): Promise<CodeKind | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u?.totpEnabled || !u.totpSecret) return null;
    const c = code.trim();

    if (!opts.totpOnly && !/^\d{6}$/.test(c) && looksLikeBackupCode(c)) {
      const hash = hashBackupCode(c);
      const row = await this.prisma.backupCode.findFirst({ where: { userId, codeHash: hash, usedAt: null } });
      if (!row) return null;
      // атомарно: код гасится ровно одним запросом
      const r = await this.prisma.backupCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
      return r.count === 1 ? 'backup' : null;
    }

    const step = verifyTotp(decryptSecret(u.totpSecret), c, u.totpLastStep);
    if (step === null) return null;
    // защита от повтора: шаг принимается только если он новее последнего принятого
    const r = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return r.count === 1 ? 'totp' : null;
  }

  async disable(user: AuthUser, code: string, req: Request) {
    if (await this.policy.require2fa()) {
      if (user.portalAccess) throw new ForbiddenException('Отключить 2FA нельзя: она обязательна для сотрудников правления. Обратитесь к председателю');
    }
    if ((await this.verifyCode(user.id, code, { totpOnly: true })) !== 'totp') throw new BadRequestException('Неверный код');
    await this.wipe(user.id);
    await this.audit.log({ action: 'auth.2fa.disable' }, req);
  }

  async regenerateBackupCodes(user: AuthUser, code: string, req: Request) {
    if ((await this.verifyCode(user.id, code, { totpOnly: true })) !== 'totp') throw new BadRequestException('Неверный код');
    const codes = generateBackupCodes(10);
    await this.prisma.$transaction([
      this.prisma.backupCode.deleteMany({ where: { userId: user.id } }),
      this.prisma.backupCode.createMany({ data: codes.map((c) => ({ userId: user.id, codeHash: hashBackupCode(c) })) }),
    ]);
    await this.audit.log({ action: 'auth.2fa.backup_codes_regenerated' }, req);
    return { backupCodes: codes };
  }

  /** Сброс администратором (потерян телефон): очищает 2FA и завершает все сессии пользователя */
  async reset(userId: number, actor: AuthUser, req: Request) {
    await assertCanManage(this.prisma, actor, userId);
    await this.wipe(userId);
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: 'user.2fa.reset', entity: 'User', entityId: userId }, req);
  }

  private async wipe(userId: number) {
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { totpEnabled: false, totpSecret: null, totpLastStep: null } }),
      this.prisma.backupCode.deleteMany({ where: { userId } }),
    ]);
  }
}
