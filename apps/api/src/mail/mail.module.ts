import { Body, Controller, Get, Global, HttpCode, Injectable, Logger, Module, Post, Query, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Request } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as nodemailer from 'nodemailer';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../common/prisma.service';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  kind: 'receipt' | 'payment-receipt' | 'test';
  garageId?: number;
  paymentId?: number;
  sentById?: number;
}

/**
 * Отправка почты. Параметры SMTP — в окружении (SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM).
 * Если SMTP_HOST не задан, письма не отправляются, а сохраняются как .eml-файлы в STORAGE_DIR/mail-outbox (тестовый стенд).
 * Каждая попытка пишется в журнал MailLog.
 */
@Injectable()
export class MailService {
  private log = new Logger('Mail');
  private transport: nodemailer.Transporter | null = null;
  readonly host: string | undefined;
  readonly from: string;

  constructor(private cfg: ConfigService, private prisma: PrismaService) {
    this.host = this.cfg.get<string>('SMTP_HOST')?.trim() || undefined;
    this.from = this.cfg.get<string>('SMTP_FROM')?.trim() || 'ГСК «Родник» <no-reply@localhost>';
    if (this.host) {
      const port = Number(this.cfg.get('SMTP_PORT') ?? 587);
      const secure = (this.cfg.get('SMTP_SECURE') ?? (port === 465 ? '1' : '0')) === '1';
      const user = this.cfg.get<string>('SMTP_USER');
      this.transport = nodemailer.createTransport({
        host: this.host, port, secure,
        auth: user ? { user, pass: this.cfg.get<string>('SMTP_PASS') } : undefined,
        // таймауты, чтобы «зависший» почтовый сервер не вешал запросы
        connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
        requireTLS: !secure && this.cfg.get('SMTP_REQUIRE_TLS') === '1',
      });
    }
  }

  status() {
    return { configured: !!this.host, dryRun: !this.host, host: this.host ?? null, from: this.from };
  }

  /** Отправляет письмо; ошибка не выбрасывается, результат — в возвращаемом значении и в журнале */
  async send(m: OutgoingMail): Promise<{ ok: boolean; status: 'sent' | 'failed' | 'dry-run'; error?: string }> {
    const message = { from: this.from, to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments };
    let status: 'sent' | 'failed' | 'dry-run' = 'sent';
    let error: string | undefined;
    try {
      if (this.transport) {
        await this.transport.sendMail(message);
      } else {
        status = 'dry-run';
        const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' }).sendMail(message);
        const dir = path.resolve(this.cfg.get<string>('STORAGE_DIR') ?? './storage', 'mail-outbox');
        await mkdir(dir, { recursive: true });
        const safe = m.to.replace(/[^a-z0-9@._-]/gi, '_');
        await writeFile(path.join(dir, `${Date.now()}-${safe}.eml`), built.message as Buffer);
        this.log.log(`[DRY-RUN] письмо "${m.subject}" → ${m.to}`);
      }
    } catch (e: any) {
      status = 'failed';
      error = String(e?.message ?? e).slice(0, 500);
      this.log.warn(`Не удалось отправить на ${m.to}: ${error}`);
    }
    await this.prisma.mailLog.create({
      data: { toAddr: m.to, subject: m.subject.slice(0, 200), kind: m.kind, status, error, garageId: m.garageId, paymentId: m.paymentId, sentById: m.sentById },
    }).catch(() => undefined);
    return { ok: status !== 'failed', status, error };
  }
}

class TestDto {
  @IsEmail() to: string;
}

class LogQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number;
}

@Controller('mail')
class MailController {
  constructor(private mail: MailService, private prisma: PrismaService, private audit: AuditService) {}

  @Get('status') @RequirePermissions('settings.finance')
  status() { return this.mail.status(); }

  @Post('test') @HttpCode(200) @RequirePermissions('settings.finance')
  async test(@Body() dto: TestDto, @CurrentUser() u: AuthUser, @Req() req: Request) {
    const r = await this.mail.send({
      to: dto.to, kind: 'test', sentById: u.id, subject: 'Проверка почты ГСК «Родник»',
      text: 'Если вы читаете это письмо, отправка почты из системы ГСК «Родник» настроена правильно.',
    });
    await this.audit.log({ action: 'mail.test', after: { to: dto.to, status: r.status } }, req);
    return r;
  }

  @Get('log') @RequirePermissions('settings.finance')
  async log(@Query() q: LogQuery) {
    const page = q.page ?? 1, size = q.pageSize ?? 50;
    const [total, items] = await Promise.all([
      this.prisma.mailLog.count(),
      this.prisma.mailLog.findMany({ orderBy: { id: 'desc' }, skip: (page - 1) * size, take: size }),
    ]);
    return { total, page, pageSize: size, items };
  }
}

@Global()
@Module({ controllers: [MailController], providers: [MailService], exports: [MailService] })
export class MailModule {}
