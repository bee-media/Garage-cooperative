import {
  BadRequestException, Body, Controller, Get, HttpCode, Injectable, Logger, Module, NotFoundException, OnModuleInit,
  Param, ParseIntPipe, Post, Put, Query, Req, Res,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { Request, Response } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { appEvents, PaymentCreatedEvent } from '../common/events';
import { PrismaService } from '../common/prisma.service';
import { mskParts } from '../common/time';
import { FinanceModule } from '../finance/finance.module';
import { FinanceService } from '../finance/finance.service';
import { MailService } from '../mail/mail.module';
import {
  billingContent, BillingData, DEFAULT_RECEIPT, money, paymentContent, PaymentData, ReceiptSettings, renderPdf,
} from './receipts.pdf';

const TYPE_LABEL: Record<string, string> = { ELECTRICITY: 'Электроэнергия', MEMBERSHIP: 'Членские взносы', PENALTY: 'Пеня' };
const METHOD_LABEL: Record<string, string> = { cash: 'Наличные', card: 'Банковская карта', transfer: 'Перевод' };

class SettingsDto implements ReceiptSettings {
  @IsString() @MaxLength(150) orgName: string;
  @IsString() @MaxLength(250) orgAddress: string;
  @IsString() @MaxLength(60) phone: string;
  @IsString() @MaxLength(12) inn: string;
  @IsString() @MaxLength(9) kpp: string;
  @IsString() @MaxLength(20) account: string;
  @IsString() @MaxLength(150) bankName: string;
  @IsString() @MaxLength(9) bik: string;
  @IsString() @MaxLength(20) corrAccount: string;
  @IsString() @MaxLength(600) headerNote: string;
  @IsString() @MaxLength(600) footerNote: string;
  @IsString() @MaxLength(250) purposeTemplate: string;
  @IsString() @MaxLength(80) signerPosition: string;
  @IsString() @MaxLength(80) signerName: string;
  @IsBoolean() showQr: boolean;
  @IsBoolean() autoEmailPayments: boolean;
}

class DebtsQuery {
  @IsOptional() @IsIn(['RED', 'ORANGE']) color?: 'RED' | 'ORANGE';
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minDebt?: number;
}

class SendDebtsDto {
  @IsOptional() @IsBoolean() dryRun?: boolean;
  @IsOptional() @IsIn(['RED', 'ORANGE']) color?: 'RED' | 'ORANGE';
  @IsOptional() @IsInt() @Min(0) minDebt?: number;
}

@Injectable()
export class ReceiptsService implements OnModuleInit {
  private log = new Logger('Receipts');

  constructor(private prisma: PrismaService, private finance: FinanceService, private mail: MailService, private audit: AuditService) {}

  onModuleInit() {
    // Автоотправка чека на почту владельцам при внесении оплаты (если включено в шаблоне)
    appEvents.on('payment.created', (e: PaymentCreatedEvent) => {
      void this.autoSend(e).catch((err) => this.log.warn(`автоотправка чека: ${err?.message}`));
    });
  }

  private async autoSend(e: PaymentCreatedEvent) {
    if (!(await this.settings()).autoEmailPayments) return;
    await this.sendPayment(e.paymentId, e.actorId, undefined);
  }

  // ───────── шаблон ─────────

  async settings(): Promise<ReceiptSettings> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'receipt' } });
    return { ...DEFAULT_RECEIPT, ...((row?.value as Partial<ReceiptSettings>) ?? {}) };
  }

  async setSettings(dto: ReceiptSettings, req: Request) {
    const before = await this.settings();
    await this.prisma.setting.upsert({ where: { key: 'receipt' }, update: { value: dto as any }, create: { key: 'receipt', value: dto as any } });
    await this.audit.log({ action: 'receipt.settings', entity: 'Setting', entityId: 'receipt', before, after: dto }, req);
    return dto;
  }

  // ───────── данные ─────────

  private async owners(garageId: number) {
    const rows = await this.prisma.garageOwner.findMany({
      where: { garageId, toDate: null, user: { deletedAt: null } },
      include: { user: { select: { id: true, fullName: true, phone: true, email: true } } },
    });
    return rows.map((r) => ({ id: r.user.id, name: r.user.fullName ?? r.user.phone, email: r.user.email }));
  }

  private today() {
    const m = mskParts();
    return `${String(m.day).padStart(2, '0')}.${String(m.month).padStart(2, '0')}.${m.year}`;
  }

  private async billingData(garageId: number): Promise<BillingData> {
    const g = await this.prisma.garage.findUnique({ where: { id: garageId } });
    if (!g) throw new NotFoundException('Гараж не найден');
    const [owners, bal] = await Promise.all([this.owners(garageId), this.finance.balances([garageId])]);
    const b = bal.get(garageId)!;
    return {
      garageNumber: g.number, owners: owners.map((o) => o.name),
      electricity: Math.max(b.electricity, 0), membership: Math.max(b.membership, 0), penalty: Math.max(b.penalty, 0),
      total: b.total, advance: b.advance, dateMsk: this.today(),
    };
  }

  private async paymentData(paymentId: number): Promise<{ data: PaymentData; garageId: number }> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId }, include: { garage: true } });
    if (!p) throw new NotFoundException('Оплата не найдена');
    const [owners, bal, by] = await Promise.all([
      this.owners(p.garageId), this.finance.balances([p.garageId]),
      this.prisma.user.findUnique({ where: { id: p.receivedById }, select: { fullName: true, phone: true } }),
    ]);
    const b = bal.get(p.garageId)!;
    const rem = p.type === 'ELECTRICITY' ? b.electricity : p.type === 'MEMBERSHIP' ? b.membership : b.penalty;
    const d = mskParts(p.paidAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      garageId: p.garageId,
      data: {
        id: p.id, garageNumber: p.garage.number, owners: owners.map((o) => o.name), typeLabel: TYPE_LABEL[p.type] ?? p.type,
        amount: p.amount.toNumber(), method: METHOD_LABEL[p.method] ?? p.method, comment: p.comment,
        paidAtMsk: `${pad(d.day)}.${pad(d.month)}.${d.year} ${pad(d.hour)}:${pad(d.minute)}`,
        receivedBy: by?.fullName ?? by?.phone ?? '—', voided: !!p.voidedAt,
        remaining: { label: `Остаток по виду «${TYPE_LABEL[p.type]}»`, value: rem },
      },
    };
  }

  // ───────── PDF ─────────

  async billingPdf(garageId: number) {
    const s = await this.settings();
    return renderPdf([billingContent(s, await this.billingData(garageId))], 'Квитанция на оплату');
  }

  async paymentPdf(paymentId: number) {
    const s = await this.settings();
    return renderPdf([paymentContent(s, (await this.paymentData(paymentId)).data)], `Квитанция об оплате № ${paymentId}`);
  }

  private async debtorIds(q: { color?: 'RED' | 'ORANGE'; minDebt?: number }) {
    const d = await this.finance.debts({ color: q.color, pageSize: 1000, sort: 'number' });
    return d.items.filter((r: any) => r.total > (q.minDebt ?? 0)).map((r: any) => r.garageId as number);
  }

  async debtsPdf(q: { color?: 'RED' | 'ORANGE'; minDebt?: number }) {
    const ids = await this.debtorIds(q);
    if (!ids.length) throw new BadRequestException('Нет гаражей с задолженностью по выбранным условиям');
    const s = await this.settings();
    const pages = [] as any[][];
    for (const id of ids) pages.push(billingContent(s, await this.billingData(id)));
    return { pdf: await renderPdf(pages, 'Квитанции на оплату'), count: ids.length };
  }

  /** Пробный документ для предпросмотра шаблона: настоящие данные первого гаража с владельцем или образец */
  async previewPdf(kind: 'billing' | 'payment') {
    const s = await this.settings();
    if (kind === 'billing') {
      const g = await this.prisma.garage.findFirst({ where: { status: 'ACTIVE', owners: { some: { toDate: null } } }, orderBy: { id: 'asc' } });
      const data = g ? await this.billingData(g.id) : { garageNumber: '17', owners: ['Иванов Иван Иванович'], electricity: 1250.5, membership: 3000, penalty: 45.2, total: 4295.7, advance: 0, dateMsk: this.today() };
      return renderPdf([billingContent(s, data)], 'Образец квитанции');
    }
    const p = await this.prisma.payment.findFirst({ orderBy: { id: 'desc' } });
    if (p) return renderPdf([paymentContent(s, (await this.paymentData(p.id)).data)], 'Образец чека');
    return renderPdf([paymentContent(s, {
      id: 1, garageNumber: '17', owners: ['Иванов Иван Иванович'], typeLabel: 'Членские взносы', amount: 3000, method: 'Наличные', comment: null,
      paidAtMsk: `${this.today()} 12:00`, receivedBy: 'Сидорова А.А.', voided: false, remaining: { label: 'Остаток по виду «Членские взносы»', value: 0 },
    })], 'Образец чека');
  }

  // ───────── отправка на почту ─────────

  private noEmail() {
    return { sent: 0, failed: 0, recipients: [] as any[], note: 'Ни у одного владельца не указана электронная почта' };
  }

  async sendGarage(garageId: number, u: AuthUser, req: Request) {
    const [owners, data, pdf] = await Promise.all([this.owners(garageId), this.billingData(garageId), this.billingPdf(garageId)]);
    const withMail = owners.filter((o) => o.email);
    if (!withMail.length) return this.noEmail();
    const s = await this.settings();
    const res = [];
    for (const o of withMail) {
      const r = await this.mail.send({
        to: o.email!, kind: 'receipt', garageId, sentById: u.id,
        subject: `Квитанция на оплату — гараж №${data.garageNumber}`,
        text: this.billingText(o.name, data, s),
        attachments: [{ filename: `kvitanciya-garazh-${data.garageNumber}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
      res.push({ email: o.email, name: o.name, ...r });
    }
    const out = { sent: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok).length, recipients: res };
    await this.audit.log({ action: 'receipt.send', entity: 'Garage', entityId: garageId, after: { sent: out.sent, failed: out.failed } }, req);
    return out;
  }

  private billingText(name: string, d: BillingData, s: ReceiptSettings) {
    const lines = [`Здравствуйте, ${name}!`, '', d.total > 0
      ? `Направляем квитанцию на оплату по гаражу №${d.garageNumber}. Сумма к оплате: ${money(d.total)} руб.`
      : `Направляем квитанцию по гаражу №${d.garageNumber}. Задолженности нет.`, '', 'Квитанция во вложении (PDF).'];
    if (s.footerNote) lines.push('', s.footerNote);
    lines.push('', `— ${s.orgName}`);
    return lines.join('\n');
  }

  async sendPayment(paymentId: number, userId: number | undefined, req: Request | undefined) {
    const { data, garageId } = await this.paymentData(paymentId);
    const owners = (await this.owners(garageId)).filter((o) => o.email);
    if (!owners.length) return this.noEmail();
    const s = await this.settings();
    const pdf = await renderPdf([paymentContent(s, data)], `Квитанция об оплате № ${paymentId}`);
    const res = [];
    for (const o of owners) {
      const r = await this.mail.send({
        to: o.email!, kind: 'payment-receipt', garageId, paymentId, sentById: userId,
        subject: `Чек об оплате № ${paymentId} — гараж №${data.garageNumber}`,
        text: [`Здравствуйте, ${o.name}!`, '', `Принята оплата по гаражу №${data.garageNumber}: ${money(data.amount)} руб. (${data.typeLabel}).`, 'Чек во вложении (PDF).', '', `— ${s.orgName}`].join('\n'),
        attachments: [{ filename: `chek-${paymentId}.pdf`, content: pdf, contentType: 'application/pdf' }],
      });
      res.push({ email: o.email, name: o.name, ...r });
    }
    const out = { sent: res.filter((r) => r.ok).length, failed: res.filter((r) => !r.ok).length, recipients: res };
    if (req) await this.audit.log({ action: 'receipt.send_payment', entity: 'Payment', entityId: paymentId, after: { sent: out.sent, failed: out.failed } }, req);
    return out;
  }

  /**
   * Рассылка квитанций всем должникам, у кого указана почта. Письма группируются по адресу:
   * владелец нескольких гаражей получает одно письмо с несколькими вложениями.
   */
  async sendDebts(dto: SendDebtsDto, u: AuthUser, req: Request) {
    const ids = await this.debtorIds(dto);
    const s = await this.settings();
    const byEmail = new Map<string, { name: string; items: { id: number; data: BillingData }[] }>();
    let noEmailGarages = 0;
    for (const id of ids) {
      const owners = (await this.owners(id)).filter((o) => o.email);
      if (!owners.length) { noEmailGarages++; continue; }
      const data = await this.billingData(id);
      for (const o of owners) {
        const e = o.email!.toLowerCase();
        if (!byEmail.has(e)) byEmail.set(e, { name: o.name, items: [] });
        byEmail.get(e)!.items.push({ id, data });
      }
    }
    const plan = { debtors: ids.length, emails: byEmail.size, garagesWithoutEmail: noEmailGarages };
    if (dto.dryRun) return { dryRun: true, ...plan };

    let sent = 0, failed = 0;
    for (const [email, v] of byEmail) {
      const attachments = [];
      for (const it of v.items) {
        attachments.push({ filename: `kvitanciya-garazh-${it.data.garageNumber}.pdf`, content: await renderPdf([billingContent(s, it.data)], 'Квитанция на оплату'), contentType: 'application/pdf' });
      }
      const total = v.items.reduce((a, it) => a + it.data.total, 0);
      const garages = v.items.map((it) => `№${it.data.garageNumber}`).join(', ');
      const r = await this.mail.send({
        to: email, kind: 'receipt', garageId: v.items[0].id, sentById: u.id,
        subject: v.items.length > 1 ? 'Квитанции на оплату — ГСК «Родник»' : `Квитанция на оплату — гараж №${v.items[0].data.garageNumber}`,
        text: [`Здравствуйте, ${v.name}!`, '', `Направляем квитанции на оплату (гараж ${garages}). Общая сумма к оплате: ${money(total)} руб.`, 'Квитанции во вложении (PDF).', ...(s.footerNote ? ['', s.footerNote] : []), '', `— ${s.orgName}`].join('\n'),
        attachments,
      });
      if (r.ok) sent++; else failed++;
      await new Promise((res) => setTimeout(res, 150)); // не заваливаем почтовый сервер
    }
    await this.audit.log({ action: 'receipt.send_debts', after: { ...plan, sent, failed } }, req);
    return { dryRun: false, ...plan, sent, failed };
  }
}

const pdfHeaders = (res: Response, name: string, size: number) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
};

@Controller('receipts')
class ReceiptsController {
  constructor(private s: ReceiptsService) {}

  @Get('settings') @RequirePermissions('debts.view')
  settings() { return this.s.settings(); }

  @Put('settings') @RequirePermissions('settings.finance')
  setSettings(@Body() dto: SettingsDto, @Req() req: Request) { return this.s.setSettings(dto, req); }

  @Get('preview.pdf') @RequirePermissions('settings.finance')
  async preview(@Query('kind') kind: string, @Res() res: Response) {
    const pdf = await this.s.previewPdf(kind === 'payment' ? 'payment' : 'billing');
    pdfHeaders(res, 'obrazec.pdf', pdf.length); res.end(pdf);
  }

  @Get('garage/:id.pdf') @RequirePermissions('payments.edit')
  async garage(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const pdf = await this.s.billingPdf(id); pdfHeaders(res, `kvitanciya-${id}.pdf`, pdf.length); res.end(pdf);
  }

  @Get('payment/:id.pdf') @RequirePermissions('payments.edit')
  async payment(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    const pdf = await this.s.paymentPdf(id); pdfHeaders(res, `chek-${id}.pdf`, pdf.length); res.end(pdf);
  }

  @Get('debts.pdf') @RequirePermissions('payments.edit')
  async debts(@Query() q: DebtsQuery, @Res() res: Response) {
    const r = await this.s.debtsPdf(q); res.setHeader('X-Receipts-Count', String(r.count)); pdfHeaders(res, 'kvitancii-dolzhniki.pdf', r.pdf.length); res.end(r.pdf);
  }

  @Post('garage/:id/send') @HttpCode(200) @RequirePermissions('payments.edit')
  sendGarage(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.sendGarage(id, u, req); }

  @Post('payment/:id/send') @HttpCode(200) @RequirePermissions('payments.edit')
  sendPayment(@Param('id', ParseIntPipe) id: number, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.sendPayment(id, u.id, req); }

  @Post('debts/send') @HttpCode(200) @RequirePermissions('payments.edit')
  sendDebts(@Body() dto: SendDebtsDto, @CurrentUser() u: AuthUser, @Req() req: Request) { return this.s.sendDebts(dto, u, req); }
}

@Module({ imports: [FinanceModule], controllers: [ReceiptsController], providers: [ReceiptsService] })
export class ReceiptsModule {}
