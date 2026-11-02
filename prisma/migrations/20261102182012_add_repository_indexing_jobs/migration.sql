/*
  Warnings:

  - A unique constraint covering the columns `[ownerId,githubId]` on the table `Repository` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "RepositoryStatus" AS ENUM ('SUBMITTED', 'QUEUED', 'INDEXING', 'INDEXED', 'FAILED');

-- CreateEnum
CREATE TYPE "IndexingJobType" AS ENUM ('REPOSITORY_INDEX');

-- CreateEnum
CREATE TYPE "IndexingJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "description" TEXT,
ADD COLUMN     "forks" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "githubId" BIGINT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "lastCommitSha" TEXT,
ADD COLUMN     "stars" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "RepositoryStatus" NOT NULL DEFAULT 'SUBMITTED',
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'PUBLIC';

-- CreateTable
CREATE TABLE "indexing_job" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "type" "IndexingJobType" NOT NULL DEFAULT 'REPOSITORY_INDEX',
    "status" "IndexingJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexing_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "indexing_job_repositoryId_idx" ON "indexing_job"("repositoryId");

-- CreateIndex
CREATE INDEX "indexing_job_repositoryId_status_idx" ON "indexing_job"("repositoryId", "status");

-- CreateIndex
CREATE INDEX "indexing_job_status_createdAt_idx" ON "indexing_job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Repository_ownerId_status_idx" ON "Repository"("ownerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_ownerId_githubId_key" ON "Repository"("ownerId", "githubId");

-- AddForeignKey
ALTER TABLE "indexing_job" ADD CONSTRAINT "indexing_job_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
