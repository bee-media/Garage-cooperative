// Начальное наполнение: системные роли и первый администратор.
// На сервере:   node --env-file=/etc/gsk/api.env dist/cli/seed.js
// В разработке: npm run db:seed
import { PrismaClient } from '@prisma/client';
import { generatePassword, hashPassword } from '../common/password';
import { SYSTEM_ROLES } from '../common/permissions';

const prisma = new PrismaClient();

async function main() {
  for (const r of SYSTEM_ROLES) {
    await prisma.role.upsert({
      where: { name: r.name },
      // права системных ролей обновляем только при создании, чтобы не затирать правки администратора
      update: r.name === 'Администратор' ? { permissions: r.permissions } : {},
      create: { ...r, isSystem: true },
    });
  }

  // Председатель по определению имеет все права, кроме управления ролями: новые права добавляем (ничего не отнимая)
  const chair = await prisma.role.findUnique({ where: { name: 'Председатель' } });
  const chairDefault = SYSTEM_ROLES.find((r) => r.name === 'Председатель')!.permissions as string[];
  if (chair) {
    const merged = [...new Set([...(chair.permissions as string[]), ...chairDefault])];
    if (merged.length !== (chair.permissions as string[]).length) await prisma.role.update({ where: { id: chair.id }, data: { permissions: merged } });
  }

  const phone = process.env.SEED_ADMIN_PHONE ?? '9000000000';
  const exists = await prisma.user.findUnique({ where: { phone } });
  if (exists) {
    console.log(`Администратор ${phone} уже существует`);
    return;
  }
  const password = process.env.SEED_ADMIN_PASSWORD || generatePassword(12);
  const role = await prisma.role.findUniqueOrThrow({ where: { name: 'Администратор' } });
  await prisma.user.create({
    data: { phone, fullName: process.env.SEED_ADMIN_NAME ?? 'Администратор', roleId: role.id, passwordHash: await hashPassword(password) },
  });
  console.log(`Создан администратор: ${phone}`);
  if (!process.env.SEED_ADMIN_PASSWORD) console.log(`Пароль (показан один раз): ${password}`);
}

main().finally(() => prisma.$disconnect());
