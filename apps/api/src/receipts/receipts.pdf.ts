// Построение PDF-квитанций (pdfmake, шрифт Roboto с кириллицей). Только форматирование: данные приходят готовыми.
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfmake: any = require('pdfmake');

const fontsDir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
pdfmake.setFonts({
  Roboto: {
    normal: path.join(fontsDir, 'Roboto-Regular.ttf'),
    bold: path.join(fontsDir, 'Roboto-Medium.ttf'),
    italics: path.join(fontsDir, 'Roboto-Italic.ttf'),
    bolditalics: path.join(fontsDir, 'Roboto-MediumItalic.ttf'),
  },
});
// Документ не должен тянуть ничего из сети и читать произвольные файлы: разрешены только шрифты
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((p: string) => path.resolve(p).startsWith(fontsDir));

export interface ReceiptSettings {
  orgName: string; orgAddress: string; phone: string;
  inn: string; kpp: string; account: string; bankName: string; bik: string; corrAccount: string;
  headerNote: string; footerNote: string; purposeTemplate: string;
  signerPosition: string; signerName: string;
  showQr: boolean; autoEmailPayments: boolean;
}

export const DEFAULT_RECEIPT: ReceiptSettings = {
  orgName: 'ГСК «Родник»', orgAddress: '', phone: '', inn: '', kpp: '', account: '', bankName: '', bik: '', corrAccount: '',
  headerNote: '', footerNote: 'Оплату можно внести в правлении в часы приёма. Спасибо!', purposeTemplate: 'Оплата за гараж №{garage}. {fio}',
  signerPosition: 'Председатель правления', signerName: '', showQr: true, autoEmailPayments: false,
};

export interface BillingData {
  garageNumber: string;
  owners: string[];
  electricity: number; membership: number; penalty: number; total: number; advance: number;
  dateMsk: string; // 16.10.2026
}

export interface PaymentData {
  id: number;
  garageNumber: string;
  owners: string[];
  typeLabel: string;
  amount: number;
  method: string;
  comment?: string | null;
  paidAtMsk: string; // 16.10.2026 14:05
  receivedBy: string;
  voided: boolean;
  remaining?: { label: string; value: number };
}

// ───────── форматирование ─────────

