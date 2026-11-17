-- CreateTable
CREATE TABLE "NewsPhoto" (
    "id" SERIAL NOT NULL,
    "newsId" INTEGER NOT NULL,
    "fileId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NewsPhoto_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "NewsPhoto" ADD CONSTRAINT "NewsPhoto_newsId_fkey" FOREIGN KEY ("newsId") REFERENCES "News"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsPhoto" ADD CONSTRAINT "NewsPhoto_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "FileAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ad" ADD CONSTRAINT "Ad_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
