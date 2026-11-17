// TOTP по RFC 6238 (HMAC-SHA1, 6 цифр, шаг 30 с) — совместим с Google Authenticator, Яндекс Ключом,
// Microsoft Authenticator, Aegis, 2FAS и др. Без внешних зависимостей.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('bad base32');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** Новый секрет: 160 бит */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secretB32: string, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

const safeEq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Проверка кода. Допускается отклонение часов ±1 шаг (±30 с).
 * Возвращает номер принятого шага или null. Шаги ≤ lastStep отклоняются: один и тот же код нельзя использовать дважды.
 */
export function verifyTotp(secretB32: string, code: string, lastStep?: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  let accepted: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    // перебираем все три окна без раннего выхода: время проверки не зависит от того, какое окно подошло
    if (safeEq(hotp(secretB32, s), code) && (lastStep == null || s > lastStep) && accepted === null) accepted = s;
  }
  return accepted;
}

export function otpauthUrl(secret: string, account: string, issuer = 'ГСК Родник'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ───────── Шифрование секрета в базе (AES-256-GCM) ─────────

let warned = false;
function encKey(): Buffer {
  const k = process.env.TOTP_ENC_KEY;
  if (k && k.length >= 32) return createHash('sha256').update(k).digest();
  if (process.env.NODE_ENV === 'production') throw new Error('TOTP_ENC_KEY не задан (минимум 32 символа)');
  if (!warned) { warned = true; console.warn('[2FA] TOTP_ENC_KEY не задан: используется ключ разработки'); }
  return createHash('sha256').update('dev-only-totp-key:' + (process.env.JWT_ACCESS_SECRET ?? '')).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1') throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

// ───────── Резервные коды ─────────

// без похожих символов: 0 o 1 l i
const BC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateBackupCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const part = () => Array.from({ length: 5 }, () => BC_ALPHABET[randomInt(BC_ALPHABET.length)]).join('');
    return `${part()}-${part()}`;
  });
}

export const normalizeBackupCode = (s: string) => s.toLowerCase().replace(/[\s-]/g, '');
export const looksLikeBackupCode = (s: string) => normalizeBackupCode(s).length === 10 && /^[a-z0-9]+$/.test(normalizeBackupCode(s));

export function hashBackupCode(code: string): string {
  return createHmac('sha256', encKey()).update(normalizeBackupCode(code)).digest('hex');
}
