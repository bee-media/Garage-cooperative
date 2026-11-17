// ВНИМАНИЕ: создаёт и удаляет записи в БД — запускать ТОЛЬКО на базе разработки (apps/api/.env), из папки apps/api: npm run test:security
// Матрица прав: каждый маршрут API вызывается от имени разных ролей; сверяем с @RequirePermissions
require('dotenv').config({ quiet: true });
process.env.NODE_ENV = 'development';
const { NestFactory, ModulesContainer } = require('@nestjs/core');
const { Reflector } = require('@nestjs/core');
const { ValidationPipe } = require('@nestjs/common');
const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
const { JwtService } = require('@nestjs/jwt');
const cookieParser = require('cookie-parser');
const { AppModule } = require('../../dist/app.module');
const { PrismaService } = require('../../dist/common/prisma.service');
const { hashPassword } = require('../../dist/common/password');
const { randomUUID } = require('node:crypto');

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const UUID = '11111111-1111-4111-8111-111111111111';

(async () => {
  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const prisma = app.get(PrismaService), jwt = app.get(JwtService), reflector = app.get(Reflector);

  // ── пользователи по ролям ──
  const roleNames = ['Житель', 'Электрик', 'Член правления', 'Бухгалтер', 'Председатель'];
  const actors = [];
  const hash = await hashPassword('Xx123456abc');
  for (const [i, name] of roleNames.entries()) {
    const role = await prisma.role.findUnique({ where: { name } });
    const phone = `99955500${String(i).padStart(2, '0')}`;
    const u = await prisma.user.upsert({ where: { phone }, update: { roleId: role.id, totpEnabled: true, consentAt: new Date(), deletedAt: null, lockedAt: null, isBlocked: false }, create: { phone, roleId: role.id, passwordHash: hash, totpEnabled: true, consentAt: new Date(), fullName: 'RBAC ' + name } });
    const s = await prisma.session.create({ data: { userId: u.id, refreshHash: randomUUID(), client: 'pwa', expiresAt: new Date(Date.now() + 3600e3) } });
    actors.push({ name, perms: role.permissions, portal: role.portalAccess, token: await jwt.signAsync({ sub: u.id, sid: s.id }), userId: u.id });
  }
  actors.unshift({ name: '(без входа)', perms: [], portal: false, token: null });

  // ── список маршрутов ──
  const routes = [];
  for (const mod of app.get(ModulesContainer).values()) {
    for (const [, w] of mod.controllers) {
      const inst = w.instance; if (!inst) continue;
      const proto = Object.getPrototypeOf(inst);
      const ctlPath = Reflect.getMetadata(PATH_METADATA, w.metatype) ?? '';
      for (const key of Object.getOwnPropertyNames(proto)) {
        const fn = proto[key]; if (typeof fn !== 'function' || key === 'constructor') continue;
        const m = Reflect.getMetadata(METHOD_METADATA, fn); if (m === undefined) continue;
        const p = Reflect.getMetadata(PATH_METADATA, fn) ?? '';
        const method = METHODS[m];
        const targets = [fn, w.metatype];
        routes.push({
          method, ctl: w.metatype.name, key,
          path: ('/api/' + [].concat(ctlPath).join('/') + '/' + [].concat(p).join('/')).replace(/\/+/g, '/').replace(/\/$/, ''),
          isPublic: !!reflector.getAllAndOverride('isPublic', targets),
          perms: reflector.getAllAndOverride('perms', targets) ?? [],
          portalOnly: !!reflector.getAllAndOverride('portalOnly', targets),
        });
      }
    }
  }

  const fill = (p) => p.replace(/:(\w+)(\.\w+)?/g, (_, n, ext) => (/id$/i.test(n) && !/^(userId|id)$/.test(n) ? '1' : n === 'id' ? '1' : n === 'userId' ? '1' : n === 'kind' ? 'garages' : '1') + (ext ?? ''));
  let n = 0, bad = 0; const issues = [];
  for (const r of routes) {
    if (r.method === 'ALL' || r.method === 'OPTIONS' || r.method === 'HEAD') continue;
    let url = fill(r.path);
    if (/\/files\/1/.test(url) || /\/files\/1\/link/.test(url)) url = url.replace('/files/1', '/files/' + UUID);
    if (r.path === '/api/auth/logout') continue;
    for (const a of actors) {
      const hasNow = a.token && r.perms.every((p) => a.perms.includes(p)) && (r.perms.length === 0 || a.portal);
      // изменяющие запросы выполняем только когда доступа быть НЕ должно (проверяем отказ); с правами — только чтение
      if (r.method !== 'GET' && (r.isPublic || hasNow)) continue;
      n++;
      const res = await fetch(base + url + (r.method === 'GET' ? '' : ''), {
        method: r.method, redirect: 'manual',
        headers: { 'X-Forwarded-For': `10.${(n >> 8) & 255}.${n & 255}.1`, 'Content-Type': 'application/json', ...(a.token ? { Authorization: 'Bearer ' + a.token } : {}) },
        body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) ? '{}' : undefined,
      }).catch((e) => ({ status: 0, err: e.message }));
      const st = res.status;
      const has = r.perms.every((p) => a.perms.includes(p)) && (r.perms.length === 0 || a.portal);
      let verdict = null;
      if (!r.isPublic && !a.token) { if (st !== 401) verdict = `ожидался 401, получен ${st}`; }
      else if (!r.isPublic && r.perms.length && !has) { if (st !== 403) verdict = `нет прав (${r.perms}), ожидался 403, получен ${st}`; }
      else if (!r.isPublic && r.portalOnly && !a.portal) { if (st !== 403) verdict = `portalOnly, получен ${st}`; }
      else if (a.token && r.perms.length && has && (st === 401 || st === 403)) verdict = `права есть, но ${st}`;
      if (st === 500) verdict = (verdict ? verdict + '; ' : '') + '500';
      if (st === 429) verdict = '429 (троттлинг мешает проверке)';
      if (verdict) { bad++; issues.push(`${a.name} ${r.method} ${r.path} [${r.ctl}.${r.key}] → ${verdict}`); }
    }
  }
  const pub = routes.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`);
  console.log(`маршрутов: ${routes.length}, проверок: ${n}, нарушений: ${bad}`);
  console.log('публичные маршруты:', pub.join(' | '));
  const noPerm = routes.filter((r) => !r.isPublic && !r.perms.length).map((r) => `${r.method} ${r.path}`);
  console.log('доступны любому вошедшему (без @RequirePermissions):\n  ' + noPerm.join('\n  '));
  issues.slice(0, 60).forEach((i) => console.log('ISSUE', i));

  // уборка
  for (const a of actors.filter((x) => x.userId)) { await prisma.session.deleteMany({ where: { userId: a.userId } }); await prisma.auditLog.deleteMany({ where: { actorId: a.userId } }); await prisma.user.delete({ where: { id: a.userId } }).catch(() => {}); }
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
