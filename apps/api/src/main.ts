import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './common/prisma.filter';

/** В production секреты должны быть длинными и не «по умолчанию» */
function assertSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  const weak = (v?: string) => !v || v.length < 32 || /change-?me/i.test(v);
  if (weak(process.env.JWT_ACCESS_SECRET)) throw new Error('JWT_ACCESS_SECRET не задан или слишком слабый (нужно 32+ случайных символов)');
  if (weak(process.env.TOTP_ENC_KEY)) throw new Error('TOTP_ENC_KEY не задан или слишком слабый (нужно 32+ случайных символов)');
}

async function bootstrap() {
  assertSecrets();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Перед приложением цепочка прокси (Nginx Proxy Manager → локальный nginx): реальный IP берём из X-Forwarded-For.
  // TRUST_PROXY_HOPS — число прокси перед приложением (на сервере 2, в разработке 1).
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(process.env.PORT ?? 3000);
  // Слушаем только локальный интерфейс: наружу ходит только NPM
  await app.listen(port, process.env.HOST ?? '127.0.0.1');
  new Logger('Bootstrap').log(`API: http://127.0.0.1:${port}/api`);
}
bootstrap();
