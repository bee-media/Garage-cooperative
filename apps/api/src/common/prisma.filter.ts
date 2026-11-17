import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/** Ошибки БД — в понятные ответы вместо «500»: дубликат → 409, нарушение связи → 400. Подробности наружу не отдаём. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private log = new Logger('Prisma');

  catch(e: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Внутренняя ошибка сервера';
    if (e.code === 'P2002') { status = HttpStatus.CONFLICT; message = 'Такая запись уже существует'; }
    else if (e.code === 'P2003') { status = HttpStatus.BAD_REQUEST; message = 'Связанная запись не найдена или используется'; }
    else if (e.code === 'P2025') { status = HttpStatus.NOT_FOUND; message = 'Запись не найдена'; }
    else this.log.error(`${e.code}: ${e.message}`);
    res.status(status).json({ statusCode: status, message });
  }
}
