-- CreateTable
CREATE TABLE "MapLine" (
    "id" SERIAL NOT NULL,
    "name" TEXT,
    "color" TEXT NOT NULL DEFAULT '#f2c261',
    "status" TEXT NOT NULL DEFAULT 'OK',
    "points" JSONB NOT NULL,
    "comment" TEXT,
    "fileId" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapLineEvent" (
    "id" SERIAL NOT NULL,
    "lineId" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT,
    "comment" TEXT,

    CONSTRAINT "MapLineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MapLine_status_idx" ON "MapLine"("status");

-- CreateIndex
CREATE INDEX "MapLineEvent_lineId_at_idx" ON "MapLineEvent"("lineId", "at");

-- AddForeignKey
ALTER TABLE "MapLineEvent" ADD CONSTRAINT "MapLineEvent_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "MapLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
