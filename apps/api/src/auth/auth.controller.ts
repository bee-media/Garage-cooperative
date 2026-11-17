import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthUser } from '../audit/audit.service';
import { AuthService, ClientKind } from './auth.service';
import { CurrentUser, NoConsent, NoTwoFactor, Public } from './decorators';

// У каждого браузерного клиента своя cookie: портал и PWA на одном домене не должны делить сессию
const cookieName = (client?: string) => (client === 'pwa' ? 'gsk_rt_pwa' : 'gsk_rt_admin');

class LoginDto {
  @IsString() @MaxLength(30) phone: string;
  @IsString() @MaxLength(128) password: string;
  @IsIn(['web-admin', 'pwa', 'android']) client: ClientKind;
  @IsOptional() @IsString() @MaxLength(100) deviceName?: string;
}

class VerifyDto {
  @IsString() @MaxLength(2000) challengeToken: string;
  /** 6 цифр из приложения или резервный код вида xxxxx-xxxxx */
  @IsString() @MaxLength(32) code: string;
}

class RefreshDto {
  @IsOptional() @IsIn(['web-admin', 'pwa']) client?: 'web-admin' | 'pwa';
  @IsOptional() @IsString() @MaxLength(200) refreshToken?: string;
}

class ProfileDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, v) => v !== '' && v !== null)
  @IsEmail({}, { message: 'Некорректный email' })
  @MaxLength(150)
  email?: string | null;

  @IsOptional() @IsBoolean() pushEnabled?: boolean;
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  private cookieOpts(secure: boolean) {
    return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/api/auth', maxAge: 30 * 86400_000 };
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = await this.auth.login(dto, req);
    if ('twoFactorRequired' in r) return r; // сессии ещё нет: нужен код (POST /auth/2fa/verify)
    return this.deliver(r, dto.client, req, res);
  }

  /** Браузерные клиенты (портал и PWA) получают refresh только в httpOnly-cookie; нативное приложение — в теле ответа */
  private deliver<T extends { refreshToken: string }>(r: T, client: ClientKind, req: Request, res: Response) {
    if (client === 'web-admin' || client === 'pwa') {
      res.cookie(cookieName(client), r.refreshToken, this.cookieOpts(req.secure));
      const { refreshToken, ...rest } = r;
      return rest;
    }
    return r;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('2fa/verify')
  async verify2fa(@Body() dto: VerifyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { client, ...r } = await this.auth.verifyTwoFactor(dto, req);
    return this.deliver(r, client, req, res);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Body() dto: RefreshDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const fromCookie = req.cookies?.[cookieName(dto.client)] as string | undefined;
    const r = await this.auth.refresh(dto.refreshToken ?? fromCookie, req);
    if (!dto.refreshToken && fromCookie) {
      // без нового refresh — cookie уже обновил параллельный ответ, её не трогаем
      if (r.refreshToken) res.cookie(cookieName(dto.client), r.refreshToken, this.cookieOpts(req.secure));
      return { accessToken: r.accessToken };
    }
    return r;
  }

  @NoConsent()
  @NoTwoFactor()
  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentUser() u: AuthUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(u, req);
    res.clearCookie('gsk_rt_admin', { path: '/api/auth' });
    res.clearCookie('gsk_rt_pwa', { path: '/api/auth' });
  }

  @NoConsent()
  @NoTwoFactor()
  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.auth.me(u);
  }

  @Patch('me')
  updateProfile(@CurrentUser() u: AuthUser, @Body() dto: ProfileDto, @Req() req: Request) {
    return this.auth.updateProfile(u, dto, req);
  }

  @NoConsent()
  @NoTwoFactor()
  @HttpCode(200)
  @Post('consent')
  consent(@CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.auth.acceptConsent(u, req);
  }

  @Get('sessions')
  sessions(@CurrentUser() u: AuthUser) {
    return this.auth.sessions(u);
  }

  @HttpCode(204)
  @Delete('sessions/:id')
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return this.auth.revokeSession(u, id, req);
  }

  @HttpCode(200)
  @Post('sessions/revoke-others')
  revokeOthers(@CurrentUser() u: AuthUser, @Req() req: Request) {
    return this.auth.revokeOthers(u, req);
  }
}
