import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as ExcelJS from 'exceljs';
import { generatePassword, hashPassword } from '../common/password';
import { PrismaService } from '../common/prisma.service';
import { Cell, ColumnSpec, garageNo, norm, num, parseDate, phoneLenient, readSheet, styleHeader, text } from './excel.io';

export type ImportKind = 'garages' | 'charges' | 'payments';
export const IMPORT_KINDS: ImportKind[] = ['garages', 'charges', 'payments'];

const NUMBER_RE = /^[0-9A-Za-zА-Яа-я\-/]{1,12}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SPECS: Record<ImportKind, ColumnSpec[]> = {
  garages: [
    { key: 'garage', title: 'Гараж', titles: ['номер гаража', '№ гаража', 'номер', 'бокс', 'гараж №'], required: true, width: 10, hint: 'Номер гаража (обязательно)' },
    { key: 'fio', title: 'ФИО владельца', titles: ['фио', 'владелец', 'собственник', 'имя', 'фамилия имя отчество'], width: 32, hint: 'Если владельцев несколько — несколько строк с одним номером гаража' },
    { key: 'phone', title: 'Телефон', titles: ['тел', 'мобильный', 'телефон владельца', 'номер телефона'], width: 18, hint: 'Любой формат: 909-111-22-77, +7 909 111 22 77, 89091112277. Это логин владельца' },
    { key: 'email', title: 'Email', titles: ['e-mail', 'почта', 'электронная почта'], width: 28, hint: 'Необязательно' },
    { key: 'area', title: 'Площадь, м²', titles: ['площадь', 'площадь м2', 'площадь м²'], width: 14, hint: 'Необязательно' },
    { key: 'year', title: 'Год постройки', titles: ['год'], width: 14, hint: 'Необязательно' },
    { key: 'benefit', title: 'Льгота, %', titles: ['льгота', 'скидка', 'скидка %'], width: 12, hint: 'Скидка на взнос, 0–100. Пусто — без льготы' },
    { key: 'notes', title: 'Заметки', titles: ['примечание', 'отметки', 'особые отметки', 'комментарий'], width: 32, hint: 'Необязательно' },
  ],
  charges: [
    { key: 'garage', title: 'Гараж', titles: ['номер гаража', '№ гаража', 'номер', 'бокс'], required: true, width: 10, hint: 'Номер существующего гаража' },
    { key: 'type', title: 'Вид', titles: ['вид начисления', 'тип', 'услуга', 'за что'], required: true, width: 20, hint: 'Электроэнергия, Членские взносы или Пеня' },
    { key: 'amount', title: 'Сумма, руб.', titles: ['сумма', 'сумма руб', 'долг', 'начислено'], required: true, width: 16, hint: 'Положительная — долг, отрицательная — аванс/корректировка. Запятая или точка' },
    { key: 'period', title: 'Период', titles: [], width: 14, hint: 'Необязательно: 2026, 2026-Q4, 2026-10' },
    { key: 'description', title: 'Описание', titles: ['комментарий', 'примечание'], width: 36, hint: 'Необязательно' },
  ],
  payments: [
    { key: 'garage', title: 'Гараж', titles: ['номер гаража', '№ гаража', 'номер', 'бокс'], required: true, width: 10, hint: 'Номер существующего гаража' },
    { key: 'type', title: 'Вид', titles: ['вид оплаты', 'тип', 'услуга', 'за что'], required: true, width: 20, hint: 'Электроэнергия, Членские взносы или Пеня' },
    { key: 'amount', title: 'Сумма, руб.', titles: ['сумма', 'сумма руб', 'оплачено'], required: true, width: 16, hint: 'Больше нуля' },
    { key: 'date', title: 'Дата оплаты', titles: ['дата'], width: 16, hint: 'Необязательно: 15.03.2026. Пусто — сегодня' },
    { key: 'method', title: 'Способ', titles: ['способ оплаты'], width: 14, hint: 'Наличные, Карта или Перевод. Пусто — наличные' },
    { key: 'comment', title: 'Комментарий', titles: ['примечание'], width: 32, hint: 'Необязательно' },
  ],
};

