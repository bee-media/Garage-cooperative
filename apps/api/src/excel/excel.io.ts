// Общие функции чтения/записи xlsx
import * as ExcelJS from 'exceljs';

export type Cell = string | number | Date | null;

export interface ColumnSpec {
  key: string;
  /** допустимые заголовки (регистр и пробелы не важны) */
  titles: string[];
  title: string; // как называется в шаблоне
  required?: boolean;
  width?: number;
  hint?: string;
}

export const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[\s_.,:;()«»"'№#-]+/g, ' ').trim();

/** Значение ячейки exceljs → простое значение */
export function cellValue(v: ExcelJS.CellValue): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'number' || v instanceof Date) return v;
  if (typeof v === 'boolean') return v ? 'да' : 'нет';
  const o = v as any;
  if (o.result !== undefined) return cellValue(o.result);                                   // формула
  if (Array.isArray(o.richText)) return cellValue(o.richText.map((r: any) => r.text).join(''));
  if (o.text !== undefined) return cellValue(o.text);                                       // гиперссылка
  if (o.error) return null;
  return null;
}

/**
 * xlsx — это zip. Файл в 3 МБ может «распаковаться» в гигабайты и уронить сервер, поэтому до разбора
 * суммируем заявленные размеры файлов по оглавлению архива и отсекаем слишком большие.
 */
const MAX_UNPACKED = 60 * 1024 * 1024;
export function assertSafeZip(buf: Buffer) {
  const bad = () => new Error('Файл повреждён или слишком велик');
  let eocd = -1; // запись «конец центрального каталога» ищем с конца (комментарий до 64 КБ)
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad();
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count > 2000) throw bad();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw bad();
    total += buf.readUInt32LE(off + 24); // несжатый размер
    if (total > MAX_UNPACKED) throw bad();
    off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
}

export interface ParsedRow { row: number; v: Record<string, Cell> }

export interface ParsedSheet { rows: ParsedRow[]; unknown: string[]; missing: string[]; headerRow: number }

/** Читает файл xlsx: находит строку заголовков и сопоставляет колонки по названиям */
export async function readSheet(buf: Buffer, spec: ColumnSpec[], maxRows = 5000): Promise<ParsedSheet> {
  assertSafeZip(buf);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new Error('Не удалось прочитать файл. Нужен Excel (.xlsx)');
  }
  const ws = wb.getWorksheet('Данные') ?? wb.worksheets[0];
  if (!ws) throw new Error('В файле нет листов');

  const byTitle = new Map<string, ColumnSpec>();
  for (const c of spec) for (const t of [c.title, ...c.titles]) byTitle.set(norm(t), c);

  // заголовок — первая из первых 10 строк, где распознана хотя бы одна колонка
  let headerRow = 0;
  const colKey = new Map<number, string>();
  const unknown: string[] = [];
  for (let r = 1; r <= Math.min(10, ws.rowCount) && !headerRow; r++) {
    const row = ws.getRow(r);
    const found = new Map<number, string>();
    const unk: string[] = [];
    row.eachCell((cell, col) => {
      const t = cellValue(cell.value);
      if (t === null) return;
      const c = byTitle.get(norm(t));
      if (c && ![...found.values()].includes(c.key)) found.set(col, c.key); else unk.push(String(t));
    });
    if (found.size) { headerRow = r; found.forEach((k, col) => colKey.set(col, k)); unknown.push(...unk); }
  }
  if (!headerRow) throw new Error('Не найдена строка заголовков. Скачайте шаблон и заполните его');
  const present = new Set(colKey.values());
  const missing = spec.filter((c) => c.required && !present.has(c.key)).map((c) => c.title);

  const rows: ParsedRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    // колонок, которых нет в файле, — null (а не undefined): разбор значений рассчитан на null
    const v: Record<string, Cell> = Object.fromEntries(spec.map((c) => [c.key, null]));
    let any = false;
    colKey.forEach((key, col) => { const x = cellValue(row.getCell(col).value); v[key] = x; if (x !== null) any = true; });
    if (!any) continue;
    rows.push({ row: r, v });
    if (rows.length > maxRows) throw new Error(`Слишком много строк (максимум ${maxRows} за один раз)`);
  }
  return { rows, unknown, missing, headerRow };
}

// ───────── разбор значений ─────────

export const text = (c: Cell): string => (c === null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : typeof c === 'number' ? (Number.isInteger(c) ? String(c) : String(c)) : c.trim());

/** Номер гаража: 17, 17.0, «17» → «17» */
export const garageNo = (c: Cell): string => {
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(c);
  return text(c).replace(/^№\s*/, '').replace(/\.0+$/, '');
};

export function num(c: Cell): number | null {
  if (c === null || c === '') return null;
  if (typeof c === 'number') return c;
  if (c instanceof Date) return null;
  const s = c.replace(/[\s  ]/g, '').replace(',', '.').replace(/[₽р]\.?$|руб\.?$/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

/** Телефон из любого формата: +7 (909) 111-22-77, 8 909 111 22 77, 909-111-22-77 → 9091112277 */
export function phoneLenient(c: Cell): string | null {
  if (c === null) return null;
  let d = (typeof c === 'number' ? String(Math.round(c)) : text(c)).replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  return /^\d{10}$/.test(d) ? d : '';
}

export function parseDate(c: Cell): Date | null | 'bad' {
  if (c === null) return null;
  if (c instanceof Date) return c;
  if (typeof c === 'number') return new Date(Math.round((c - 25569) * 86400_000)); // серийный номер даты Excel
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(c.trim());
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[1]), 9, 0, 0)); // полдень по Москве
    return d.getUTCMonth() === Number(m[2]) - 1 ? d : 'bad';
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(c.trim());
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 9, 0, 0));
  return 'bad';
}

// ───────── оформление ─────────

export const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF23706F' } };

export function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 28;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

/** Дата для ячейки: Excel не хранит часовой пояс, поэтому сдвигаем на МСК, чтобы в ячейке было московское время */
export const mskDate = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 3 * 3600_000) : null);
