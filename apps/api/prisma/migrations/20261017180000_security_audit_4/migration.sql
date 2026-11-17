-- Четвёртый аудит безопасности

-- Ротация refresh-токена: предыдущий хэш и время ротации (окно для параллельных запросов, обнаружение повторного использования)
ALTER TABLE "Session" ADD COLUMN "prevRefreshHash" TEXT, ADD COLUMN "rotatedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Session_prevRefreshHash_key" ON "Session"("prevRefreshHash");

-- Суточная квота загрузок
CREATE INDEX "FileAsset_ownerId_createdAt_idx" ON "FileAsset"("ownerId", "createdAt");

-- Карта: один файл — один объект. Если раньше один файл попал в несколько записей, ссылку оставляем у самой ранней
UPDATE "MapMark" m SET "fileId" = NULL WHERE "fileId" IS NOT NULL AND EXISTS (SELECT 1 FROM "MapMark" o WHERE o."fileId" = m."fileId" AND o.id < m.id);
UPDATE "MapPole" m SET "fileId" = NULL WHERE "fileId" IS NOT NULL AND EXISTS (SELECT 1 FROM "MapPole" o WHERE o."fileId" = m."fileId" AND o.id < m.id);
UPDATE "MapLine" m SET "fileId" = NULL WHERE "fileId" IS NOT NULL AND EXISTS (SELECT 1 FROM "MapLine" o WHERE o."fileId" = m."fileId" AND o.id < m.id);
CREATE UNIQUE INDEX "MapMark_fileId_key" ON "MapMark"("fileId");
CREATE UNIQUE INDEX "MapPole_fileId_key" ON "MapPole"("fileId");
CREATE UNIQUE INDEX "MapLine_fileId_key" ON "MapLine"("fileId");

-- Удалённые пользователи освобождают номер телефона (логин): номер хранится с суффиксом ~<id>
UPDATE "User" SET "phone" = "phone" || '~' || "id" WHERE "deletedAt" IS NOT NULL AND "phone" NOT LIKE '%~%';
