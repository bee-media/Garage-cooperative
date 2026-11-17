import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Prisma } from '@prisma/client';
import { computePenalties, mskMonthStart, period, type PenaltyInput } from '../src/finance/finance.service';

const D = (v: number) => new Prisma.Decimal(v);
const DAY = 86400_000;
const now = new Date('2026-10-17T12:00:00Z');
const base = (over: Partial<PenaltyInput>): PenaltyInput => ({
  charges: [], paid: new Map(), penaltySum: new Map(), lastRun: null, now,
  ratePerDayPercent: 0.1, graceDays: 30, capPercent: 100, ...over,
});
const charge = (amount: number, daysAgo: number, garageId = 1, type: 'ELECTRICITY' | 'MEMBERSHIP' = 'MEMBERSHIP') =>
  ({ garageId, type, amount: D(amount), createdAt: new Date(now.getTime() - daysAgo * DAY) });

// ───── пеня ─────

test('пеня: просроченный неоплаченный взнос — 0.1% в день после льготного срока', () => {
  const rows = computePenalties(base({ charges: [charge(1000, 40)] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount.toNumber(), 10); // 1000 × 0.1% × 10 дней
});

test('пеня: корректировка (отрицательное начисление) гасит долг — пени нет', () => {
  // ошибочный взнос 1000 исправлен начислением −1000 через 5 дней: баланс 0, пеня не начисляется
  const rows = computePenalties(base({ charges: [charge(1000, 40), charge(-1000, 35)] }));
  assert.deepEqual(rows, []);
});

test('пеня: частичная корректировка уменьшает просроченную сумму', () => {
  const rows = computePenalties(base({ charges: [charge(1000, 40), charge(-400, 35)] }));
  assert.equal(rows[0].amount.toNumber(), 6); // 600 × 0.1% × 10
});

test('пеня: корректировка другого вида или другого гаража не гасит долг', () => {
  const rows = computePenalties(base({ charges: [charge(1000, 40), charge(-1000, 35, 1, 'ELECTRICITY'), charge(-1000, 35, 2)] }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount.toNumber(), 10);
});

test('пеня: оплата гасит самые старые начисления, потолок учитывает уже начисленную пеню', () => {
  const paid = new Map([['1:MEMBERSHIP', D(1000)]]);
  assert.deepEqual(computePenalties(base({ charges: [charge(1000, 40)], paid })), []);
  const capped = computePenalties(base({ charges: [charge(1000, 400)], capPercent: 10, penaltySum: new Map([[1, D(95)]]) }));
  assert.equal(capped[0].amount.toNumber(), 5); // потолок 100, уже 95
});

// ───── московское время ─────

test('период взноса и начало месяца считаются по Москве', () => {
  const newYearMsk = new Date('2025-12-31T22:30:00Z'); // 01:30 1 января по Москве
  assert.equal(period(newYearMsk, 'year'), '2026');
  assert.equal(period(newYearMsk, 'quarter'), '2026-Q1');
  assert.equal(period(new Date('2026-03-31T20:59:00Z'), 'quarter'), '2026-Q1'); // 23:59 МСК
  assert.equal(period(new Date('2026-03-31T21:00:00Z'), 'quarter'), '2026-Q2'); // 00:00 МСК 1 апреля
  assert.equal(mskMonthStart(new Date('2026-10-31T22:00:00Z')).toISOString(), '2026-10-31T21:00:00.000Z'); // уже 1 ноября МСК
});