const EXAMPLES: Record<ImportKind, (string | number)[][]> = {
  garages: [[17, 'Иванов Иван Иванович', '909-111-22-77', 'ivanov@example.ru', 24, 1998, '', ''], [17, 'Иванова Мария Петровна', '912-222-33-44', '', '', '', '', 'второй владелец'], [18, 'Петров Пётр', '913-333-44-55', '', 30, 2003, 50, 'льготник']],
  charges: [[17, 'Членские взносы', 3000, '2026-Q4', 'Взнос за 4 квартал'], [17, 'Электроэнергия', 1250.5, '', 'Задолженность на 01.10.2026'], [18, 'Членские взносы', -500, '', 'Аванс']],
  payments: [[17, 'Членские взносы', 3000, '15.10.2026', 'Наличные', ''], [18, 'Электроэнергия', 800, '16.10.2026', 'Перевод', 'на карту бухгалтера']],
};

const HELP: Record<ImportKind, string[]> = {
  garages: [
    'Загрузка списка гаражей и владельцев (например, из вашей таблицы).',
    'Одна строка — один владелец гаража. Если у гаража несколько владельцев, добавьте несколько строк с одним номером.',
    'Телефон — это логин владельца. Если пользователя с таким телефоном ещё нет, он будет создан (пароль выдаётся позже кнопкой «Выдать пароль»).',
    'Существующие гаражи и пользователи не перезаписываются: пустые поля дополняются. Чтобы перезаписать, отметьте «Обновлять существующие».',
    'Строки без телефона создают только гараж (без владельца).',
  ],
  charges: [
    'Загрузка начислений и входящих долгов (остатков на начало учёта).',
    'Одна строка — одно начисление. Положительная сумма увеличивает долг, отрицательная — аванс или корректировку.',
    'Гаражи должны уже существовать (сначала загрузите «Гаражи и владельцы»).',
    'Один и тот же файл повторно не загружается (защита от двойных начислений).',
  ],
  payments: [
    'Загрузка истории оплат.',
    'Гаражи должны уже существовать. Оплата уменьшает долг по выбранному виду.',
    'Один и тот же файл повторно не загружается.',
  ],
};

const TYPE_NAMES = { ELECTRICITY: 'Электроэнергия', MEMBERSHIP: 'Членские взносы', PENALTY: 'Пеня' } as const;

function parseType(c: Cell): keyof typeof TYPE_NAMES | null {
  const s = norm(c);
  if (!s) return null;
  if (s === 'electricity' || /электр|свет|квт/.test(s)) return 'ELECTRICITY';
  if (s === 'membership' || /взнос|членск/.test(s)) return 'MEMBERSHIP';
  if (s === 'penalty' || /^пен/.test(s)) return 'PENALTY';
  return null;
}

function parseMethod(c: Cell): 'cash' | 'card' | 'transfer' | null {
  const s = norm(c);
  if (!s) return 'cash';
  if (/нал|cash/.test(s)) return 'cash';
  if (/карт|card/.test(s)) return 'card';
  if (/перевод|transfer|безнал/.test(s)) return 'transfer';
  return null;
}

export interface ImportReport {
  kind: ImportKind;
  dryRun: boolean;
  applied: boolean;
  rows: number;
  errorCount: number;
  errors: { row: number; message: string }[];
  warnings: string[];
  summary: Record<string, number | string>;
  alreadyImported: { at: Date } | null;
}

interface Analysis {
  errors: { row: number; message: string }[];
  warnings: string[];
  summary: Record<string, number | string>;
  apply: () => Promise<void>;
}

@Injectable()
export class ExcelImportService {
  constructor(private prisma: PrismaService) {}

  // ───────── шаблоны ─────────

