-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "IndexingJobType" ADD VALUE 'CODE_ANALYSIS';
ALTER TYPE "IndexingJobType" ADD VALUE 'FINDINGS_GENERATION';
ALTER TYPE "IndexingJobType" ADD VALUE 'RESEARCH_DISCOVERY';
ALTER TYPE "IndexingJobType" ADD VALUE 'RESEARCH_SYNTHESIS';

-- AlterTable
ALTER TABLE "indexing_job" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "requestedById" TEXT,
ADD COLUMN     "result" JSONB;

-- CreateTable
CREATE TABLE "worker_instance" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "concurrency" INTEGER NOT NULL,
    "activeJobs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "worker_instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_event" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event" TEXT NOT NULL,
    "workerId" TEXT,
    "attempt" INTEGER,
    "code" TEXT,
    "message" TEXT,
    "data" JSONB,

    CONSTRAINT "job_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_instance_status_lastHeartbeatAt_idx" ON "worker_instance"("status", "lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "job_event_jobId_at_idx" ON "job_event"("jobId", "at");

-- CreateIndex
CREATE INDEX "indexing_job_status_lockedBy_idx" ON "indexing_job"("status", "lockedBy");

-- CreateIndex
CREATE INDEX "indexing_job_dedupeKey_status_idx" ON "indexing_job"("dedupeKey", "status");

-- CreateIndex
CREATE INDEX "indexing_job_requestedById_idx" ON "indexing_job"("requestedById");

-- AddForeignKey
ALTER TABLE "indexing_job" ADD CONSTRAINT "indexing_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "indexing_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
