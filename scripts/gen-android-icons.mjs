// Иконки Android из логотипа. Запуск из корня репозитория: node scripts/gen-android-icons.mjs
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const res = new URL('../apps/pwa/android/app/src/main/res/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const glyph = (color) => `<g fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14h18"/><path d="M6 8l4 3 2-1 3 5 5 1"/></g>`;

// Адаптивный значок: холст 108dp, безопасная зона — центральные 66dp
const foregroundSvg = (px) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 108 108"><g transform="translate(27 27) scale(2.25)">${glyph('#a8dadc')}</g></svg>`;
// Обычный значок: фон + свечение + логотип
const legacySvg = (px, round) => `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 48 48">
  <defs><radialGradient id="g" cx="80%" cy="0%" r="95%"><stop offset="0" stop-color="#2d8b8b"/><stop offset="1" stop-color="#0f1722"/></radialGradient>
  <clipPath id="c">${round ? '<circle cx="24" cy="24" r="24"/>' : '<rect width="48" height="48" rx="10"/>'}</clipPath></defs>
  <g clip-path="url(#c)"><rect width="48" height="48" fill="url(#g)"/><g transform="translate(9 9) scale(1.25)">${glyph('#a8dadc')}</g></g></svg>`;

const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(dens)) {
  const dir = `${res}mipmap-${d}/`;
  mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(foregroundSvg(Math.round(108 * k)))).png().toFile(dir + 'ic_launcher_foreground.png');
  await sharp(Buffer.from(legacySvg(Math.round(48 * k), false))).png().toFile(dir + 'ic_launcher.png');
  await sharp(Buffer.from(legacySvg(Math.round(48 * k), true))).png().toFile(dir + 'ic_launcher_round.png');
  console.log('ok', d);
}