  async template(kind: ImportKind) {
    const spec = SPECS[kind];
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ГСК «Родник»';
    const ws = wb.addWorksheet('Данные');
    ws.columns = spec.map((c) => ({ header: c.title, key: c.key, width: c.width ?? 16 }));
    styleHeader(ws);
    spec.forEach((c, i) => { if (c.required) ws.getCell(1, i + 1).note = 'Обязательное поле'; });
    if (kind === 'garages') ws.getColumn('garage').numFmt = '@';

    const ex = wb.addWorksheet('Пример');
    ex.columns = ws.columns.map((c) => ({ header: String(c.header), width: (c as any).width }));
    styleHeader(ex);
    EXAMPLES[kind].forEach((r) => ex.addRow(r));

    const help = wb.addWorksheet('Инструкция');
    help.getColumn(1).width = 28; help.getColumn(2).width = 90;
    help.addRow([TITLES[kind]]).font = { bold: true, size: 14 };
    help.addRow([]);
    HELP[kind].forEach((l) => help.addRow(['•', l]));
    help.addRow([]);
    help.addRow(['Колонки']).font = { bold: true };
    spec.forEach((c) => help.addRow([`${c.title}${c.required ? ' *' : ''}`, c.hint ?? '']));
    help.addRow([]);
    help.addRow(['', 'Заполняйте лист «Данные». Листы «Пример» и «Инструкция» при загрузке не читаются.']);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ───────── запуск ─────────

  async run(kind: ImportKind, file: { buffer: Buffer; originalname: string }, opts: { dryRun: boolean; updateExisting: boolean; force: boolean }, actor: { id: number; permissions: string[] }): Promise<ImportReport> {
    const userId = actor.id;
    let sheet;
    try {
      sheet = await readSheet(file.buffer, SPECS[kind]);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
    if (sheet.missing.length) throw new BadRequestException(`В файле нет обязательных колонок: ${sheet.missing.join(', ')}`);

    const hash = createHash('sha256').update(file.buffer).digest('hex');
    const prev = await this.prisma.importLog.findFirst({ where: { kind, fileHash: hash }, orderBy: { id: 'desc' } });

    const a =
      kind === 'garages' ? await this.garages(sheet.rows, opts.updateExisting, actor.permissions)
      : kind === 'charges' ? await this.charges(sheet.rows, userId)
      : await this.payments(sheet.rows, userId);
    if (sheet.unknown.length) a.warnings.push(`Не распознаны и пропущены колонки: ${sheet.unknown.join(', ')}`);

    const report: ImportReport = {
      kind, dryRun: opts.dryRun, applied: false, rows: sheet.rows.length, errorCount: a.errors.length,
      errors: a.errors.slice(0, 200), warnings: a.warnings.slice(0, 50), summary: a.summary, alreadyImported: prev ? { at: prev.at } : null,
    };
    if (opts.dryRun) return report;

    if (a.errors.length) throw new BadRequestException(`В файле есть ошибки (${a.errors.length}). Исправьте их и загрузите файл снова`);
    if (prev && !opts.force && kind !== 'garages') {
      throw new BadRequestException(`Этот файл уже загружался ${prev.at.toISOString().slice(0, 16).replace('T', ' ')} (UTC). Повторная загрузка создаст дубликаты`);
    }
    await a.apply();
    await this.prisma.importLog.create({ data: { kind, fileName: file.originalname.slice(0, 200), fileHash: hash, userId, summary: a.summary as any } });
    return { ...report, applied: true };
  }

  async history() {
    const rows = await this.prisma.importLog.findMany({ orderBy: { id: 'desc' }, take: 50 });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, fullName: true, phone: true } });
    const n = new Map(users.map((u) => [u.id, u.fullName ?? u.phone]));
    return rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, fileName: r.fileName, by: n.get(r.userId) ?? null, summary: r.summary }));
  }

  // ───────── гаражи и владельцы ─────────

  /** `actorPerms` — права загружающего: данные сотрудников с правами шире его импорт не меняет (как и карточка пользователя) */
  private async garages(rows: { row: number; v: Record<string, Cell> }[], updateExisting: boolean, actorPerms: string[]): Promise<Analysis> {
    const errors: Analysis['errors'] = [];
    const warnings: string[] = [];
    interface G { number: string; area?: number; year?: number; benefit?: number; notes?: string; owners: Map<string, { fio?: string; email?: string }> }
    const gs = new Map<string, G>();

    for (const { row, v } of rows) {
      const err = (m: string) => errors.push({ row, message: m });
      const number = garageNo(v.garage);
      if (!number) { err('Не указан номер гаража'); continue; }
      if (!NUMBER_RE.test(number)) { err(`Некорректный номер гаража «${number}» (до 12 символов: цифры, буквы, - /)`); continue; }

      const g = gs.get(number) ?? { number, owners: new Map() };
      gs.set(number, g);

      const set = (k: 'area' | 'year' | 'benefit' | 'notes', val: number | string | undefined) => {
        if (val === undefined) return;
        const cur = (g as any)[k];
        if (cur !== undefined && cur !== val) warnings.push(`Гараж ${number}: разные значения «${k}» в строках — используется первое`);
        else (g as any)[k] = val;
      };
      const area = num(v.area); if (area !== null) { if (Number.isNaN(area) || area <= 0 || area > 1000) err('Площадь: число от 1 до 1000'); else set('area', area); }
      const year = num(v.year); if (year !== null) { if (Number.isNaN(year) || !Number.isInteger(year) || year < 1900 || year > 2100) err('Год постройки: от 1900 до 2100'); else set('year', year); }
      const ben = num(v.benefit); if (ben !== null) { if (Number.isNaN(ben) || !Number.isInteger(ben) || ben < 0 || ben > 100) err('Льгота: целое число от 0 до 100'); else set('benefit', ben); }
      const notes = text(v.notes); if (notes) set('notes', notes.slice(0, 1000));

      const fio = text(v.fio).slice(0, 150), email = text(v.email);
      const phone = phoneLenient(v.phone);
      if (email && (email.length > 150 || !EMAIL_RE.test(email))) { err(`Некорректный email «${email}»`); continue; }
      if (v.phone !== null && phone === '') { err(`Некорректный телефон «${text(v.phone)}»: нужно 10 цифр, например 909-111-22-77`); continue; }
      if (!phone) {
        if (fio || email) err('Указан владелец, но нет телефона (телефон — это логин)');
        continue;
      }
      const o = g.owners.get(phone) ?? {};
      if (o.fio && fio && o.fio !== fio) warnings.push(`Телефон ${phone}: разные ФИО («${o.fio}» и «${fio}») — используется первое`);
      g.owners.set(phone, { fio: o.fio ?? (fio || undefined), email: o.email ?? (email || undefined) });
    }

    const numbers = [...gs.keys()];
    const phones = [...new Set([...gs.values()].flatMap((g) => [...g.owners.keys()]))];
    const [existingG, existingU] = await Promise.all([
      this.prisma.garage.findMany({ where: { number: { in: numbers } }, include: { owners: { where: { toDate: null }, select: { userId: true } } } }),
      this.prisma.user.findMany({ where: { phone: { in: phones } }, include: { role: { select: { name: true, permissions: true } } } }),
    ]);
    const gMap = new Map(existingG.map((g) => [g.number, g]));
    const uMap = new Map(existingU.map((u) => [u.phone, u]));
    for (const g of existingG) if (g.status === 'ARCHIVED') errors.push({ row: rows.find((r) => garageNo(r.v.garage) === g.number)?.row ?? 0, message: `Гараж ${g.number} находится в архиве — восстановите его в разделе «Гаражи»` });
    for (const u of existingU) if (u.deletedAt) errors.push({ row: 0, message: `Телефон ${u.phone} принадлежал удалённому пользователю — используйте другой номер или верните пользователя` });

    // ── что изменится ──
    const newGarages = [...gs.values()].filter((g) => !gMap.has(g.number));
    const garageUpdates: { id: number; data: Record<string, unknown> }[] = [];
    for (const g of gs.values()) {
      const ex = gMap.get(g.number); if (!ex || ex.status === 'ARCHIVED') continue;
      const data: Record<string, unknown> = {};
      const pick = (cond: boolean, key: string, val: unknown) => { if (val !== undefined && (updateExisting || cond)) data[key] = val; };
      pick(ex.areaM2 === null, 'areaM2', g.area);
      pick(ex.buildYear === null, 'buildYear', g.year);
      pick(!ex.notes, 'notes', g.notes);
      if (g.benefit !== undefined && (updateExisting || (!ex.hasBenefit && ex.benefitPercent === 0))) { data.hasBenefit = g.benefit > 0; data.benefitPercent = g.benefit; }
      if (Object.keys(data).length) garageUpdates.push({ id: ex.id, data });
    }
    const newUsers = phones.filter((p) => !uMap.has(p));
    const userUpdates: { id: number; data: Record<string, string> }[] = [];
    for (const g of gs.values()) for (const [phone, o] of g.owners) {
      const u = uMap.get(phone); if (!u || u.deletedAt) continue;
      const data: Record<string, string> = {};
      if (o.fio && (updateExisting || !u.fullName)) data.fullName = o.fio;
      if (o.email && (updateExisting || !u.email)) data.email = o.email;
      if (Object.keys(data).length && !u.role.permissions.every((p) => actorPerms.includes(p))) {
        warnings.push(`Телефон ${phone} (роль «${u.role.name}»): ФИО и email не изменены — права этой роли шире ваших`);
        continue;
      }
      if (Object.keys(data).length && !userUpdates.some((x) => x.id === u.id)) userUpdates.push({ id: u.id, data });
    }
    const linkPairs: { number: string; phone: string }[] = [];
    for (const g of gs.values()) for (const phone of g.owners.keys()) {
      const ex = gMap.get(g.number); const u = uMap.get(phone);
      if (ex && u && ex.owners.some((o) => o.userId === u.id)) continue;
      linkPairs.push({ number: g.number, phone });
    }

    const summary = {
      'Гаражей в файле': gs.size, 'Новых гаражей': newGarages.length, 'Гаражей обновится': garageUpdates.length,
      'Новых пользователей': newUsers.length, 'Пользователей обновится': userUpdates.length, 'Новых привязок владельцев': linkPairs.length,
    };

    const prisma = this.prisma;
    const apply = async () => {
      const hash = await hashPassword(generatePassword(32)); // неизвестный пароль; реальный выдаётся кнопкой «Выдать пароль»
      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'Житель' } });
      await prisma.$transaction(async (tx) => {
        if (newGarages.length) {
          await tx.garage.createMany({
            data: newGarages.map((g) => ({ number: g.number, areaM2: g.area, buildYear: g.year, notes: g.notes, hasBenefit: (g.benefit ?? 0) > 0, benefitPercent: g.benefit ?? 0 })),
            skipDuplicates: true,
          });
        }
        for (const u of garageUpdates) await tx.garage.update({ where: { id: u.id }, data: u.data as any });
        if (newUsers.length) {
          const info = new Map<string, { fio?: string; email?: string }>();
          for (const g of gs.values()) for (const [p, o] of g.owners) info.set(p, { fio: info.get(p)?.fio ?? o.fio, email: info.get(p)?.email ?? o.email });
          await tx.user.createMany({ data: newUsers.map((p) => ({ phone: p, fullName: info.get(p)?.fio, email: info.get(p)?.email, roleId: role.id, passwordHash: hash })), skipDuplicates: true });
        }
        for (const u of userUpdates) await tx.user.update({ where: { id: u.id }, data: u.data });
        if (linkPairs.length) {
          const [gRows, uRows] = await Promise.all([
            tx.garage.findMany({ where: { number: { in: numbers } }, select: { id: true, number: true } }),
            tx.user.findMany({ where: { phone: { in: phones }, deletedAt: null }, select: { id: true, phone: true } }),
          ]);
          const gid = new Map(gRows.map((g) => [g.number, g.id])); const uid = new Map(uRows.map((u) => [u.phone, u.id]));
          await tx.garageOwner.createMany({ data: linkPairs.map((l) => ({ garageId: gid.get(l.number)!, userId: uid.get(l.phone)! })) });
        }
      }, { timeout: 120_000, maxWait: 20_000 });
    };
    return { errors, warnings, summary, apply };
  }

  // ───────── начисления ─────────

  private async lookupGarages(rows: { row: number; v: Record<string, Cell> }[], errors: Analysis['errors']) {
    const numbers = [...new Set(rows.map((r) => garageNo(r.v.garage)).filter(Boolean))];
    const garages = await this.prisma.garage.findMany({ where: { number: { in: numbers } }, select: { id: true, number: true, status: true } });
    return new Map(garages.map((g) => [g.number, g]));
  }

  private async charges(rows: { row: number; v: Record<string, Cell> }[], userId: number): Promise<Analysis> {
    const errors: Analysis['errors'] = [];
    const gm = await this.lookupGarages(rows, errors);
    const data: { garageId: number; type: any; amount: number; period?: string; description?: string; createdById: number }[] = [];
    const totals: Record<string, number> = { ELECTRICITY: 0, MEMBERSHIP: 0, PENALTY: 0 };

    for (const { row, v } of rows) {
      const err = (m: string) => errors.push({ row, message: m });
      const n = garageNo(v.garage); const g = gm.get(n);
      if (!n) { err('Не указан номер гаража'); continue; }
      if (!g) { err(`Гаража №${n} нет в системе`); continue; }
      if (g.status === 'ARCHIVED') { err(`Гараж №${n} в архиве`); continue; }
      const type = parseType(v.type); if (!type) { err(`Не распознан вид «${text(v.type)}»: Электроэнергия, Членские взносы или Пеня`); continue; }
      const a = num(v.amount);
      if (a === null || Number.isNaN(a)) { err(`Некорректная сумма «${text(v.amount)}»`); continue; }
      if (a === 0) { err('Сумма равна нулю'); continue; }
      if (Math.abs(a) > 10_000_000) { err('Сумма слишком велика'); continue; }
      const amount = Math.round(a * 100) / 100;
      const period = text(v.period);
      if (period && !/^[0-9A-Za-z-]{1,20}$/.test(period)) { err(`Некорректный период «${period}» (пример: 2026-Q4)`); continue; }
      data.push({ garageId: g.id, type, amount, period: period || undefined, description: text(v.description).slice(0, 300) || undefined, createdById: userId });
      totals[type] += amount;
    }
    const summary: Record<string, number | string> = {
      'Начислений': data.length, 'Электроэнергия, руб.': Math.round(totals.ELECTRICITY * 100) / 100,
      'Членские взносы, руб.': Math.round(totals.MEMBERSHIP * 100) / 100, 'Пеня, руб.': Math.round(totals.PENALTY * 100) / 100,
    };
    return { errors, warnings: [], summary, apply: async () => { await this.prisma.charge.createMany({ data }); } };
  }

  // ───────── оплаты ─────────

  private async payments(rows: { row: number; v: Record<string, Cell> }[], userId: number): Promise<Analysis> {
    const errors: Analysis['errors'] = [];
    const gm = await this.lookupGarages(rows, errors);
    const data: { garageId: number; type: any; amount: number; paidAt: Date; method: string; comment?: string; receivedById: number }[] = [];
    let total = 0;
    const now = Date.now();

    for (const { row, v } of rows) {
      const err = (m: string) => errors.push({ row, message: m });
      const n = garageNo(v.garage); const g = gm.get(n);
      if (!n) { err('Не указан номер гаража'); continue; }
      if (!g) { err(`Гаража №${n} нет в системе`); continue; }
      if (g.status === 'ARCHIVED') { err(`Гараж №${n} в архиве`); continue; }
      const type = parseType(v.type); if (!type) { err(`Не распознан вид «${text(v.type)}»`); continue; }
      const a = num(v.amount);
      if (a === null || Number.isNaN(a) || a <= 0) { err(`Сумма оплаты должна быть больше нуля (получено «${text(v.amount)}»)`); continue; }
      if (a > 10_000_000) { err('Сумма слишком велика'); continue; }
      const d = parseDate(v.date);
      if (d === 'bad') { err(`Некорректная дата «${text(v.date)}» (нужно 15.03.2026)`); continue; }
      if (d && d.getTime() > now + 86400_000) { err('Дата оплаты в будущем'); continue; }
      const method = parseMethod(v.method); if (!method) { err(`Не распознан способ «${text(v.method)}»: Наличные, Карта или Перевод`); continue; }
      const amount = Math.round(a * 100) / 100;
      data.push({ garageId: g.id, type, amount, paidAt: d ?? new Date(), method, comment: text(v.comment).slice(0, 300) || undefined, receivedById: userId });
      total += amount;
    }
    const summary = { 'Оплат': data.length, 'Сумма, руб.': Math.round(total * 100) / 100 };
    return { errors, warnings: [], summary, apply: async () => { await this.prisma.payment.createMany({ data }); } };
  }
}

const TITLES: Record<ImportKind, string> = {
  garages: 'Гаражи и владельцы',
  charges: 'Начисления и входящие долги',
  payments: 'Оплаты',
};
export const IMPORT_TITLES = TITLES;
