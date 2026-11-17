import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ChargeType, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { appEvents } from '../common/events';
import { PrismaService } from '../common/prisma.service';
import { mskParts } from '../common/time';
import { FinanceSettingsService } from './finance.settings';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const num = (d: Prisma.Decimal) => d.toDecimalPlaces(2).toNumber();
const DAY = 86400_000;

export type DebtColor = 'GREEN' | 'ORANGE' | 'RED';

export interface Balance {
  electricity: number;
  membership: number;
  penalty: number;
  /** общий долг (без учёта авансов по другим видам) */
  total: number;
  /** аванс (переплата) по всем видам */
  advance: number;
  color: DebtColor;
}

/** Красный: не оплачены обе категории; оранжевый: не оплачено что-то; зелёный: всё оплачено. */
export function colorOf(e: number, m: number, p: number): DebtColor {
  if (e > 0 && m > 0) return 'RED';
  if (e > 0 || m > 0 || p > 0) return 'ORANGE';
  return 'GREEN';
}

/** Период взноса по московскому времени: в ночь на 1 января по UTC ещё прошлый год, а в Москве уже новый */
export function period(date: Date, kind: 'quarter' | 'year'): string {
  const { year, month } = mskParts(date);
  return kind === 'year' ? String(year) : `${year}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** Начало текущего месяца по Москве (UTC+3, без перехода на летнее время) как момент времени */
export function mskMonthStart(now = new Date()): Date {
  const { year, month } = mskParts(now);
  return new Date(Date.UTC(year, month - 1, 1) - 3 * 3600_000);
}

export interface PenaltyInput {
  /** не аннулированные начисления за электроэнергию и взносы, по возрастанию даты; отрицательные — корректировки */
  charges: { garageId: number; type: ChargeType; amount: Prisma.Decimal; createdAt: Date }[];
  /** сумма оплат по ключу `${garageId}:${type}` */
  paid: Map<string, Prisma.Decimal>;
  /** уже начисленная пеня по гаражу */
  penaltySum: Map<number, Prisma.Decimal>;
  lastRun: Date | null;
  now: Date;
  ratePerDayPercent: number;
  graceDays: number;
  capPercent: number;
}

/**
 * Расчёт пени. Просроченные суммы определяем по FIFO: оплаты и корректировки (отрицательные начисления) гасят самые
 * старые начисления того же вида. Корректировку нельзя пропускать: иначе пеня шла бы на уже списанный долг и жителю
 * с нулевым балансом начислялась бы пеня. Пеня идёт за целые дни с последнего запуска (или с конца льготного срока).
 */
export function computePenalties(inp: PenaltyInput): { garageId: number; amount: Prisma.Decimal }[] {
  const credit = new Map(inp.paid);
  const key = (c: { garageId: number; type: ChargeType }) => `${c.garageId}:${c.type}`;
  for (const c of inp.charges) if (c.amount.isNegative()) credit.set(key(c), (credit.get(key(c)) ?? D(0)).plus(c.amount.neg()));

  const overdueByGarage = new Map<number, Prisma.Decimal>();
  const accrual = new Map<number, Prisma.Decimal>();
  for (const c of inp.charges) {
    if (!c.amount.isPositive()) continue;
    const k = key(c);
    const avail = credit.get(k) ?? D(0);
    let open = c.amount;
    if (avail.gt(0)) {
      const used = Prisma.Decimal.min(avail, open);
      open = open.minus(used);
      credit.set(k, avail.minus(used));
    }
    if (open.lte(0)) continue;
    const dueFrom = new Date(c.createdAt.getTime() + inp.graceDays * DAY);
    if (dueFrom > inp.now) continue;
    overdueByGarage.set(c.garageId, (overdueByGarage.get(c.garageId) ?? D(0)).plus(open));
    const from = inp.lastRun && inp.lastRun > dueFrom ? inp.lastRun : dueFrom;
    const days = Math.floor((inp.now.getTime() - from.getTime()) / DAY);
    if (days <= 0) continue;
    accrual.set(c.garageId, (accrual.get(c.garageId) ?? D(0)).plus(open.mul(inp.ratePerDayPercent).div(100).mul(days)));
  }

  const rows: { garageId: number; amount: Prisma.Decimal }[] = [];
  for (const [garageId, raw] of accrual) {
    const cap = (overdueByGarage.get(garageId) ?? D(0)).mul(inp.capPercent).div(100);
    const room = Prisma.Decimal.max(cap.minus(inp.penaltySum.get(garageId) ?? 0), 0);
    const amount = Prisma.Decimal.min(raw, room).toDecimalPlaces(2);
    if (amount.gt(0)) rows.push({ garageId, amount });
  }
  return rows;
}

@Injectable()
export class FinanceService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private settings: FinanceSettingsService,
  ) {}

  // ───────── Балансы ─────────

  /** Баланс = начисления − оплаты (без аннулированных) по каждому виду; положительное = долг. */
  async balances(garageIds?: number[]): Promise<Map<number, Balance>> {
    const where = { voidedAt: null, ...(garageIds ? { garageId: { in: garageIds } } : {}) };
    const [ch, pay] = await Promise.all([
      this.prisma.charge.groupBy({ by: ['garageId', 'type'], where, _sum: { amount: true } }),
      this.prisma.payment.groupBy({ by: ['garageId', 'type'], where, _sum: { amount: true } }),
    ]);
    const acc = new Map<number, Record<ChargeType, Prisma.Decimal>>();
    const slot = (id: number) => {
      if (!acc.has(id)) acc.set(id, { ELECTRICITY: D(0), MEMBERSHIP: D(0), PENALTY: D(0) });
      return acc.get(id)!;
    };
    ch.forEach((r) => (slot(r.garageId)[r.type] = slot(r.garageId)[r.type].plus(r._sum.amount ?? 0)));
    pay.forEach((r) => (slot(r.garageId)[r.type] = slot(r.garageId)[r.type].minus(r._sum.amount ?? 0)));

    const out = new Map<number, Balance>();
    for (const [id, b] of acc) out.set(id, this.toBalance(b));
    if (garageIds) for (const id of garageIds) if (!out.has(id)) out.set(id, this.toBalance({ ELECTRICITY: D(0), MEMBERSHIP: D(0), PENALTY: D(0) }));
    return out;
  }

  private toBalance(b: Record<ChargeType, Prisma.Decimal>): Balance {
    const e = num(b.ELECTRICITY), m = num(b.MEMBERSHIP), p = num(b.PENALTY);
    return {
      electricity: e, membership: m, penalty: p,
      total: Math.round((Math.max(e, 0) + Math.max(m, 0) + Math.max(p, 0)) * 100) / 100,
      advance: Math.round((Math.max(-e, 0) + Math.max(-m, 0) + Math.max(-p, 0)) * 100) / 100,
      color: colorOf(e, m, p),
    };
  }

  /** `phoneSearch: false` — поиск без телефона (сотруднику без права users.view телефоны не раскрываем) */
  async debts(q: { q?: string; color?: DebtColor; page?: number; pageSize?: number; sort?: 'number' | 'debt'; phoneSearch?: boolean }) {
    const page = q.page ?? 1, size = q.pageSize ?? 50;
    const garages = await this.prisma.garage.findMany({
      where: {
        status: 'ACTIVE',
        ...(q.q
          ? {
              OR: [
                { number: { contains: q.q, mode: 'insensitive' } },
                { owners: { some: { toDate: null, user: { fullName: { contains: q.q, mode: 'insensitive' } } } } },
                ...(q.phoneSearch !== false && q.q.replace(/\D/g, '').length >= 3 ? [{ owners: { some: { toDate: null, user: { phone: { contains: q.q.replace(/\D/g, '') } } } } }] : []),
              ],
            }
          : {}),
      },
      include: { owners: { where: { toDate: null }, include: { user: { select: { id: true, fullName: true, phone: true } } } } },
    });
    const bal = await this.balances();
    const empty = this.toBalance({ ELECTRICITY: D(0), MEMBERSHIP: D(0), PENALTY: D(0) });
    let rows = garages.map((g) => ({
      garageId: g.id, number: g.number, hasBenefit: g.hasBenefit, benefitPercent: g.benefitPercent,
      owners: g.owners.map((o) => o.user),
      ...(bal.get(g.id) ?? empty),
    }));
    if (q.color) rows = rows.filter((r) => r.color === q.color);
    rows.sort(q.sort === 'debt'
      ? (a, b) => b.total - a.total
      : (a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }));
    return { total: rows.length, page, pageSize: size, items: rows.slice((page - 1) * size, page * size) };
  }

  async summary() {
    const [garages, bal] = await Promise.all([
      this.prisma.garage.findMany({ where: { status: 'ACTIVE' }, select: { id: true } }),
      this.balances(),
    ]);
    const s = { electricity: 0, membership: 0, penalty: 0, red: 0, orange: 0, green: 0, garages: garages.length };
    for (const g of garages) {
      const b = bal.get(g.id);
      if (!b) { s.green++; continue; }
      s.electricity += Math.max(b.electricity, 0);
      s.membership += Math.max(b.membership, 0);
      s.penalty += Math.max(b.penalty, 0);
      s[b.color.toLowerCase() as 'red' | 'orange' | 'green']++;
    }
    const monthStart = mskMonthStart();
    const paid = await this.prisma.payment.aggregate({ where: { voidedAt: null, paidAt: { gte: monthStart } }, _sum: { amount: true } });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      ...s, electricity: r2(s.electricity), membership: r2(s.membership), penalty: r2(s.penalty),
      totalDebt: r2(s.electricity + s.membership + s.penalty),
      paidThisMonth: num(D(paid._sum.amount ?? 0)),
    };
  }

  async ledger(garageId: number) {
    const g = await this.prisma.garage.findUnique({ where: { id: garageId } });
    if (!g) throw new NotFoundException('Гараж не найден');
    const [charges, payments, bal] = await Promise.all([
      this.prisma.charge.findMany({ where: { garageId }, orderBy: { createdAt: 'desc' } }),
      this.prisma.payment.findMany({ where: { garageId }, orderBy: { paidAt: 'desc' } }),
      this.balances([garageId]),
    ]);
    return { balance: bal.get(garageId), charges, payments };
  }

  /** Долг жителя по его текущим гаражам */
  async myDebt(userId: number) {
    const owns = await this.prisma.garageOwner.findMany({ where: { userId, toDate: null }, include: { garage: true } });
    const bal = await this.balances(owns.map((o) => o.garageId));
    const garages = owns.map((o) => ({ garageId: o.garageId, number: o.garage.number, ...bal.get(o.garageId)! }));
    return { total: Math.round(garages.reduce((s, g) => s + g.total, 0) * 100) / 100, garages };
  }

  // ───────── Начисления ─────────

  private async requireGarage(id: number) {
    const g = await this.prisma.garage.findUnique({ where: { id } });
    if (!g) throw new NotFoundException('Гараж не найден');
    if (g.status === 'ARCHIVED') throw new BadRequestException('Гараж в архиве');
    return g;
  }

  async createCharge(
    dto: { garageId: number; type: ChargeType; amount: number; period?: string; description?: string },
    userId: number, req: Request,
  ) {
    await this.requireGarage(dto.garageId);
    if (dto.amount === 0) throw new BadRequestException('Сумма не может быть нулевой');
    const c = await this.prisma.charge.create({
      data: { garageId: dto.garageId, type: dto.type, amount: D(dto.amount), period: dto.period, description: dto.description, createdById: userId },
    });
    await this.audit.log({ action: 'charge.create', entity: 'Charge', entityId: c.id, after: c }, req);
    return c;
  }

  /** Один процесс за раз: два одновременных запуска (двойной клик, два бухгалтера) не создадут дубликаты начислений */
  private withLock<T>(key: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${key})`;
      return fn(tx);
    }, { timeout: 120_000, maxWait: 30_000 });
  }

  /** Массовое начисление членского взноса всем активным гаражам с учётом льготы. */
  bulkMembership(dto: { period?: string; amount?: number; dryRun?: boolean }, userId: number, req: Request) {
    return this.withLock(7001, (tx) => this.bulkMembershipLocked(tx, dto, userId, req));
  }

  private async bulkMembershipLocked(tx: Prisma.TransactionClient, dto: { period?: string; amount?: number; dryRun?: boolean }, userId: number, req: Request) {
    const s = await this.settings.get();
    const per = dto.period ?? period(new Date(), s.membershipPeriod);
    const fee = dto.amount ?? s.membershipFee;
    if (!(fee > 0)) throw new BadRequestException('Не задан размер членского взноса (настройки финансов)');

    const [garages, existing] = await Promise.all([
      tx.garage.findMany({ where: { status: 'ACTIVE' } }),
      tx.charge.findMany({ where: { type: 'MEMBERSHIP', period: per, voidedAt: null }, select: { garageId: true } }),
    ]);
    const done = new Set(existing.map((e) => e.garageId));
    const data = garages
      .filter((g) => !done.has(g.id))
      .map((g) => {
        const pct = g.hasBenefit ? g.benefitPercent : 0;
        const amount = D(fee).mul(D(100 - pct)).div(100).toDecimalPlaces(2);
        return { garageId: g.id, type: 'MEMBERSHIP' as const, period: per, amount, createdById: userId,
          description: pct ? `Членский взнос ${per}, льгота ${pct}%` : `Членский взнос ${per}` };
      })
      .filter((d) => d.amount.gt(0));
    const result = { period: per, fee, willCreate: data.length, alreadyHad: done.size, total: num(data.reduce((s2, d) => s2.plus(d.amount), D(0))) };
    if (dto.dryRun) return { ...result, dryRun: true };
    await tx.charge.createMany({ data });
    await this.audit.log({ action: 'charge.bulk_membership', entity: 'Charge', after: result }, req);
    return result;
  }

  async voidCharge(id: number, userId: number, req: Request) {
    const c = await this.prisma.charge.findUnique({ where: { id } });
    if (!c) throw new NotFoundException();
    if (c.voidedAt) throw new BadRequestException('Уже аннулировано');
    const after = await this.prisma.charge.update({ where: { id }, data: { voidedAt: new Date(), voidedById: userId } });
    await this.audit.log({ action: 'charge.void', entity: 'Charge', entityId: id, before: c, after }, req);
  }

  // ───────── Оплаты ─────────

  async createPayment(
    dto: { garageId: number; type: ChargeType; amount: number; paidAt?: string; method?: string; comment?: string },
    userId: number, req: Request,
  ) {
    await this.requireGarage(dto.garageId);
    if (!(dto.amount > 0)) throw new BadRequestException('Сумма должна быть больше нуля');
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + DAY) throw new BadRequestException('Дата оплаты в будущем');
    if (paidAt.getTime() < Date.now() - 5 * 365 * DAY) throw new BadRequestException('Дата оплаты слишком старая');
    const p = await this.prisma.payment.create({
      data: {
        garageId: dto.garageId, type: dto.type, amount: D(dto.amount),
        paidAt,
        method: dto.method ?? 'cash', comment: dto.comment, receivedById: userId,
      },
    });
    await this.audit.log({ action: 'payment.create', entity: 'Payment', entityId: p.id, after: p }, req);
    appEvents.emit('payment.created', { paymentId: p.id, garageId: p.garageId, actorId: userId });
    return p;
  }

  async voidPayment(id: number, userId: number, req: Request) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw new NotFoundException();
    if (p.voidedAt) throw new BadRequestException('Уже аннулировано');
    const after = await this.prisma.payment.update({ where: { id }, data: { voidedAt: new Date(), voidedById: userId } });
    await this.audit.log({ action: 'payment.void', entity: 'Payment', entityId: id, before: p, after }, req);
  }

  // ───────── Электроэнергия по показаниям ─────────

  /**
   * Расчёт начисления: (новое − предыдущее принятое) × тариф.
   * Нет предыдущего принятого показания → точка отсчёта, начисление 0.
   */
  async electricityCalc(garageId: number, value: number, excludeReadingId?: number) {
    const s = await this.settings.get();
    const prev = await this.prisma.meterReading.findFirst({
      where: { garageId, status: 'ACCEPTED', ...(excludeReadingId ? { NOT: { id: excludeReadingId } } : {}) },
      orderBy: [{ takenAt: 'desc' }, { id: 'desc' }],
    });
    if (!prev) return { previous: null as number | null, consumption: 0, price: s.kwhPrice, amount: 0, baseline: true };
    const consumption = D(value).minus(prev.value);
    if (consumption.isNegative()) {
      throw new BadRequestException(`Показание меньше предыдущего (${prev.value}). Проверьте значение или начислите вручную (замена счётчика).`);
    }
    return {
      previous: prev.value.toNumber(),
      consumption: num(consumption),
      price: s.kwhPrice,
      amount: num(consumption.mul(s.kwhPrice)),
      baseline: false,
    };
  }

  // ───────── Пеня ─────────

  /**
   * Начисление пени (расчёт — computePenalties: оплаты и корректировки гасят самые старые начисления).
   * Пеня идёт за целые дни с последнего запуска (или с конца льготного срока начисления).
   */
  runPenalties(dto: { dryRun?: boolean }, userId: number, req: Request) {
    return this.withLock(7002, (tx) => this.runPenaltiesLocked(tx, dto, userId, req));
  }

  private async runPenaltiesLocked(tx: Prisma.TransactionClient, dto: { dryRun?: boolean }, userId: number, req: Request) {
    const s = await this.settings.get();
    if (!s.penalty.enabled) throw new BadRequestException('Пеня выключена в настройках');
    const now = new Date();
    const lastRow = await tx.setting.findUnique({ where: { key: 'penaltyLastRun' } });
    const lastRun = lastRow ? new Date(lastRow.value as string) : null;

    const types: ChargeType[] = ['ELECTRICITY', 'MEMBERSHIP'];
    const [charges, payments, penalties] = await Promise.all([
      tx.charge.findMany({ where: { voidedAt: null, type: { in: types } }, orderBy: { createdAt: 'asc' } }),
      tx.payment.groupBy({ by: ['garageId', 'type'], where: { voidedAt: null, type: { in: types } }, _sum: { amount: true } }),
      tx.charge.groupBy({ by: ['garageId'], where: { voidedAt: null, type: 'PENALTY' }, _sum: { amount: true } }),
    ]);
    const paid = new Map(payments.map((p) => [`${p.garageId}:${p.type}`, D(p._sum.amount ?? 0)]));
    const penaltySum = new Map(penalties.map((p) => [p.garageId, D(p._sum.amount ?? 0)]));
    const rows = computePenalties({
      charges, paid, penaltySum, lastRun, now,
      ratePerDayPercent: s.penalty.ratePerDayPercent, graceDays: s.penalty.graceDays, capPercent: s.penalty.capPercent,
    });
    const result = { garages: rows.length, total: num(rows.reduce((a, r) => a.plus(r.amount), D(0))), runAt: now };
    if (dto.dryRun) return { ...result, dryRun: true };

    const m = mskParts(now);
    const label = `Пеня до ${m.year}-${String(m.month).padStart(2, '0')}-${String(m.day).padStart(2, '0')}`;
    await tx.charge.createMany({
      data: rows.map((r) => ({ garageId: r.garageId, type: 'PENALTY' as const, amount: r.amount, description: label, createdById: userId })),
    });
    await tx.setting.upsert({ where: { key: 'penaltyLastRun' }, update: { value: now.toISOString() }, create: { key: 'penaltyLastRun', value: now.toISOString() } });
    await this.audit.log({ action: 'charge.penalties_run', entity: 'Charge', after: result }, req);
    return result;
  }
}
