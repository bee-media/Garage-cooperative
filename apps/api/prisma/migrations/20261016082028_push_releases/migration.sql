-- AlterTable
ALTER TABLE "AppRelease" ADD COLUMN     "sha256" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "size" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastDebtReminderAt" TIMESTAMP(3);
