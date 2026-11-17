// Везде время по Москве (MSK, UTC+3), независимо от часового пояса компьютера
const TZ = 'Europe/Moscow';
const rubFmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dtFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const dFmt = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const dLong = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });

export const rub = (n: number | string | null | undefined) => `${rubFmt.format(Number(n ?? 0))} ₽`;
export const num = (n: number | string | null | undefined) => rubFmt.format(Number(n ?? 0));
export const dateTime = (v?: string | Date | null) => (v ? dtFmt.format(new Date(v)) + ' МСК' : '—');
export const date = (v?: string | Date | null) => (v ? dFmt.format(new Date(v)) : '—');
export const dateLong = (v?: string | Date | null) => (v ? dLong.format(new Date(v)) : '—');

/** 9091112277 → 909-111-22-77 */
export function phone(p?: string | null) {
  if (!p) return '—';
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}` : p;
}

/** Маска ввода: оставляет только цифры, ставит дефисы 909-111-22-77 */
export function maskPhone(input: string) {
  const d = input.replace(/\D/g, '').slice(0, 10);
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  return parts.join('-');
}
export const phoneDigits = (s: string) => s.replace(/\D/g, '');
export const phoneValid = (s: string) => phoneDigits(s).length === 10;

export const initials = (name?: string | null) =>
  (name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '•';

export const COLOR_LABEL: Record<string, string> = { GREEN: 'Оплачено', ORANGE: 'Есть долг', RED: 'Долг по всем' };
export const TYPE_LABEL: Record<string, string> = { ELECTRICITY: 'Электроэнергия', MEMBERSHIP: 'Членские взносы', PENALTY: 'Пеня' };
export const METHOD_LABEL: Record<string, string> = { cash: 'Наличные', card: 'Карта', transfer: 'Перевод' };
export const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];

/** Копирование в буфер: navigator.clipboard есть только в защищённом контексте (https/localhost), иначе — запасной способ */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('Не удалось скопировать — выделите и скопируйте вручную');
}
