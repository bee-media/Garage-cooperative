import {
  BadRequestException, Controller, ForbiddenException, Get, HttpCode, Module, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { IsDateString, IsOptional } from 'class-validator';
import type { Request, Response } from 'express';
import { AuditService, AuthUser } from '../audit/audit.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { FinanceModule } from '../finance/finance.module';
import { ExcelExportService } from './excel.export';
import { ExcelImportService, IMPORT_KINDS, IMPORT_TITLES, ImportKind } from './excel.import';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_FILE = 3 * 1024 * 1024;

class PeriodQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

function send(res: Response, name: string, buf: Buffer) {
  res.setHeader('Content-Type', XLSX);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(buf);
}

const stamp = () => new Date().toISOString().slice(0, 10);

@Controller('export')
class ExportController {
  constructor(private ex: ExcelExportService, private audit: AuditService) {}

  private async done(req: Request, kind: string) { await this.audit.log({ action: 'export.xlsx', after: { kind } }, req); }

  @Get('users.xlsx') @RequirePermissions('data.export', 'users.view')
  async users(@Req() req: Request, @Res() res: Response) { const b = await this.ex.users(); await this.done(req, 'users'); send(res, `polzovateli-${stamp()}.xlsx`, b); }

  @Get('garages.xlsx') @RequirePermissions('data.export', 'garages.view')
  async garages(@Query('status') status: string, @Req() req: Request, @Res() res: Response) {
    const b = await this.ex.garages(status === 'ARCHIVED' ? 'ARCHIVED' : status === 'ALL' ? 'ALL' : 'ACTIVE'); await this.done(req, 'garages'); send(res, `garazhi-${stamp()}.xlsx`, b);
  }

  @Get('debts.xlsx') @RequirePermissions('data.export', 'debts.view')
  async debts(@Req() req: Request, @Res() res: Response) { const b = await this.ex.debts(); await this.done(req, 'debts'); send(res, `dolgi-${stamp()}.xlsx`, b); }

  @Get('charges.xlsx') @RequirePermissions('data.export', 'debts.view')
  async charges(@Query() q: PeriodQuery, @Req() req: Request, @Res() res: Response) { const b = await this.ex.charges(q.from, q.to); await this.done(req, 'charges'); send(res, `nachisleniya-${stamp()}.xlsx`, b); }

  @Get('payments.xlsx') @RequirePermissions('data.export', 'debts.view')
  async payments(@Query() q: PeriodQuery, @Req() req: Request, @Res() res: Response) { const b = await this.ex.payments(q.from, q.to); await this.done(req, 'payments'); send(res, `oplaty-${stamp()}.xlsx`, b); }
}

/** Права на конкретный вид импорта (кроме общего data.import) */
const NEED: Record<ImportKind, string[]> = { garages: ['garages.edit', 'users.edit'], charges: ['charges.edit'], payments: ['payments.edit'] };

@Controller('import')
class ImportController {
  constructor(private im: ExcelImportService, private audit: AuditService) {}

  private kind(k: string): ImportKind {
    if (!IMPORT_KINDS.includes(k as ImportKind)) throw new BadRequestException('Неизвестный вид импорта');
    return k as ImportKind;
  }

  private check(u: AuthUser, kind: ImportKind) {
    if (!NEED[kind].every((p) => u.permissions.includes(p))) throw new ForbiddenException('Недостаточно прав для этого вида импорта');
  }

  @Get('history') @RequirePermissions('data.import')
  history() { return this.im.history(); }

  @Get('template/:kind.xlsx') @RequirePermissions('data.import')
  async template(@Param('kind') k: string, @Res() res: Response) {
    const kind = this.kind(k);
    send(res, `shablon-${kind}.xlsx`, await this.im.template(kind));
  }

  /** dryRun=1 — только проверка и отчёт; без него — применение (если ошибок нет) */
  @Post(':kind') @HttpCode(200) @RequirePermissions('data.import')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE, files: 1 } }))
  async run(
    @Param('kind') k: string, @UploadedFile() file: Express.Multer.File | undefined, @Query('dryRun') dry: string,
    @Query('updateExisting') upd: string, @Query('force') force: string, @CurrentUser() u: AuthUser, @Req() req: Request,
  ) {
    const kind = this.kind(k);
    this.check(u, kind);
    if (!file) throw new BadRequestException('Файл не передан (поле file)');
    if (!/\.xlsx$/i.test(file.originalname)) throw new BadRequestException('Нужен файл Excel в формате .xlsx');
    // xlsx — это zip: проверяем сигнатуру, а не только расширение
    if (!(file.buffer[0] === 0x50 && file.buffer[1] === 0x4b)) throw new BadRequestException('Файл не похож на Excel (.xlsx)');
    const report = await this.im.run(kind, file, { dryRun: dry === '1', updateExisting: upd === '1', force: force === '1' }, u);
    if (report.applied) await this.audit.log({ action: `import.${kind}`, after: { file: file.originalname, ...report.summary } }, req);
    return { ...report, title: IMPORT_TITLES[kind] };
  }
}

@Module({ imports: [FinanceModule], controllers: [ExportController, ImportController], providers: [ExcelExportService, ExcelImportService] })
export class ExcelModule {}
