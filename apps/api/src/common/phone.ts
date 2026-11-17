// Телефон хранится и сравнивается как 10 цифр (без 8/+7). Показ: 909-111-22-77.
export function normalizePhone(input: string): string | null {
  const digits = (input ?? '').replace(/[\s\-()+]/g, '');
  return /^\d{10}$/.test(digits) ? digits : null;
}

export function formatPhone(p: string): string {
  return `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6, 8)}-${p.slice(8, 10)}`;
}
