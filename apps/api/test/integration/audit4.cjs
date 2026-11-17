// ВНИМАНИЕ: создаёт и удаляет записи в БД — запускать ТОЛЬКО на базе разработки (apps/api/.env), из папки apps/api: npm run test:security
// Исправления четвёртого аудита: объявления в архиве, чужие данные в показаниях, контакты для сотрудников без users.view,
// ротация refresh-токена, удалённые пользователи, квота загрузок, файлы карты, 2FA, импорт Excel
require('dotenv').config({ quiet: true });
process.env.NODE_ENV = 'development';
const { NestFactory } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { JwtService } = require('@nestjs/jwt');
const cookieParser = require('cookie-parser');
const ExcelJS = require('exceljs');
const { AppModule } = require('../../dist/app.module');
const { PrismaService } = require('../../dist/common/prisma.service');
const { hashPassword } = require('../../dist/common/password');
const { encryptSecret, hotp, newTotpSecret } = require('../../dist/auth/totp');
const { DAILY_UPLOADS } = require('../../dist/files/files.module');
const { randomUUID } = require('node:crypto');

let fails = 0;
const ok = (n, c, extra = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + extra)); if (!c) fails++; };
const PASSWORD = 'Xx123456abc';
const P = (i) => `999556${String(i).padStart(4, '0')}`; // телефоны тестовых пользователей

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.set('trust proxy', 1); app.use(cookieParser()); app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const prisma = app.get(PrismaService), jwt = app.get(JwtService);
  let ip = 0;
  const xff = () => `10.8.${(ip >> 8) & 255}.${++ip & 255}`;
  const call = (tok, method, url, body) => fetch(base + '/api' + url, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff(), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const json = async (r) => { try { return await r.json(); } catch { return null; } };

  // уборка остатков прошлого запуска
  const cleanup = async () => {
    const users = await prisma.user.findMany({ where: { OR: [{ phone: { startsWith: '999556' } }, { fullName: { startsWith: 'A4 ' } }] }, select: { id: true } });
    const ids = users.map((u) => u.id);
    const gs = await prisma.garage.findMany({ where: { number: { startsWith: 'A4-' } }, select: { id: true } });
    const gids = gs.map((g) => g.id);
    await prisma.ad.deleteMany({ where: { OR: [{ userId: { in: ids } }, { garageId: { in: gids } }] } });
    await prisma.meterPhoto.deleteMany({ where: { reading: { garageId: { in: gids } } } });
    await prisma.meterReading.deleteMany({ where: { garageId: { in: gids } } });
    await prisma.garageOwner.deleteMany({ where: { OR: [{ userId: { in: ids } }, { garageId: { in: gids } }] } });
    await prisma.garage.deleteMany({ where: { id: { in: gids } } });
    await prisma.mapMark.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.mapPole.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.fileAsset.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.backupCode.deleteMany({ where: { userId: { in: ids } } });
    await prisma.importLog.deleteMany({ where: { userId: { in: ids } } });
    await prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  };
  await cleanup();

  const hash = await hashPassword(PASSWORD);
  const role = async (name) => prisma.role.findUniqueOrThrow({ where: { name } });
  const mk = async (i, roleName, opts = {}) => {
    const r = await role(roleName);
    const u = await prisma.user.create({ data: { phone: P(i), roleId: r.id, passwordHash: hash, consentAt: new Date(), fullName: 'A4 ' + roleName + ' ' + i, totpEnabled: opts.totp ?? r.portalAccess } });
    const s = await prisma.session.create({ data: { userId: u.id, refreshHash: randomUUID(), client: 'pwa', expiresAt: new Date(Date.now() + 3600e3) } });
    return { u, sid: s.id, tok: await jwt.signAsync({ sub: u.id, sid: s.id }) };
  };
  const A = await mk(1, 'Житель'), B = await mk(2, 'Житель'), elec = await mk(3, 'Электрик'), chair = await mk(4, 'Председатель');
  const g = await prisma.garage.create({ data: { number: 'A4-1' } });

  // ── 1. Объявления: отклонённое и отправленное в архив не видно другим ──
  const rejected = await prisma.ad.create({ data: { userId: B.u.id, garageId: g.id, garageNumber: g.number, type: 'SALE', price: 1, description: 'A4 отклонено', status: 'REJECTED', moderatedAt: new Date(), rejectReason: 'нарушение' } });
  let r = await call(B.tok, 'POST', `/ads/${rejected.id}/archive`); ok('автор может убрать отклонённое объявление в архив', r.status === 204, r.status);
  r = await call(A.tok, 'GET', '/ads/archive?pageSize=50'); let j = await json(r);
  ok('отклонённое объявление не попадает в общий архив', !(j.items ?? []).some((x) => x.id === rejected.id), JSON.stringify(j).slice(0, 120));
  r = await call(A.tok, 'GET', `/ads/${rejected.id}`); ok('отклонённое объявление из архива не открывается другим (404)', r.status === 404, r.status);
  const approved = await prisma.ad.create({ data: { userId: B.u.id, garageId: g.id, garageNumber: g.number, type: 'SALE', price: 2, status: 'ARCHIVED', moderatedAt: new Date(), expiresAt: new Date(), archivedAt: new Date() } });
  r = await call(A.tok, 'GET', '/ads/archive?pageSize=50'); j = await json(r);
  ok('опубликованное объявление в архиве видно', (j.items ?? []).some((x) => x.id === approved.id));

  // ── 2. Показания: новый владелец не видит ФИО и телефон того, кто передавал раньше ──
  const reading = await prisma.meterReading.create({ data: { garageId: g.id, userId: B.u.id, value: 100, takenAt: new Date() } });
  await prisma.garageOwner.create({ data: { garageId: g.id, userId: A.u.id } });
  r = await call(A.tok, 'GET', `/meters/${reading.id}`); j = await json(r);
  ok('новый владелец видит показание гаража без данных прежнего владельца', r.status === 200 && j.submittedBy === undefined && j.isMine === false, JSON.stringify(j).slice(0, 160));
  r = await call(A.tok, 'GET', '/meters/my'); j = await json(r);
  ok('в «моих показаниях» нет телефона прежнего владельца', r.status === 200 && !JSON.stringify(j).includes(P(2)), JSON.stringify(j).slice(0, 160));
  await prisma.garageOwner.create({ data: { garageId: g.id, userId: B.u.id } });
  r = await call(B.tok, 'GET', `/meters/${reading.id}`); j = await json(r);
  ok('автор видит себя в своём показании', j?.submittedBy?.phone === P(2) && j.isMine === true, JSON.stringify(j?.submittedBy));

  // ── 3. Контакты: электрик (garages.view без users.view) не видит телефонов и не ищет по ним ──
  r = await call(elec.tok, 'GET', '/garages?q=A4-1'); j = await json(r);
  ok('электрик видит владельцев гаража без телефонов', r.status === 200 && j.items[0]?.owners.length === 2 && !JSON.stringify(j).includes(P(1)), JSON.stringify(j).slice(0, 200));
  r = await call(elec.tok, 'GET', `/garages/${g.id}`); j = await json(r);
  ok('в карточке гаража у электрика нет телефонов', r.status === 200 && !JSON.stringify(j).includes(P(1)) && !JSON.stringify(j).includes(P(2)));
  r = await call(elec.tok, 'GET', `/garages?q=${P(1)}`); j = await json(r);
  ok('электрик не находит гараж по телефону владельца', r.status === 200 && !(j.items ?? []).some((x) => x.id === g.id));
  r = await call(chair.tok, 'GET', `/garages/${g.id}`); j = await json(r);
  ok('председатель видит телефоны владельцев', JSON.stringify(j).includes(P(1)));

  // ── 4. Refresh: атомарная ротация, окно для параллельных запросов, повторное использование отзывает сессию ──
  const login = async (phone) => json(await call(null, 'POST', '/auth/login', { phone, password: PASSWORD, client: 'android' }));
  const refresh = (rt) => call(null, 'POST', '/auth/refresh', { refreshToken: rt });
  const l1 = await login(P(1));
  ok('вход выдаёт refresh (android)', !!l1?.refreshToken, JSON.stringify(l1).slice(0, 80));
  const [p1, p2] = await Promise.all([refresh(l1.refreshToken), refresh(l1.refreshToken)]);
  const [j1, j2] = [await json(p1), await json(p2)];
  const withRt = [j1, j2].filter((x) => x?.refreshToken).length, withAt = [j1, j2].filter((x) => x?.accessToken).length;
  ok('два параллельных refresh: оба успешны, новый refresh выдан ровно один раз', p1.status === 200 && p2.status === 200 && withRt === 1 && withAt === 2, `${p1.status} ${p2.status} rt=${withRt}`);
  const r1 = (j1.refreshToken ?? j2.refreshToken);
  r = await refresh(l1.refreshToken); j = await json(r);
  ok('старый refresh в окне 30 с даёт только access', r.status === 200 && j.accessToken && !j.refreshToken, r.status);
  const ses = await prisma.session.findFirst({ where: { userId: A.u.id, client: 'android' }, orderBy: { createdAt: 'desc' } });
  await prisma.session.update({ where: { id: ses.id }, data: { rotatedAt: new Date(Date.now() - 120_000) } });
  r = await refresh(l1.refreshToken); ok('старый refresh после окна отклонён (401)', r.status === 401, r.status);
  ok('повторное использование отзывает сессию', !!(await prisma.session.findUnique({ where: { id: ses.id } })).revokedAt);
  r = await refresh(r1); ok('после отзыва не работает и новый refresh (401)', r.status === 401, r.status);
  ok('событие auth.refresh.reuse в журнале', !!(await prisma.auditLog.findFirst({ where: { action: 'auth.refresh.reuse', entityId: ses.id } })));

  // ── 5. Удалённый пользователь освобождает номер ──
  const del = await mk(5, 'Житель');
  r = await call(chair.tok, 'DELETE', `/users/${del.u.id}`); ok('председатель удаляет жителя', r.status === 204, r.status);
  r = await call(chair.tok, 'POST', '/users', { phone: P(5), fullName: 'A4 вернулся' });
  j = await json(r); ok('номер удалённого можно выдать новой учётной записи', r.status === 201 && j.id !== del.u.id, `${r.status} ${JSON.stringify(j).slice(0, 100)}`);
  const lgDel = await call(null, 'POST', '/auth/login', { phone: P(5), password: PASSWORD, client: 'pwa' });
  ok('удалённая учётная запись не входит по старому паролю', lgDel.status === 401, lgDel.status);

  // ── 6. Квота загрузок ──
  await prisma.fileAsset.createMany({ data: Array.from({ length: DAILY_UPLOADS.resident }, () => ({ id: randomUUID(), path: 'meter/a4-quota.jpg', mime: 'image/jpeg', size: 1, ownerId: B.u.id, kind: 'meter' })) });
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('not an image')]), 'x.jpg');
  r = await fetch(base + '/api/files?kind=meter', { method: 'POST', headers: { Authorization: 'Bearer ' + B.tok, 'X-Forwarded-For': xff() }, body: fd });
  ok('после суточной квоты загрузка отклоняется (429)', r.status === 429, r.status);

  // ── 7. Карта: одно фото нельзя прикрепить к двум объектам; удалять линии и опоры электрик не может ──
  const mf = await prisma.fileAsset.create({ data: { id: randomUUID(), path: 'map/a4.jpg', mime: 'image/jpeg', size: 1, ownerId: elec.u.id, kind: 'map' } });
  r = await call(elec.tok, 'POST', '/map/poles', { x: 10, y: 10, number: 'A4-1', fileId: mf.id }); j = await json(r);
  ok('электрик ставит опору с фото', r.status === 201, r.status);
  r = await call(elec.tok, 'POST', '/map/marks', { x: 20, y: 20, category: 'OTHER', fileId: mf.id });
  ok('то же фото к пометке не прикрепляется (400)', r.status === 400, r.status);
  r = await call(elec.tok, 'DELETE', `/map/poles/${j.id}`); ok('электрик не удаляет опору (403)', r.status === 403, r.status);
  r = await call(chair.tok, 'DELETE', `/map/poles/${j.id}`); ok('администратор карты удаляет опору', r.status === 204, r.status);

  // ── 8. 2FA: при включении остальные сессии завершаются ──
  const staff = await mk(6, 'Член правления', { totp: false });
  const other = await prisma.session.create({ data: { userId: staff.u.id, refreshHash: randomUUID(), client: 'web-admin', expiresAt: new Date(Date.now() + 3600e3) } });
  const secret = newTotpSecret();
  await prisma.user.update({ where: { id: staff.u.id }, data: { totpSecret: encryptSecret(secret) } });
  r = await call(staff.tok, 'POST', '/auth/2fa/enable', { code: hotp(secret, Math.floor(Date.now() / 30_000)) });
  ok('2FA включена', r.status === 200, r.status);
  ok('другая сессия завершена при включении 2FA', !!(await prisma.session.findUnique({ where: { id: other.id } })).revokedAt);
  ok('текущая сессия осталась', !(await prisma.session.findUnique({ where: { id: staff.sid } })).revokedAt);

  // ── 9. Импорт Excel не меняет данные сотрудника с правами шире, чем у загружающего ──
  const admin = await mk(7, 'Администратор');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Данные');
  ws.addRow(['Гараж', 'ФИО владельца', 'Телефон', 'Email']); ws.addRow(['A4-2', 'Подменённое ФИО', P(7), 'evil@example.com']);
  const xfd = new FormData(); xfd.append('file', new Blob([await wb.xlsx.writeBuffer()]), 'a4.xlsx');
  r = await fetch(base + '/api/import/garages?dryRun=1&updateExisting=1', { method: 'POST', headers: { Authorization: 'Bearer ' + chair.tok, 'X-Forwarded-For': xff() }, body: xfd });
  j = await json(r);
  ok('импорт председателем: данные администратора не обновляются (предупреждение)', r.status === 200 && (j.warnings ?? []).some((w) => w.includes(P(7))) && j.summary?.['Пользователей обновится'] === 0, `${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  void admin;

  await cleanup();
  console.log(fails ? `\nИТОГ: провалено проверок: ${fails}` : '\nИТОГ: все проверки пройдены');
  await app.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
