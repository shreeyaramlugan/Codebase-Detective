-- CreateEnum
CREATE TYPE "SnapshotProcessingStatus" AS ENUM ('PENDING', 'DISCOVERING', 'INGESTING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotCompleteness" AS ENUM ('COMPLETE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotFileStatus" AS ENUM ('DISCOVERED', 'ELIGIBLE', 'STORED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotFileCategory" AS ENUM ('SOURCE', 'CONFIGURATION', 'DOCUMENTATION');

-- AlterEnum
ALTER TYPE "RepositoryStatus" ADD VALUE 'PARTIALLY_INDEXED';

-- AlterTable
ALTER TABLE "indexing_job" ADD COLUMN     "targetCommitSha" TEXT;

-- CreateTable
CREATE TABLE "RepositorySnapshot" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "treeSha" TEXT NOT NULL,
    "branchName" TEXT,
    "commitMessage" TEXT,
    "commitAuthor" TEXT,
    "committedAt" TIMESTAMP(3),
    "status" "SnapshotProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "completeness" "SnapshotCompleteness",
    "totalFiles" INTEGER NOT NULL DEFAULT 0,
    "eligibleFiles" INTEGER NOT NULL DEFAULT 0,
    "storedFiles" INTEGER NOT NULL DEFAULT 0,
    "skippedFiles" INTEGER NOT NULL DEFAULT 0,
    "failedFiles" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositorySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotFile" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT,
    "category" "SnapshotFileCategory",
    "gitBlobSha" TEXT,
    "contentHash" TEXT,
    "sizeBytes" BIGINT,
    "storageKey" TEXT,
    "status" "SnapshotFileStatus" NOT NULL DEFAULT 'DISCOVERED',
    "skipReason" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SnapshotFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepositorySnapshot_repositoryId_createdAt_idx" ON "RepositorySnapshot"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "RepositorySnapshot_status_idx" ON "RepositorySnapshot"("status");

-- CreateIndex
CREATE UNIQUE INDEX "RepositorySnapshot_repositoryId_commitSha_key" ON "RepositorySnapshot"("repositoryId", "commitSha");

-- CreateIndex
CREATE INDEX "SnapshotFile_snapshotId_status_idx" ON "SnapshotFile"("snapshotId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotFile_snapshotId_path_key" ON "SnapshotFile"("snapshotId", "path");

-- AddForeignKey
ALTER TABLE "RepositorySnapshot" ADD CONSTRAINT "RepositorySnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SnapshotFile" ADD CONSTRAINT "SnapshotFile_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "RepositorySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
