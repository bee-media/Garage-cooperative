import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import * as webpush from 'web-push';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../common/prisma.service';
import { isPushServiceUrl } from '../common/push-url';
import { mskParts } from '../common/time';
import { FinanceService } from '../finance/finance.service';

const MAX_DEVICES = 10;

export interface PushMessage {
  title: string;
  body: string;
  /** Куда перейти при нажатии, например /news/5 */
  url?: string;
  tag?: string;
}

export interface PushSettings {
  /** День месяца (MSK), начиная с которого шлём напоминание должникам */
  debtReminderDay: number;
  /** Окно отправки, час MSK: [from, to) */
  windowFromHour: number;
  windowToHour: number;
}

export const DEFAULT_PUSH: PushSettings = { debtReminderDay: 10, windowFromHour: 9, windowToHour: 18 };

const rub = (n: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n) + ' ₽';

@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Push');
  private fcm: any = null;
  private webEnabled = false;
  private dryRun = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private prisma: PrismaService,
    private cfg: ConfigService,
    private audit: AuditService,
    private finance: FinanceService,
  ) {}

  async onModuleInit() {
    this.dryRun = this.cfg.get('PUSH_DRY_RUN') === '1';

    const pub = this.cfg.get<string>('VAPID_PUBLIC_KEY'), priv = this.cfg.get<string>('VAPID_PRIVATE_KEY');
    if (pub && priv) {
      webpush.setVapidDetails(this.cfg.get('VAPID_SUBJECT') ?? 'mailto:admin@example.ru', pub, priv);
      this.webEnabled = true;
    }

    const file = this.cfg.get<string>('FCM_SERVICE_ACCOUNT_FILE');
    if (file) {
      try {
        const { initializeApp, cert } = await import('firebase-admin/app');
        const { getMessaging } = await import('firebase-admin/messaging');
        const app = initializeApp({ credential: cert(JSON.parse(readFileSync(file, 'utf8'))) });
        this.fcm = getMessaging(app);
      } catch (e) {
        this.log.error(`FCM не инициализирован: ${(e as Error).message}`);
      }
    }
    this.log.log(`Push: webpush=${this.webEnabled} fcm=${!!this.fcm} dryRun=${this.dryRun}`);

    // Напоминания должникам: проверка раз в 15 минут
    this.timer = setInterval(() => void this.runDebtReminders({}).catch((e) => this.log.error(e)), 15 * 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  config() {
    return {
      webPushPublicKey: this.webEnabled ? this.cfg.get<string>('VAPID_PUBLIC_KEY') : null,
      fcmEnabled: !!this.fcm,
      dryRun: this.dryRun,
    };
  }

  async settings(): Promise<PushSettings> {
    const s = await this.prisma.setting.findUnique({ where: { key: 'push' } });
    return { ...DEFAULT_PUSH, ...((s?.value as Partial<PushSettings>) ?? {}) };
  }

  async setSettings(s: PushSettings) {
    await this.prisma.setting.upsert({ where: { key: 'push' }, update: { value: s as any }, create: { key: 'push', value: s as any } });
  }

  // ───────── устройства ─────────

  async registerDevice(userId: number, platform: 'fcm' | 'webpush', token: string) {
    // токен принадлежит одному пользователю: при смене аккаунта на телефоне перепривязываем
    await this.prisma.pushDevice.upsert({
      where: { token }, update: { userId, platform }, create: { userId, platform, token },
    });
    // не больше MAX_DEVICES устройств на пользователя: старые удаляются (защита от забивания таблицы)
    const mine = await this.prisma.pushDevice.findMany({ where: { userId }, orderBy: { id: 'desc' }, select: { id: true } });
    if (mine.length > MAX_DEVICES) await this.prisma.pushDevice.deleteMany({ where: { id: { in: mine.slice(MAX_DEVICES).map((d) => d.id) } } });
  }

  async unregisterDevice(userId: number, token: string) {
    await this.prisma.pushDevice.deleteMany({ where: { userId, token } });
  }

  // ───────── отправка ─────────

  /** Вся отправка идёт только пользователям с включённым push и активной учётной записью. */
  async sendToUsers(userIds: number[] | 'all', msg: PushMessage): Promise<{ devices: number; sent: number }> {
    const devices = await this.prisma.pushDevice.findMany({
      where: {
        user: { deletedAt: null, isBlocked: false, lockedAt: null, pushEnabled: true },
        ...(userIds === 'all' ? {} : { userId: { in: userIds } }),
      },
    });
    if (!devices.length) return { devices: 0, sent: 0 };

    if (this.dryRun) {
      this.log.log(`[DRY-RUN] "${msg.title}" / "${msg.body}" → ${devices.length} устройств (пользователей: ${new Set(devices.map((d) => d.userId)).size})`);
      return { devices: devices.length, sent: devices.length };
    }

    const dead: string[] = [];
    let sent = 0;

    const fcmDevices = devices.filter((d) => d.platform === 'fcm');
    if (fcmDevices.length && this.fcm) {
      for (let i = 0; i < fcmDevices.length; i += 500) {
        const chunk = fcmDevices.slice(i, i + 500);
        const res = await this.fcm.sendEach(
          chunk.map((d) => ({
            token: d.token,
            notification: { title: msg.title, body: msg.body },
            data: { url: msg.url ?? '/', ...(msg.tag ? { tag: msg.tag } : {}) },
            android: { priority: 'high', notification: { channelId: 'gsk' } },
          })),
        );
        res.responses.forEach((r: any, idx: number) => {
          if (r.success) sent++;
          else if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)) dead.push(chunk[idx].token);
          else this.log.warn(`FCM: ${r.error?.code}`);
        });
      }
    }

    const webDevices = devices.filter((d) => d.platform === 'webpush');
    if (webDevices.length && this.webEnabled) {
      const payload = JSON.stringify({ title: msg.title, body: msg.body, url: msg.url ?? '/', tag: msg.tag });
      for (let i = 0; i < webDevices.length; i += 20) {
        await Promise.all(
          webDevices.slice(i, i + 20).map(async (d) => {
            try {
              const sub = JSON.parse(d.token);
              // подписки, сохранённые до введения проверки адреса, тоже не должны вести во внутреннюю сеть
              if (!isPushServiceUrl(sub?.endpoint)) { dead.push(d.token); return; }
              await webpush.sendNotification(sub, payload, { TTL: 86400 });
              sent++;
            } catch (e: any) {
              if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(d.token);
              else this.log.warn(`WebPush: ${e?.statusCode ?? e?.message}`);
            }
          }),
        );
      }
    }

    if (dead.length) await this.prisma.pushDevice.deleteMany({ where: { token: { in: dead } } });
    return { devices: devices.length, sent };
  }

  /** Тихая обёртка для вызова из бизнес-логики: ошибка push не должна ломать запрос. */
  notify(userIds: number[] | 'all', msg: PushMessage) {
    void this.sendToUsers(userIds, msg).catch((e) => this.log.error(`notify: ${e?.message}`));
  }

  // ───────── напоминание должникам ─────────

  /**
   * Раз в календарный месяц (MSK) каждому должнику с включённым push.
   * Запускается по таймеру; отправка только в окне часов (по умолчанию 9:00–18:00 MSK, без выходных).
   * `force` игнорирует окно и день месяца (ручной запуск бухгалтером).
   */
  async runDebtReminders(opts: { dryRun?: boolean; force?: boolean }) {
    const s = await this.settings();
    const now = mskParts();
    if (!opts.force) {
      if (now.hour < s.windowFromHour || now.hour >= s.windowToHour) return { skipped: 'вне окна отправки', candidates: 0, sent: 0 };
      if (now.day < s.debtReminderDay) return { skipped: 'ещё не наступил день напоминания', candidates: 0, sent: 0 };
    }

    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null, isBlocked: false, lockedAt: null, pushEnabled: true,
        pushDevices: { some: {} }, garages: { some: { toDate: null } },
      },
      select: { id: true, lastDebtReminderAt: true, garages: { where: { toDate: null }, select: { garageId: true, garage: { select: { number: true } } } } },
    });
    const due = users.filter((u) => !u.lastDebtReminderAt || mskParts(u.lastDebtReminderAt).ym !== now.ym);
    if (!due.length) return { candidates: 0, sent: 0 };

    const bal = await this.finance.balances(due.flatMap((u) => u.garages.map((g) => g.garageId)));
    const targets = due
      .map((u) => {
        const debts = u.garages
          .map((g) => ({ number: g.garage.number, total: bal.get(g.garageId)?.total ?? 0 }))
          .filter((g) => g.total > 0);
        return { id: u.id, debts, sum: Math.round(debts.reduce((a, g) => a + g.total, 0) * 100) / 100 };
      })
      .filter((t) => t.sum > 0);

    if (opts.dryRun) return { dryRun: true, candidates: targets.length, sent: 0 };

    let sent = 0;
    for (const t of targets) {
      const where = t.debts.length === 1 ? `гараж №${t.debts[0].number}` : `гаражи №${t.debts.map((g) => g.number).join(', ')}`;
      const r = await this.sendToUsers([t.id], {
        title: 'Задолженность по ГСК «Родник»',
        body: `${where}: ${rub(t.sum)}. Оплатить можно в правлении.`,
        url: '/profile', tag: 'debt',
      });
      // отмечаем, даже если устройство уже невалидно: следующая попытка будет в новом месяце
      await this.prisma.user.update({ where: { id: t.id }, data: { lastDebtReminderAt: new Date() } });
      sent += r.sent ? 1 : 0;
    }
    await this.audit.log({ action: 'push.debt_reminders', after: { candidates: targets.length, sent, forced: !!opts.force }, actor: null });
    return { candidates: targets.length, sent };
  }
}
