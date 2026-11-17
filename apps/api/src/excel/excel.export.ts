import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { PrismaService } from '../common/prisma.service';
import { FinanceService } from '../finance/finance.service';
import { mskDate, styleHeader } from './excel.io';

const TYPE_LABEL: Record<string, string> = { ELECTRICITY: 'Электроэнергия', MEMBERSHIP: 'Членские взносы', PENALTY: 'Пеня' };
const METHOD_LABEL: Record<string, string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };
const COLOR_LABEL: Record<string, string> = { GREEN: 'Оплачено', ORANGE: 'Есть долг', RED: 'Долг по всем видам' };
const COLOR_FILL: Record<string, string> = { GREEN: 'FFCDEFE2', ORANGE: 'FFFBEBC4', RED: 'FFFFD0D0' };
const MONEY = '#,##0.00';
const DT = 'dd.mm.yyyy hh:mm';

const naturalSort = (a: string, b: string) => a.localeCompare(b, 'ru', { numeric: true });
const phoneFmt = (p: string) => `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6, 8)}-${p.slice(8, 10)}`;

interface Col { header: string; key: string; width: number; fmt?: string }

/** Границы периода по МСК: «с» включительно с 00:00, «по» включительно до 23:59:59 */
function range(from?: string, to?: string) {
  const f = from ? new Date(`${from}T00:00:00+03:00`) : undefined;
  const t = to ? new Date(`${to}T23:59:59.999+03:00`) : undefined;
  if ((from && isNaN(+f!)) || (to && isNaN(+t!))) throw new BadRequestException('Дата в формате ГГГГ-ММ-ДД');
  return { gte: f, lte: t };
}

@Injectable()
export class ExcelExportService {
  constructor(private prisma: PrismaService, private finance: FinanceService) {}