export const money = (n: number) => {
  const [i, f] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '−' : ''}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${f}`;
};

const ONES_M = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const ONES_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

function plural(n: number, f: [string, string, string]) {
  const m = n % 100, d = n % 10;
  if (m >= 11 && m <= 19) return f[2];
  return d === 1 ? f[0] : d >= 2 && d <= 4 ? f[1] : f[2];
}

function triad(n: number, female: boolean) {
  const o = female ? ONES_F : ONES_M;
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
  const out = [HUNDREDS[h]];
  if (t === 1) out.push(TEENS[u]); else { out.push(TENS[t]); out.push(o[u]); }
  return out.filter(Boolean).join(' ');
}

/** 3000.5 → «Три тысячи рублей 50 копеек» */
export function rublesInWords(value: number): string {
  const total = Math.round(Math.abs(value) * 100);
  const rub = Math.floor(total / 100), kop = total % 100;
  const parts: string[] = [];
  const mln = Math.floor(rub / 1_000_000), th = Math.floor((rub % 1_000_000) / 1000), rest = rub % 1000;
  if (mln) parts.push(`${triad(mln, false)} ${plural(mln, ['миллион', 'миллиона', 'миллионов'])}`);
  if (th) parts.push(`${triad(th, true)} ${plural(th, ['тысяча', 'тысячи', 'тысяч'])}`);
  if (rest || !rub) parts.push(rest ? triad(rest, false) : 'ноль');
  const words = `${parts.join(' ')} ${plural(rub, ['рубль', 'рубля', 'рублей'])}`;
  return `${words[0].toUpperCase()}${words.slice(1)} ${String(kop).padStart(2, '0')} ${plural(kop, ['копейка', 'копейки', 'копеек'])}`;
}

const fill = (tpl: string, vars: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

/** Строка для платёжного QR по ГОСТ Р 56042 (ST00012 — кодировка UTF-8) */
export function paymentQr(s: ReceiptSettings, sum: number, purpose: string, fio: string): string | null {
  if (!s.account || !s.bik || !s.orgName) return null;
  const clean = (v: string) => v.replace(/[|\n\r]/g, ' ').trim();
  const f: [string, string | undefined][] = [
    ['Name', s.orgName], ['PersonalAcc', s.account], ['BankName', s.bankName], ['BIC', s.bik], ['CorrespAcc', s.corrAccount],
    ['PayeeINN', s.inn], ['KPP', s.kpp], ['Sum', String(Math.round(sum * 100))], ['Purpose', purpose], ['LastName', fio],
  ];
  return 'ST00012|' + f.filter(([, v]) => v).map(([k, v]) => `${k}=${clean(v!)}`).join('|');
}

// ───────── квитанция на оплату ─────────

export function billingContent(s: ReceiptSettings, d: BillingData): any[] {
  const fio = d.owners.join(', ') || '—';
  const purpose = fill(s.purposeTemplate, { garage: d.garageNumber, fio, date: d.dateMsk });
  const rows: any[][] = [[{ text: 'Услуга', bold: true }, { text: 'К оплате, руб.', bold: true, alignment: 'right' }]];
  if (d.membership > 0) rows.push(['Членские взносы', { text: money(d.membership), alignment: 'right' }]);
  if (d.electricity > 0) rows.push(['Электроэнергия', { text: money(d.electricity), alignment: 'right' }]);
  if (d.penalty > 0) rows.push(['Пеня', { text: money(d.penalty), alignment: 'right' }]);
  const hasDebt = d.total > 0;
  if (!hasDebt) rows.push([{ text: 'Задолженности нет', colSpan: 2, italics: true, color: '#2f7d5b' }, '']);

  const requisites: any[] = [];
  const line = (k: string, v: string) => v && requisites.push({ text: [{ text: `${k}: `, color: '#666666' }, v], margin: [0, 1, 0, 1] });
  line('Получатель', s.orgName);
  line('ИНН / КПП', [s.inn, s.kpp].filter(Boolean).join(' / '));
  line('Расчётный счёт', s.account);
  line('Банк', s.bankName);
  line('БИК', s.bik);
  line('Корр. счёт', s.corrAccount);
  line('Адрес', s.orgAddress);
  line('Телефон', s.phone);

  const qr = s.showQr && hasDebt ? paymentQr(s, d.total, purpose, fio) : null;

  return [
    { text: s.orgName, fontSize: 16, bold: true },
    { text: 'КВИТАНЦИЯ НА ОПЛАТУ', fontSize: 13, bold: true, margin: [0, 8, 0, 0], color: '#23706f' },
    { text: `от ${d.dateMsk}`, color: '#666666', margin: [0, 0, 0, 8] },
    ...(s.headerNote ? [{ text: s.headerNote, margin: [0, 0, 0, 8], italics: true }] : []),
    {
      columns: [
        { width: '*', stack: requisites },
        ...(qr ? [{ width: 100, stack: [{ qr, fit: 96 }, { text: 'Оплата по QR', fontSize: 8, color: '#666666', alignment: 'center' }] }] : []),
      ],
      columnGap: 16,
    },
    { canvas: [{ type: 'line', x1: 0, y1: 8, x2: 515, y2: 8, lineWidth: 0.7, lineColor: '#bbbbbb' }], margin: [0, 0, 0, 8] },
    { text: [{ text: 'Плательщик: ', color: '#666666' }, `гараж №${d.garageNumber}`], fontSize: 13, bold: true },
    { text: fio, margin: [0, 2, 0, 10] },
    { table: { widths: ['*', 110], body: rows }, layout: { hLineColor: '#cccccc', vLineColor: '#cccccc', paddingTop: () => 6, paddingBottom: () => 6 } },
    ...(hasDebt ? [
      { text: [{ text: 'ИТОГО К ОПЛАТЕ: ', bold: true }, { text: `${money(d.total)} руб.`, bold: true, fontSize: 14 }], margin: [0, 10, 0, 2], alignment: 'right' },
      { text: rublesInWords(d.total), alignment: 'right', color: '#555555' },
    ] : []),
    ...(d.advance > 0 ? [{ text: `Переплата (аванс) на вашем счёте: ${money(d.advance)} руб.`, margin: [0, 8, 0, 0], color: '#2f7d5b' }] : []),
    ...(hasDebt ? [{ text: [{ text: 'Назначение платежа: ', color: '#666666' }, purpose], margin: [0, 12, 0, 0] }] : []),
    { text: s.footerNote, margin: [0, 18, 0, 0], fontSize: 10, color: '#555555' },
    {
      margin: [0, 26, 0, 0],
      columns: [
        { width: '*', text: [{ text: `${s.signerPosition} `, color: '#666666' }, '____________________ ', s.signerName] },
        { width: 80, text: 'М.П.', color: '#999999', alignment: 'right' },
      ],
    },
  ];
}

// ───────── чек об оплате ─────────

export function paymentContent(s: ReceiptSettings, p: PaymentData): any[] {
  const fio = p.owners.join(', ') || '—';
  return [
    { text: s.orgName, fontSize: 16, bold: true },
    ...(s.orgAddress || s.phone ? [{ text: [s.orgAddress, s.phone].filter(Boolean).join(' · '), color: '#666666', fontSize: 9 }] : []),
    { text: `КВИТАНЦИЯ ОБ ОПЛАТЕ № ${p.id}`, fontSize: 14, bold: true, margin: [0, 10, 0, 0], color: '#23706f' },
    { text: `от ${p.paidAtMsk} (МСК)`, color: '#666666', margin: [0, 0, 0, 8] },
    ...(p.voided ? [{ text: 'ОПЛАТА АННУЛИРОВАНА', bold: true, color: '#c9302c', fontSize: 14, margin: [0, 0, 0, 8] }] : []),
    ...(s.headerNote ? [{ text: s.headerNote, italics: true, margin: [0, 0, 0, 8] }] : []),
    { text: [{ text: 'Принято от: ', color: '#666666' }, `гараж №${p.garageNumber}, ${fio}`], margin: [0, 4, 0, 4] },
    { text: [{ text: 'За что: ', color: '#666666' }, p.typeLabel], margin: [0, 0, 0, 4] },
    { text: [{ text: 'Способ оплаты: ', color: '#666666' }, p.method], margin: [0, 0, 0, 4] },
    ...(p.comment ? [{ text: [{ text: 'Комментарий: ', color: '#666666' }, p.comment], margin: [0, 0, 0, 4] }] : []),
    { text: [{ text: 'Сумма: ', bold: true }, { text: `${money(p.amount)} руб.`, bold: true, fontSize: 15 }], margin: [0, 10, 0, 2] },
    { text: rublesInWords(p.amount), color: '#555555' },
    ...(p.remaining ? [{ text: `${p.remaining.label}: ${p.remaining.value > 0 ? `задолженность ${money(p.remaining.value)} руб.` : p.remaining.value < 0 ? `аванс ${money(-p.remaining.value)} руб.` : 'задолженности нет'}`, margin: [0, 10, 0, 0], color: '#555555' }] : []),
    { text: s.footerNote, margin: [0, 16, 0, 0], fontSize: 10, color: '#555555' },
    {
      margin: [0, 26, 0, 0],
      columns: [
        { width: '*', text: [{ text: 'Принял: ', color: '#666666' }, `${p.receivedBy}  ____________________`] },
        { width: 80, text: 'М.П.', color: '#999999', alignment: 'right' },
      ],
    },
  ];
}

/** Собирает документ из блоков (каждый блок — отдельная страница) и возвращает PDF */
export async function renderPdf(pages: any[][], title: string): Promise<Buffer> {
  const content: any[] = [];
  pages.forEach((p, i) => {
    if (i > 0) content.push({ text: '', pageBreak: 'before' });
    content.push(...p);
  });
  const doc = {
    info: { title, creator: 'ГСК «Родник»' },
    pageSize: 'A4',
    pageMargins: [40, 44, 40, 44],
    defaultStyle: { font: 'Roboto', fontSize: 11 },
    content,
  };
  return pdfmake.createPdf(doc).getBuffer();
}
