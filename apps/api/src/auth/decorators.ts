import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser } from '../audit/audit.service';
import type { Permission } from '../common/permissions';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const NO_CONSENT = 'noConsent';
/** Доступно до принятия согласия на обработку ПДн */
export const NoConsent = () => SetMetadata(NO_CONSENT, true);

export const PERMS = 'perms';
/** Нужны ВСЕ перечисленные права */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(PERMS, p);

export const PORTAL_ONLY = 'portalOnly';
/** Только сотрудники с доступом в веб-портал */
export const PortalOnly = () => SetMetadata(PORTAL_ONLY, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);

export const NO_2FA = 'noTwoFactor';
/** Доступно сотруднику, который ещё не настроил 2FA (чтобы он мог её настроить, выйти и т.п.) */
export const NoTwoFactor = () => SetMetadata(NO_2FA, true);