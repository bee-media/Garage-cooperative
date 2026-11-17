import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { assertSafeZip } from '../src/excel/excel.io';
import { isPushServiceUrl } from '../src/common/push-url';
import { maskContacts } from '../src/common/contacts';

// ───── Web Push: SSRF ─────

test('push: допустимы только адреса известных push-сервисов', () => {
  assert.ok(isPushServiceUrl('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(isPushServiceUrl('https://updates.push.services.mozilla.com/wpush/v2/xyz'));
  assert.ok(isPushServiceUrl('https://web.push.apple.com/QWER'));
  assert.ok(isPushServiceUrl('https://wns2-par02p.notify.windows.com/w/?token=1'));
});

test('push: внутренние и поддельные адреса отклоняются', () => {
  for (const bad of [
    'http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest/meta-data',
    'https://evil.example.com/', 'https://fcm.googleapis.com.evil.com/', 'https://evilgoogleapis.com/', 'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com:8443/x', 'ftp://fcm.googleapis.com/', 'not a url', '', undefined, 42, 'https://' + 'a'.repeat(2000) + '.googleapis.com/',
    // другие API Google на том же домене — не push-сервис
    'https://storage.googleapis.com/bucket/x', 'https://www.googleapis.com/upload/x', 'https://x.fcm.googleapis.com/',
  ]) assert.equal(isPushServiceUrl(bad as any), false, String(bad).slice(0, 60));
});

// ───── контакты жителей ─────

test('контакты: телефон и email видит только сотрудник с правом users.view', () => {
  const who = (portalAccess: boolean, permissions: string[]) => ({ portalAccess, permissions }) as any;
  const owner = { id: 1, fullName: 'Иванов', phone: '9091112277', email: 'a@b.ru' };
  assert.deepEqual(maskContacts(owner, who(true, ['garages.view', 'users.view'])), owner);
  assert.deepEqual(maskContacts(owner, who(true, ['garages.view'])), { id: 1, fullName: 'Иванов' });
  assert.deepEqual(maskContacts(owner, who(false, ['users.view'])), { id: 1, fullName: 'Иванов' });
});

// ───── Excel: «zip-бомба» ─────

/** Минимальный zip с одним файлом; `claimed` — заявленный несжатый размер */
function zip(data: Buffer, claimed = data.length): Buffer {
  const comp = deflateRawSync(data);
  const name = Buffer.from('a.xml');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(claimed, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(claimed, 24); central.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, comp]);
  const cd = Buffer.concat([central, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, end]);
}

test('zip: обычный маленький архив проходит', () => {
  assertSafeZip(zip(Buffer.from('<xml/>')));
});

test('zip: заявленный гигантский размер отклоняется', () => {
  assert.throws(() => assertSafeZip(zip(Buffer.from('<xml/>'), 2 * 1024 ** 3)), /слишком велик/);
});

test('zip: не-архив и обрезанный архив отклоняются', () => {
  assert.throws(() => assertSafeZip(Buffer.from('просто текст, не архив, нужно больше двадцати двух байт')));
  assert.throws(() => assertSafeZip(zip(Buffer.from('x')).subarray(0, 40)));
  assert.throws(() => assertSafeZip(Buffer.alloc(5)));
});

// ───── роли: нельзя выдать больше своих прав ─────

import { assertCanGrant } from '../src/common/hierarchy';

test('роли: выдавать можно только свои права', () => {
  const actor = { permissions: ['users.view', 'roles.manage'] } as any;
  assertCanGrant(actor, ['users.view']);
  assertCanGrant(actor, []);
  assert.throws(() => assertCanGrant(actor, ['users.view', 'passwords.issue']), /passwords\.issue/);
  assert.throws(() => assertCanGrant(actor, ['map.edit', 'charges.edit']), /Нельзя выдавать/);
});

// ───── слияние DTO ─────

import { defined } from '../src/common/defined';

test('defined: убирает undefined, сохраняет остальное (в т.ч. null, 0, false, пустой массив)', () => {
  const dto = { label: 'A', numbers: undefined, depth: 0, flag: false, note: null, list: [] as string[] };
  assert.deepEqual({ numbers: ['1', '2'], x1: 1, ...defined(dto) }, { numbers: ['1', '2'], x1: 1, label: 'A', depth: 0, flag: false, note: null, list: [] });
});
