-- CreateEnum
CREATE TYPE "MarkStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "MapRow" (
    "id" SERIAL NOT NULL,
    "label" TEXT,
    "x1" DOUBLE PRECISION NOT NULL,
    "y1" DOUBLE PRECISION NOT NULL,
    "x2" DOUBLE PRECISION NOT NULL,
    "y2" DOUBLE PRECISION NOT NULL,
    "depth" DOUBLE PRECISION NOT NULL DEFAULT 24,
    "numbers" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapMark" (
    "id" SERIAL NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "category" TEXT NOT NULL,
    "comment" TEXT,
    "fileId" TEXT,
    "garageNumber" TEXT,
    "status" "MarkStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closeComment" TEXT,

    CONSTRAINT "MapMark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MapPole" (
    "id" SERIAL NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "number" TEXT NOT NULL,
    "comment" TEXT,
    "fileId" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MapPole_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MapMark_status_idx" ON "MapMark"("status");
