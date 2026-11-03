-- AlterTable
ALTER TABLE "indexing_job" ADD COLUMN     "lockedAt" TIMESTAMP(3),
ADD COLUMN     "lockedBy" TEXT;

-- CreateIndex
CREATE INDEX "indexing_job_status_nextRetryAt_idx" ON "indexing_job"("status", "nextRetryAt");