  private sheet(wb: ExcelJS.Workbook, name: string, cols: Col[], rows: Record<string, any>[]) {
    const ws = wb.addWorksheet(name);
    ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width, style: c.fmt ? { numFmt: c.fmt } : undefined }));
    rows.forEach((r) => ws.addRow(r));
    styleHeader(ws);
    return ws;
  }

  private wb() {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ГСК «Родник»';
    wb.created = new Date();
    return wb;
  }

  private async out(wb: ExcelJS.Workbook) {
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  async users() {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null }, orderBy: { id: 'asc' },
      include: { role: { select: { name: true } }, garages: { where: { toDate: null }, include: { garage: { select: { number: true } } } } },
    });
    const wb = this.wb();
    this.sheet(wb, 'Пользователи', [
      { header: 'ФИО', key: 'fio', width: 32 }, { header: 'Телефон', key: 'phone', width: 16 }, { header: 'Email', key: 'email', width: 30 },
      { header: 'Гаражи', key: 'garages', width: 20 }, { header: 'Роль', key: 'role', width: 18 }, { header: 'Статус', key: 'status', width: 16 },
      { header: 'Согласие на ПДн', key: 'consent', width: 18, fmt: DT }, { header: 'Последний вход (МСК)', key: 'login', width: 20, fmt: DT },
      { header: 'Создан (МСК)', key: 'created', width: 20, fmt: DT }, { header: 'Заметка', key: 'note', width: 30 },
    ], users.map((u) => ({
      fio: u.fullName ?? '', phone: phoneFmt(u.phone), email: u.email ?? '',
      garages: u.garages.map((g) => g.garage.number).sort(naturalSort).join(', '), role: u.role.name,
      status: u.isBlocked || u.lockedAt ? 'Заблокирован' : 'Активен', consent: mskDate(u.consentAt), login: mskDate(u.lastLoginAt), created: mskDate(u.createdAt), note: u.note ?? '',
    })));
    return this.out(wb);
  }

  async garages(status: 'ACTIVE' | 'ARCHIVED' | 'ALL' = 'ACTIVE') {
    const garages = await this.prisma.garage.findMany({
      where: status === 'ALL' ? {} : { status },
      include: { owners: { where: { toDate: null }, include: { user: { select: { fullName: true, phone: true, email: true } } } } },
    });
    garages.sort((a, b) => naturalSort(a.number, b.number));
    const wb = this.wb();
    this.sheet(wb, 'Гаражи', [
      { header: 'Гараж', key: 'n', width: 10 }, { header: 'Статус', key: 'st', width: 12 }, { header: 'Владельцы', key: 'own', width: 38 },
      { header: 'Телефоны', key: 'ph', width: 28 }, { header: 'Email', key: 'em', width: 32 }, { header: 'Площадь, м²', key: 'area', width: 13, fmt: '0.0' },
      { header: 'Год постройки', key: 'year', width: 14 }, { header: 'Льгота, %', key: 'ben', width: 11 }, { header: 'Заметки', key: 'notes', width: 34 },
    ], garages.map((g) => ({
      n: /^\d+$/.test(g.number) ? Number(g.number) : g.number, st: g.status === 'ACTIVE' ? 'Действует' : 'Архив',
      own: g.owners.map((o) => o.user.fullName ?? '—').join('; '), ph: g.owners.map((o) => phoneFmt(o.user.phone)).join('; '),
      em: g.owners.map((o) => o.user.email ?? '').filter(Boolean).join('; '), area: g.areaM2?.toNumber() ?? null, year: g.buildYear ?? null,
      ben: g.hasBenefit ? g.benefitPercent : null, notes: g.notes ?? '',
    })));
    return this.out(wb);
  }

  async debts() {
    const d = await this.finance.debts({ pageSize: 1000, sort: 'number' });
    const wb = this.wb();
    const ws = this.sheet(wb, 'Долги', [
      { header: 'Гараж', key: 'n', width: 10 }, { header: 'Владельцы', key: 'own', width: 36 }, { header: 'Телефоны', key: 'ph', width: 28 },
      { header: 'Электроэнергия, руб.', key: 'e', width: 18, fmt: MONEY }, { header: 'Членские взносы, руб.', key: 'm', width: 19, fmt: MONEY },
      { header: 'Пеня, руб.', key: 'p', width: 13, fmt: MONEY }, { header: 'К оплате, руб.', key: 't', width: 16, fmt: MONEY },
      { header: 'Аванс, руб.', key: 'a', width: 13, fmt: MONEY }, { header: 'Статус', key: 's', width: 20 }, { header: 'Льгота', key: 'b', width: 10 },
    ], d.items.map((r: any) => ({
      n: /^\d+$/.test(r.number) ? Number(r.number) : r.number, own: r.owners.map((o: any) => o.fullName ?? '—').join('; '), ph: r.owners.map((o: any) => phoneFmt(o.phone)).join('; '),
      e: r.electricity, m: r.membership, p: r.penalty, t: r.total, a: r.advance, s: COLOR_LABEL[r.color], b: r.hasBenefit ? `${r.benefitPercent}%` : '',
    })));
    // цвет статуса — как на портале
    d.items.forEach((r: any, i: number) => {
      ws.getCell(i + 2, 9).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_FILL[r.color] } };
    });
    const last = d.items.length + 1;
    const total = ws.addRow({ n: 'ИТОГО', e: { formula: `SUM(D2:D${last})` }, m: { formula: `SUM(E2:E${last})` }, p: { formula: `SUM(F2:F${last})` }, t: { formula: `SUM(G2:G${last})` }, a: { formula: `SUM(H2:H${last})` } });
    total.font = { bold: true };
    total.border = { top: { style: 'thin' } };
    return this.out(wb);
  }

  async charges(from?: string, to?: string) {
    const rows = await this.prisma.charge.findMany({
      where: { createdAt: range(from, to) }, orderBy: { id: 'asc' }, include: { garage: { select: { number: true } } },
    });
    const users = await this.names(rows.map((r) => r.createdById));
    const wb = this.wb();
    this.sheet(wb, 'Начисления', [
      { header: 'Дата (МСК)', key: 'd', width: 18, fmt: DT }, { header: 'Гараж', key: 'g', width: 10 }, { header: 'Вид', key: 't', width: 18 },
      { header: 'Период', key: 'p', width: 12 }, { header: 'Сумма, руб.', key: 'a', width: 14, fmt: MONEY }, { header: 'Описание', key: 'ds', width: 46 },
      { header: 'Начислил', key: 'by', width: 22 }, { header: 'Аннулировано', key: 'v', width: 18, fmt: DT },
    ], rows.map((r) => ({
      d: mskDate(r.createdAt), g: /^\d+$/.test(r.garage.number) ? Number(r.garage.number) : r.garage.number, t: TYPE_LABEL[r.type], p: r.period ?? '',
      a: r.amount.toNumber(), ds: r.description ?? '', by: users.get(r.createdById) ?? '', v: mskDate(r.voidedAt),
    })));
    return this.out(wb);
  }

  async payments(from?: string, to?: string) {
    const rows = await this.prisma.payment.findMany({
      where: { paidAt: range(from, to) }, orderBy: { paidAt: 'asc' }, include: { garage: { select: { number: true } } },
    });
    const users = await this.names(rows.map((r) => r.receivedById));
    const wb = this.wb();
    this.sheet(wb, 'Оплаты', [
      { header: '№', key: 'id', width: 8 }, { header: 'Дата (МСК)', key: 'd', width: 18, fmt: DT }, { header: 'Гараж', key: 'g', width: 10 },
      { header: 'Вид', key: 't', width: 18 }, { header: 'Сумма, руб.', key: 'a', width: 14, fmt: MONEY }, { header: 'Способ', key: 'm', width: 14 },
      { header: 'Комментарий', key: 'c', width: 34 }, { header: 'Принял', key: 'by', width: 22 }, { header: 'Аннулировано', key: 'v', width: 18, fmt: DT },
    ], rows.map((r) => ({
      id: r.id, d: mskDate(r.paidAt), g: /^\d+$/.test(r.garage.number) ? Number(r.garage.number) : r.garage.number, t: TYPE_LABEL[r.type], a: r.amount.toNumber(),
      m: METHOD_LABEL[r.method] ?? r.method, c: r.comment ?? '', by: users.get(r.receivedById) ?? '', v: mskDate(r.voidedAt),
    })));
    return this.out(wb);
  }

  private async names(ids: number[]) {
    const u = await this.prisma.user.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, fullName: true, phone: true } });
    return new Map(u.map((x) => [x.id, x.fullName ?? x.phone]));
  }
}
