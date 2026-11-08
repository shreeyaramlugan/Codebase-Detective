-- CreateEnum
CREATE TYPE "FindingsRunStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('DEPENDENCY', 'COMPLEXITY', 'STRUCTURE', 'SECURITY');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingCertainty" AS ENUM ('CONFIRMED', 'MEASURED', 'INDICATOR');

-- CreateEnum
CREATE TYPE "FindingEvidenceKind" AS ENUM ('SOURCE_LOCATION', 'DEPENDENCY', 'SYMBOL', 'METRIC', 'CYCLE_EDGE', 'PATTERN_MATCH');

-- CreateEnum
CREATE TYPE "FindingRuleRunStatus" AS ENUM ('COMPLETED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "FindingReviewStatus" AS ENUM ('ACKNOWLEDGED', 'DISMISSED');

-- CreateTable
CREATE TABLE "FindingsRun" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "FindingsRunStatus" NOT NULL DEFAULT 'PENDING',
    "engineVersion" TEXT NOT NULL,
    "catalogueVersion" TEXT NOT NULL,
    "thresholds" JSONB NOT NULL,
    "limitations" JSONB,
    "stats" JSONB,
    "coverage" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingsRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingRuleRun" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "status" "FindingRuleRunStatus" NOT NULL,
    "reason" TEXT,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "limitations" JSONB,
    "configHash" TEXT NOT NULL,

    CONSTRAINT "FindingRuleRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "certainty" "FindingCertainty" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "subjectPath" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "symbolKey" TEXT,
    "primaryLine" INTEGER,
    "measurements" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEvidence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "FindingEvidenceKind" NOT NULL,
    "filePath" TEXT NOT NULL,
    "symbolKey" TEXT,
    "startLine" INTEGER,
    "startColumn" INTEGER,
    "endLine" INTEGER,
    "endColumn" INTEGER,
    "excerpt" TEXT,
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "FindingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingReview" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "FindingReviewStatus" NOT NULL,
    "reason" TEXT,
    "reviewedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FindingReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FindingsRun_analysisId_createdAt_idx" ON "FindingsRun"("analysisId", "createdAt");

-- CreateIndex
CREATE INDEX "FindingsRun_repositoryId_createdAt_idx" ON "FindingsRun"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "FindingsRun_requestedById_idx" ON "FindingsRun"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "FindingRuleRun_runId_ruleId_key" ON "FindingRuleRun"("runId", "ruleId");

-- CreateIndex
CREATE INDEX "Finding_runId_severity_idx" ON "Finding"("runId", "severity");

-- CreateIndex
CREATE INDEX "Finding_runId_category_idx" ON "Finding"("runId", "category");

-- CreateIndex
CREATE INDEX "Finding_runId_ruleId_idx" ON "Finding"("runId", "ruleId");

-- CreateIndex
CREATE INDEX "Finding_runId_subjectPath_idx" ON "Finding"("runId", "subjectPath");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_runId_fingerprint_key" ON "Finding"("runId", "fingerprint");

-- CreateIndex
CREATE INDEX "FindingEvidence_findingId_idx" ON "FindingEvidence"("findingId");

-- CreateIndex
CREATE UNIQUE INDEX "FindingEvidence_findingId_ordinal_key" ON "FindingEvidence"("findingId", "ordinal");

-- CreateIndex
CREATE INDEX "FindingReview_repositoryId_status_idx" ON "FindingReview"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FindingReview_repositoryId_fingerprint_key" ON "FindingReview"("repositoryId", "fingerprint");

-- AddForeignKey
ALTER TABLE "FindingsRun" ADD CONSTRAINT "FindingsRun_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingsRun" ADD CONSTRAINT "FindingsRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingsRun" ADD CONSTRAINT "FindingsRun_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingRuleRun" ADD CONSTRAINT "FindingRuleRun_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FindingsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Finding" ADD CONSTRAINT "Finding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FindingsRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "Finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingReview" ADD CONSTRAINT "FindingReview_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingReview" ADD CONSTRAINT "FindingReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
