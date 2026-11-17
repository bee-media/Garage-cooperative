// Аварийный сброс двухфакторной защиты с сервера (если администратор потерял и телефон, и резервные коды).
// Запуск:  sudo -u gsk-deploy /opt/gsk/bin/reset-2fa.sh 9001112233
// Очищает секрет и резервные коды и завершает все сессии. При следующем входе пользователь настроит 2FA заново.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const phone = (process.argv[2] ?? '').replace(/\D/g, '');
  if (!/^\d{10}$/.test(phone)) {
    console.error('Укажите телефон из 10 цифр: reset-2fa.sh 9001112233');
    process.exitCode = 2;
    return;
  }
  const user = await prisma.user.findFirst({ where: { phone, deletedAt: null } });
  if (!user) {
    console.error(`Пользователь ${phone} не найден`);
    process.exitCode = 1;
    return;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, totpLastStep: null, failedAttempts: 0, lockedAt: null } }),
    prisma.backupCode.deleteMany({ where: { userId: user.id } }),
    prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.auditLog.create({ data: { actorPhone: 'server-cli', action: 'user.2fa.reset', entity: 'User', entityId: String(user.id) } }),
  ]);
  console.log(`2FA сброшена для ${phone} (${user.fullName ?? 'без имени'}), сессии завершены, учётная запись разблокирована.`);
}

main().finally(() => prisma.$disconnect());
