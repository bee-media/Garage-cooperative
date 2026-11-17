import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../audit/audit.service';
import type { PrismaService } from './prisma.service';

/**
 * Защита от повышения привилегий: сотрудник может управлять только теми пользователями и назначать только те роли,
 * права которых — подмножество его собственных. Иначе держатель «passwords.issue» мог бы выдать пароль администратору
 * и войти под ним, а держатель «users.edit» — назначить себе или другому роль администратора.
 */
const covers = (actor: AuthUser, role: { permissions: string[] }) => role.permissions.every((p) => actor.permissions.includes(p));

export async function assertCanAssignRole(prisma: PrismaService, actor: AuthUser, roleId: number) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new NotFoundException('Роль не найдена');
  if (!covers(actor, role)) throw new ForbiddenException('Нельзя назначить роль с правами больше ваших');
  return role;
}

/**
 * Права роли можно менять и назначать только в пределах собственных: иначе держатель «roles.manage» мог бы дописать
 * любые права своей же роли и стать администратором.
 */
export function assertCanGrant(actor: AuthUser, permissions: string[]) {
  const extra = permissions.filter((p) => !actor.permissions.includes(p));
  if (extra.length) throw new ForbiddenException(`Нельзя выдавать права, которых нет у вас: ${extra.join(', ')}`);
}

/** `self: false` — действие над собой запрещено (выдача пароля себе, блокировка, удаление, сброс 2FA) */
export async function assertCanManage(prisma: PrismaService, actor: AuthUser, targetId: number, opts: { self?: boolean } = {}) {
  if (targetId === actor.id && !opts.self) throw new ForbiddenException('Это действие нельзя выполнить над собственной учётной записью');
  const t = await prisma.user.findFirst({ where: { id: targetId, deletedAt: null }, include: { role: true } });
  if (!t) throw new NotFoundException('Пользователь не найден');
  if (!covers(actor, t.role)) throw new ForbiddenException('Недостаточно прав для действий с этим пользователем');
  return t;
}
