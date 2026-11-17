import type { AuthUser } from '../audit/audit.service';

/**
 * Телефон и email жителей — личные данные. Сотруднику они нужны, только если он работает с пользователями
 * (право users.view); остальным (например, электрику с правом garages.view) достаточно ФИО.
 */
export const canSeeContacts = (u: AuthUser) => u.portalAccess && u.permissions.includes('users.view');

/** Убирает phone/email из объекта, если контакты сотруднику не положены */
export function maskContacts<T extends { phone?: string; email?: string | null }>(o: T, u: AuthUser): T {
  if (canSeeContacts(u)) return o;
  const { phone: _p, email: _e, ...rest } = o;
  return rest as T;
}
