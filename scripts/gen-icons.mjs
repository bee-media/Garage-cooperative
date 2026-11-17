// Генерация иконок PWA из SVG. Запуск: node scripts/gen-icons.mjs
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

const out = new URL('../apps/pwa/public/icons/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(out, { recursive: true });

const svg = (size, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="80%" cy="0%" r="90%"><stop offset="0" stop-color="#2d8b8b" stop-opacity=".9"/><stop offset="1" stop-color="#0f1722"/></radialGradient>
  </defs>
  <rect width="512" height="512" fill="#0f1722"/><rect width="512" height="512" fill="url(#g)"/>
  <g transform="translate(${256 - (256 - pad) } ${256 - (256 - pad)}) scale(${(512 - pad * 2) / 512})">
    <g fill="none" stroke="#a8dadc" stroke-width="22" stroke-linecap="round" stroke-linejoin="round" transform="translate(96 96) scale(13.33)">
      <path d="M3 5v14h18"/><path d="M6 8l4 3 2-1 3 5 5 1"/>
    </g>
  </g>
</svg>`;

const jobs = [
  ['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['maskable-512.png', 512, 70], ['apple-touch-icon.png', 180, 0],
];
for (const [name, size, pad] of jobs) {
  await sharp(Buffer.from(svg(size, pad))).png().toFile(out + name);
  console.log('ok', name);
}
