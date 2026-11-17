import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base32Decode, base32Encode, decryptSecret, encryptSecret, generateBackupCodes, hashBackupCode, hotp,
  looksLikeBackupCode, newTotpSecret, normalizeBackupCode, verifyTotp,
} from '../src/auth/totp';

process.env.TOTP_ENC_KEY = 'test-key-test-key-test-key-test-key-1234';

// Тестовые векторы RFC 6238 (SHA-1, секрет «12345678901234567890»)
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC = [
  { t: 59, code: '287082' }, { t: 1111111109, code: '081804' }, { t: 1111111111, code: '050471' },
  { t: 1234567890, code: '005924' }, { t: 2000000000, code: '279037' },
];

test('base32 туда и обратно', () => {
  const b = Buffer.from('hello world 123');
  assert.deepEqual(base32Decode(base32Encode(b)), b);
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('hotp совпадает с векторами RFC 6238', () => {
  for (const v of RFC) assert.equal(hotp(RFC_SECRET, Math.floor(v.t / 30)), v.code);
});

test('verifyTotp принимает код текущего шага и соседних, отклоняет остальные', () => {
  const now = 1234567890_000;
  const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), null, now), step);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), null, now), step - 1);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), null, now), step + 1);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 2), null, now), null);
  assert.equal(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), null, now), null);
  assert.equal(verifyTotp(RFC_SECRET, '12345', null, now), null);
  assert.equal(verifyTotp(RFC_SECRET, 'abcdef', null, now), null);
});

test('один и тот же код нельзя использовать дважды', () => {
  const now = 1234567890_000;
  const step = Math.floor(now / 30_000);
  const code = hotp(RFC_SECRET, step);
  assert.equal(verifyTotp(RFC_SECRET, code, step, now), null); // уже использован этот шаг
  assert.equal(verifyTotp(RFC_SECRET, code, step - 1, now), step);
});

test('секрет шифруется и расшифровывается, подмена ломает проверку', () => {
  const s = newTotpSecret();
  const enc = encryptSecret(s);
  assert.notEqual(enc, s);
  assert.equal(decryptSecret(enc), s);
  const parts = enc.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.')));
});

test('резервные коды: формат, уникальность, нормализация', () => {
  const codes = generateBackupCodes(10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
    assert.ok(looksLikeBackupCode(c));
    assert.equal(hashBackupCode(c), hashBackupCode(c.toUpperCase().replace('-', ' ')));
  }
  assert.equal(normalizeBackupCode(' AbC-De fgh1 '), 'abcdefgh1');
  assert.ok(!looksLikeBackupCode('123456'));
});
