-- CreateEnum
CREATE TYPE "ResearchRunStatus" AS ENUM ('DISCOVERING', 'AWAITING_REVIEW', 'SYNTHESIZING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ResearchTrigger" AS ENUM ('FINDING', 'QUESTION');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'IMPLEMENTED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "findingsRunId" TEXT,
    "trigger" "ResearchTrigger" NOT NULL,
    "findingId" TEXT,
    "findingFingerprint" TEXT,
    "ruleId" TEXT,
    "question" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "ResearchRunStatus" NOT NULL DEFAULT 'DISCOVERING',
    "queries" JSONB NOT NULL,
    "diagnostics" JSONB,
    "discarded" JSONB,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "engineVersion" TEXT NOT NULL,
    "synthesis" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "totalTokens" INTEGER,
    "errorCode" TEXT,
    "busyUntil" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchRunSource" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "record" JSONB NOT NULL,
    "evaluation" JSONB NOT NULL,
    "passages" JSONB NOT NULL,
    "queryOrdinals" JSONB NOT NULL,
    "reused" BOOLEAN NOT NULL DEFAULT false,
    "included" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ResearchRunSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchRecommendation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "concise" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "repositoryCitations" JSONB NOT NULL,
    "sourceCitations" JSONB NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'PROPOSED',
    "note" TEXT,
    "statusChangedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "record" JSONB NOT NULL,
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchUsageDay" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "synthesisCount" INTEGER NOT NULL DEFAULT 0,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "providerRequestCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchUsageDay_pkey" PRIMARY KEY ("userId","day")
);

-- CreateIndex
CREATE INDEX "ResearchRun_userId_repositoryId_archivedAt_createdAt_idx" ON "ResearchRun"("userId", "repositoryId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRun_userId_findingFingerprint_idx" ON "ResearchRun"("userId", "findingFingerprint");

-- CreateIndex
CREATE INDEX "ResearchRunSource_runId_position_idx" ON "ResearchRunSource"("runId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRunSource_runId_sourceKey_key" ON "ResearchRunSource"("runId", "sourceKey");

-- CreateIndex
CREATE INDEX "ResearchRecommendation_runId_status_idx" ON "ResearchRecommendation"("runId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRecommendation_runId_ordinal_key" ON "ResearchRecommendation"("runId", "ordinal");

-- CreateIndex
CREATE INDEX "ResearchSource_userId_canonicalUrl_idx" ON "ResearchSource"("userId", "canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchSource_userId_sourceKey_key" ON "ResearchSource"("userId", "sourceKey");

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRunSource" ADD CONSTRAINT "ResearchRunSource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRecommendation" ADD CONSTRAINT "ResearchRecommendation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchUsageDay" ADD CONSTRAINT "ResearchUsageDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
