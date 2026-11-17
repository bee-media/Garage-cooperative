-- CreateTable
CREATE TABLE "MailLog" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "toAddr" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "garageId" INTEGER,
    "paymentId" INTEGER,
    "sentById" INTEGER,

    CONSTRAINT "MailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportLog" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "fileName" TEXT,
    "fileHash" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,

    CONSTRAINT "ImportLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MailLog_at_idx" ON "MailLog"("at");

-- CreateIndex
CREATE INDEX "MailLog_garageId_idx" ON "MailLog"("garageId");

-- CreateIndex
CREATE INDEX "ImportLog_kind_fileHash_idx" ON "ImportLog"("kind", "fileHash");
