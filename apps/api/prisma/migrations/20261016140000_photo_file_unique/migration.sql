-- Один файл - одна запись: защита от повторного использования фото при параллельных запросах
CREATE UNIQUE INDEX "MeterPhoto_fileId_key" ON "MeterPhoto"("fileId");
CREATE UNIQUE INDEX "NewsPhoto_fileId_key" ON "NewsPhoto"("fileId");
CREATE UNIQUE INDEX "AdPhoto_fileId_key" ON "AdPhoto"("fileId");
