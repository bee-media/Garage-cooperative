// Вся система работает по Москве (MSK, UTC+3, без перехода на летнее время)
export const TZ = 'Europe/Moscow';

export function mskParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute),
    ym: `${p.year}-${p.month}`,
  };
}
