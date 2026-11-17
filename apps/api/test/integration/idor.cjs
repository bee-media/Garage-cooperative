// ВНИМАНИЕ: создаёт и удаляет записи в БД — запускать ТОЛЬКО на базе разработки (apps/api/.env), из папки apps/api: npm run test:security
// Доступ к чужим данным: два жителя A и B, у каждого свой гараж; A не должен видеть/менять данные B
require('dotenv').config({ quiet: true });
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const cookieParser = require('cookie-parser');
const { AppModule } = require('../../dist/app.module');
const { PrismaService } = require('../../dist/common/prisma.service');
const { hashPassword } = require('../../dist/common/password');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'); const path = require('node:path');

let fails = 0;
const ok = (n, c, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + extra)); if (!c) fails++; };

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.set('trust proxy', 1); app.use(cookieParser()); app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const prisma = app.get(PrismaService), jwt = app.get(JwtService);
  const files = require('../../dist/files/files.module'); const { FilesService } = files;
  const fsvc = app.get(FilesService, { strict: false });
  let ip = 0;
  const call = (tok, method, url, body) => fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.9.${(ip >> 8) & 255}.${++ip & 255}`, ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });

  const res = await prisma.role.findUnique({ where: { name: 'Житель' } });
  const hash = await hashPassword('Xx123456abc');
  const mkUser = async (phone) => {
    const u = await prisma.user.upsert({ where: { phone }, update: { deletedAt: null, lockedAt: null, isBlocked: false, consentAt: new Date() }, create: { phone, roleId: res.id, passwordHash: hash, consentAt: new Date(), fullName: 'IDOR ' + phone } });
    const s = await prisma.session.create({ data: { userId: u.id, refreshHash: randomUUID(), client: 'pwa', expiresAt: new Date(Date.now() + 3600e3) } });
    return { u, tok: await jwt.signAsync({ sub: u.id, sid: s.id }) };
  };
  const A = await mkUser('9995510001'), B = await mkUser('9995510002');
  const gA = await prisma.garage.upsert({ where: { number: 'IDOR-A' }, update: {}, create: { number: 'IDOR-A' } });
  const gB = await prisma.garage.upsert({ where: { number: 'IDOR-B' }, update: {}, create: { number: 'IDOR-B' } });
  await prisma.garageOwner.createMany({ data: [{ garageId: gA.id, userId: A.u.id }, { garageId: gB.id, userId: B.u.id }] });
  await prisma.charge.create({ data: { garageId: gB.id, type: 'MEMBERSHIP', amount: 12345, createdById: B.u.id, description: 'IDOR-долг B' } });

  // фото счётчика B + показание
  const f1 = await fsvc.saveRaw(Buffer.from('x'), 'meter', '.jpg', 'image/jpeg', B.u.id);
  const f2 = await fsvc.saveRaw(Buffer.from('y'), 'meter', '.jpg', 'image/jpeg', B.u.id);
  const reading = await prisma.meterReading.create({ data: { garageId: gB.id, userId: B.u.id, value: 100, takenAt: new Date(), photos: { create: [{ fileId: f1.id }, { fileId: f2.id }] } } });
  // объявление B (на модерации) и одобренное
  const adP = await prisma.ad.create({ data: { userId: B.u.id, garageId: gB.id, garageNumber: 'IDOR-B', type: 'SALE', price: 1, status: 'PENDING' } });
  const adF = await fsvc.saveRaw(Buffer.from('z'), 'ad', '.jpg', 'image/jpeg', B.u.id);
  await prisma.adPhoto.create({ data: { adId: adP.id, fileId: adF.id } });
  // скрытая новость с фото
  const nf = await fsvc.saveRaw(Buffer.from('n'), 'news', '.jpg', 'image/jpeg', B.u.id);
  const hidden = await prisma.news.create({ data: { title: 'IDOR hidden', body: 'x', authorId: B.u.id, status: 'HIDDEN', photos: { create: [{ fileId: nf.id }] } } });
  // файл apk
  const apkF = await fsvc.saveRaw(Buffer.from('p'), 'apk', '.apk', 'application/vnd.android.package-archive', B.u.id);

  // ── проверки ──
  let r = await call(A.tok, 'GET', `/meters/${reading.id}`); ok('A не видит показание B (404)', r.status === 404, r.status);
  r = await call(B.tok, 'GET', `/meters/${reading.id}`); ok('B видит своё показание', r.status === 200, r.status);
  r = await call(A.tok, 'GET', '/meters/my'); const mine = await r.json(); ok('A в «моих показаниях» не видит чужие', r.status === 200 && !(mine.items ?? []).some((x) => x.id === reading.id));
  r = await call(A.tok, 'GET', `/meters/my?garageId=${gB.id}`); const mine2 = await r.json(); ok('A не может запросить показания чужого гаража', !(mine2.items ?? []).length, JSON.stringify(mine2).slice(0, 80));
  r = await call(A.tok, 'POST', '/meters', { garageId: gB.id, value: 5, takenAt: new Date().toISOString(), fileIds: [f1.id, f2.id] }); ok('A не может передать показание за чужой гараж (403)', r.status === 403, r.status);
  r = await call(A.tok, 'GET', `/files/${f1.id}`); ok('A не открывает фото счётчика B (404)', r.status === 404, r.status);
  r = await call(A.tok, 'POST', `/files/${f1.id}/link`); ok('A не получает ссылку на фото счётчика B (404)', r.status === 404, r.status);
  r = await call(B.tok, 'GET', `/files/${f1.id}`); ok('B открывает своё фото (файл физически отсутствует → 404/200, но не 403/500)', [200, 404].includes(r.status), r.status);
  r = await call(A.tok, 'GET', `/files/${adF.id}`); ok('A не видит фото неодобренного объявления B', r.status === 404, r.status);
  r = await call(A.tok, 'GET', `/ads/${adP.id}`); ok('A не видит неодобренное объявление B (404)', r.status === 404, r.status);
  r = await call(A.tok, 'PATCH', `/ads/${adP.id}`, { price: 2 }); ok('A не может править чужое объявление (404)', r.status === 404, r.status);
  r = await call(A.tok, 'POST', `/ads/${adP.id}/archive`); ok('A не может архивировать чужое объявление (404)', r.status === 404, r.status);
  r = await call(A.tok, 'POST', '/ads', { garageNumber: 'IDOR-B', type: 'SALE', price: 1 }); ok('A не может подать объявление на гараж B (403)', r.status === 403, r.status);
  r = await call(A.tok, 'GET', `/news/${hidden.id}`); ok('A не видит скрытую новость (404)', r.status === 404, r.status);
  r = await call(A.tok, 'GET', `/files/${nf.id}`); ok('A не видит фото скрытой новости (404)', r.status === 404, r.status);
  r = await call(A.tok, 'GET', '/finance/my'); const my = await r.json(); ok('A в «моём долге» не видит гараж и долг B', !JSON.stringify(my).includes('IDOR-B') && !JSON.stringify(my).includes('12345'), JSON.stringify(my).slice(0, 100));
  r = await call(A.tok, 'GET', `/finance/garages/${gB.id}`); ok('A не открывает карточку долга гаража B (403)', r.status === 403, r.status);
  r = await call(A.tok, 'GET', `/garages/${gB.id}`); ok('A не открывает карточку гаража B (403)', r.status === 403, r.status);
  r = await call(A.tok, 'GET', `/users/${B.u.id}`); ok('A не открывает профиль B (403)', r.status === 403, r.status);
  r = await call(A.tok, 'GET', `/users/${B.u.id}/sessions`); ok('A не видит сессии B (403)', r.status === 403, r.status);
  r = await call(A.tok, 'GET', '/auth/sessions'); const ses = await r.json(); ok('A видит только свои сессии', ses.every((x) => true) && ses.length === 1, ses.length);
  const sB = await prisma.session.findFirst({ where: { userId: B.u.id } });
  r = await call(A.tok, 'DELETE', `/auth/sessions/${sB.id}`); ok('A не может завершить сессию B (404)', r.status === 404, r.status);
  r = await call(A.tok, 'GET', `/releases/1/download`); ok('скачивание APK требует права только входа; без токена 401', (await call(null, 'GET', '/releases/1/download')).status === 401);
  r = await call(A.tok, 'GET', `/files/${apkF.id}`); ok('APK через /files недоступен (404)', r.status === 404, r.status);
  r = await call(A.tok, 'GET', '/files/..%2F..%2Fetc%2Fpasswd'); ok('обход пути в /files/:id отклонён (400)', r.status === 400, r.status);
  r = await call(null, 'GET', `/files/${f1.id}?t=garbage`); ok('поддельная подписанная ссылка отклонена (401)', r.status === 401, r.status);
  // ссылка, выписанная для другого файла, не открывает этот
  const lnk = await (await call(B.tok, 'POST', `/files/${f1.id}/link`)).json();
  const t = new URL('http://x' + lnk.url).searchParams.get('t');
  r = await call(null, 'GET', `/files/${f2.id}?t=${t}`); ok('ссылка на файл 1 не открывает файл 2 (401)', r.status === 401, r.status);
  r = await call(null, 'GET', `/news?t=${t}`); ok('ссылка на файл не годится как токен API (401)', r.status === 401, r.status);
  r = await fetch(base + '/api/news', { headers: { Authorization: 'Bearer ' + t } }); ok('ссылка на файл в заголовке не годится (401)', r.status === 401, r.status);
  // заблокированный пользователь с живым токеном
  await prisma.user.update({ where: { id: B.u.id }, data: { isBlocked: true } });
  r = await call(B.tok, 'GET', '/news'); ok('заблокированный пользователь отклонён сразу (401)', r.status === 401, r.status);

  // ── уборка ──
  await prisma.news.delete({ where: { id: hidden.id } });
  await prisma.adPhoto.deleteMany({ where: { adId: adP.id } }); await prisma.ad.deleteMany({ where: { garageId: { in: [gA.id, gB.id] } } });
  await prisma.meterPhoto.deleteMany({ where: { readingId: reading.id } }); await prisma.meterReading.deleteMany({ where: { garageId: gB.id } });
  await fsvc.remove([f1.id, f2.id, adF.id, nf.id, apkF.id]);
  await prisma.charge.deleteMany({ where: { garageId: gB.id } }); await prisma.garageOwner.deleteMany({ where: { garageId: { in: [gA.id, gB.id] } } });
  await prisma.garage.deleteMany({ where: { id: { in: [gA.id, gB.id] } } });
  for (const x of [A, B]) { await prisma.session.deleteMany({ where: { userId: x.u.id } }); await prisma.auditLog.deleteMany({ where: { actorId: x.u.id } }); await prisma.user.delete({ where: { id: x.u.id } }).catch(() => {}); }
  console.log(fails ? `\nИТОГ: провалено проверок: ${fails}` : '\nИТОГ: все проверки пройдены');
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
