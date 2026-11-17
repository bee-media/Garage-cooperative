const TZ = 'Europe/Moscow';
const rubFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dtFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const dShort = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const phoneDt = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const rub = (n: number | string | null | undefined) => `${rubFmt.format(Number(n ?? 0))} ₽`;
export const num = (n: number | string | null | undefined) => rubFmt.format(Number(n ?? 0));
/** Время по Москве (как в журнале и на портале) */
export const dateTime = (v?: string | Date | null) => (v ? `${dtFmt.format(new Date(v))} МСК` : '—');
export const dateLong = (v?: string | Date | null) => (v ? dFmt.format(new Date(v)) : '—');
export const dateShort = (v?: string | Date | null) => (v ? dShort.format(new Date(v)) : '—');
/** Время с часов телефона — то, что отправляется как «дата передачи» */
export const phoneTime = (v: Date) => phoneDt.format(v);

export function phone(p?: string | null) {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}` : p;
}
export function maskPhone(input: string) {
  const d = input.replace(/\D/g, '').slice(0, 10);
  return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean).join('-');
}
export const phoneDigits = (s: string) => s.replace(/\D/g, '');
export const phoneValid = (s: string) => phoneDigits(s).length === 10;
export const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
export const initials = (name?: string | null) => (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '•';

/** Сжатие фото на телефоне: длинная сторона ≤ 1800 px, JPEG 82% */
export async function compressImage(file: File, maxSide = 1800, quality = 0.82): Promise<Blob> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось обработать фото'))), 'image/jpeg', quality));
}
