import { randomInt } from 'node:crypto';
import * as argon2 from 'argon2';

// Без похожих символов: 0 O o 1 l I
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const ALL = UPPER + LOWER + DIGITS;

const pick = (s: string) => s[randomInt(s.length)];

/** 10 символов: гарантированно есть верхний и нижний регистр и цифра. */
export function generatePassword(length = 10): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

const OPTS: argon2.Options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (p: string) => argon2.hash(p, OPTS);
export const verifyPassword = (hash: string, p: string) => argon2.verify(hash, p).catch(() => false);

// Для выравнивания времени ответа, когда пользователь не найден
let dummy: Promise<string> | null = null;
export async function dummyVerify(p: string) {
  dummy ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummy, p);
}
