-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisFileStatus" AS ENUM ('ANALYSED', 'ANALYSED_WITH_ERRORS', 'CONFIG', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisSymbolKind" AS ENUM ('FUNCTION', 'CLASS', 'METHOD', 'INTERFACE', 'TYPE', 'VARIABLE', 'ENUM');

-- CreateEnum
CREATE TYPE "ModuleDependencyKind" AS ENUM ('IMPORT', 'SIDE_EFFECT_IMPORT', 'DYNAMIC_IMPORT', 'REQUIRE', 'RE_EXPORT', 'EXPORT_ALL');

-- CreateEnum
CREATE TYPE "ModuleSystem" AS ENUM ('ESM', 'CJS');

-- CreateEnum
CREATE TYPE "ResolutionStatus" AS ENUM ('RESOLVED', 'UNRESOLVED', 'AMBIGUOUS', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "CodeCallKind" AS ENUM ('CALL', 'NEW', 'SUPER');

-- CreateEnum
CREATE TYPE "CodeCallResolution" AS ENUM ('CONFIRMED', 'POSSIBLE', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "CodeRelationKind" AS ENUM ('EXTENDS', 'IMPLEMENTS', 'REFERENCES');

-- CreateEnum
CREATE TYPE "DiagnosticSeverity" AS ENUM ('ERROR', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "DiagnosticSource" AS ENUM ('SNAPSHOT', 'PARSER', 'EXTRACTOR', 'RESOLVER', 'LINKER', 'CONFIG', 'GRAPH', 'ENGINE');

-- CreateTable
CREATE TABLE "CodeAnalysis" (
    "id" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "snapshotCompleteness" "SnapshotCompleteness",
    "commitSha" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "graphSchemaVersion" INTEGER,
    "stats" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodeAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisFile" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "snapshotFileId" TEXT,
    "path" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "scriptKind" TEXT,
    "moduleSyntax" TEXT NOT NULL,
    "status" "AnalysisFileStatus" NOT NULL,
    "reason" TEXT,
    "contentHash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "syntaxErrorCount" INTEGER NOT NULL DEFAULT 0,
    "symbolCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalysisFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeSymbol" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AnalysisSymbolKind" NOT NULL,
    "qualifiedName" TEXT NOT NULL,
    "parentId" TEXT,
    "isExported" BOOLEAN NOT NULL DEFAULT false,
    "isDefaultExport" BOOLEAN NOT NULL DEFAULT false,
    "exportNames" TEXT[],
    "startLine" INTEGER NOT NULL,
    "startColumn" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "endColumn" INTEGER NOT NULL,
    "details" JSONB NOT NULL,

    CONSTRAINT "CodeSymbol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleDependency" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "kind" "ModuleDependencyKind" NOT NULL,
    "specifier" TEXT NOT NULL,
    "isTypeOnly" BOOLEAN NOT NULL DEFAULT false,
    "moduleSystem" "ModuleSystem" NOT NULL,
    "bindings" JSONB NOT NULL,
    "startLine" INTEGER NOT NULL,
    "startColumn" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "endColumn" INTEGER NOT NULL,
    "status" "ResolutionStatus" NOT NULL,
    "targetPath" TEXT,
    "targetAnalysed" BOOLEAN NOT NULL DEFAULT false,
    "externalPackage" TEXT,
    "reason" TEXT NOT NULL,
    "candidates" TEXT[],
    "evidence" TEXT[],

    CONSTRAINT "ModuleDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeCall" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "kind" "CodeCallKind" NOT NULL,
    "callerSymbolId" TEXT,
    "calleeText" TEXT NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "resolution" "CodeCallResolution" NOT NULL,
    "targetSymbolId" TEXT,
    "reason" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "startColumn" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "endColumn" INTEGER NOT NULL,

    CONSTRAINT "CodeCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodeRelation" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "CodeRelationKind" NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceSymbolId" TEXT,
    "targetName" TEXT NOT NULL,
    "targetSymbolId" TEXT,
    "status" "ResolutionStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "startLine" INTEGER NOT NULL,
    "startColumn" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "endColumn" INTEGER NOT NULL,

    CONSTRAINT "CodeRelation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisDiagnostic" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "fileId" TEXT,
    "severity" "DiagnosticSeverity" NOT NULL,
    "source" "DiagnosticSource" NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "line" INTEGER,
    "column" INTEGER,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisDiagnostic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisGraph" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisGraph_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CodeAnalysis_snapshotId_createdAt_idx" ON "CodeAnalysis"("snapshotId", "createdAt");

-- CreateIndex
CREATE INDEX "CodeAnalysis_repositoryId_idx" ON "CodeAnalysis"("repositoryId");

-- CreateIndex
CREATE INDEX "CodeAnalysis_requestedById_idx" ON "CodeAnalysis"("requestedById");

-- CreateIndex
CREATE INDEX "CodeAnalysis_status_idx" ON "CodeAnalysis"("status");

-- CreateIndex
CREATE INDEX "AnalysisFile_analysisId_status_idx" ON "AnalysisFile"("analysisId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisFile_analysisId_path_key" ON "AnalysisFile"("analysisId", "path");

-- CreateIndex
CREATE INDEX "CodeSymbol_analysisId_fileId_idx" ON "CodeSymbol"("analysisId", "fileId");

-- CreateIndex
CREATE INDEX "CodeSymbol_analysisId_kind_idx" ON "CodeSymbol"("analysisId", "kind");

-- CreateIndex
CREATE INDEX "CodeSymbol_analysisId_name_idx" ON "CodeSymbol"("analysisId", "name");

-- CreateIndex
CREATE INDEX "CodeSymbol_parentId_idx" ON "CodeSymbol"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "CodeSymbol_analysisId_stableKey_key" ON "CodeSymbol"("analysisId", "stableKey");

-- CreateIndex
CREATE INDEX "ModuleDependency_analysisId_fileId_idx" ON "ModuleDependency"("analysisId", "fileId");

-- CreateIndex
CREATE INDEX "ModuleDependency_analysisId_status_idx" ON "ModuleDependency"("analysisId", "status");

-- CreateIndex
CREATE INDEX "ModuleDependency_analysisId_targetPath_idx" ON "ModuleDependency"("analysisId", "targetPath");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleDependency_analysisId_key_key" ON "ModuleDependency"("analysisId", "key");

-- CreateIndex
CREATE INDEX "CodeCall_analysisId_fileId_idx" ON "CodeCall"("analysisId", "fileId");

-- CreateIndex
CREATE INDEX "CodeCall_analysisId_resolution_idx" ON "CodeCall"("analysisId", "resolution");

-- CreateIndex
CREATE INDEX "CodeCall_callerSymbolId_idx" ON "CodeCall"("callerSymbolId");

-- CreateIndex
CREATE INDEX "CodeCall_targetSymbolId_idx" ON "CodeCall"("targetSymbolId");

-- CreateIndex
CREATE UNIQUE INDEX "CodeCall_analysisId_key_key" ON "CodeCall"("analysisId", "key");

-- CreateIndex
CREATE INDEX "CodeRelation_analysisId_fileId_idx" ON "CodeRelation"("analysisId", "fileId");

-- CreateIndex
CREATE INDEX "CodeRelation_analysisId_kind_idx" ON "CodeRelation"("analysisId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CodeRelation_analysisId_key_key" ON "CodeRelation"("analysisId", "key");

-- CreateIndex
CREATE INDEX "AnalysisDiagnostic_analysisId_severity_idx" ON "AnalysisDiagnostic"("analysisId", "severity");

-- CreateIndex
CREATE INDEX "AnalysisDiagnostic_analysisId_source_idx" ON "AnalysisDiagnostic"("analysisId", "source");

-- CreateIndex
CREATE INDEX "AnalysisDiagnostic_analysisId_fileId_idx" ON "AnalysisDiagnostic"("analysisId", "fileId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisGraph_analysisId_key" ON "AnalysisGraph"("analysisId");

-- AddForeignKey
ALTER TABLE "CodeAnalysis" ADD CONSTRAINT "CodeAnalysis_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "RepositorySnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeAnalysis" ADD CONSTRAINT "CodeAnalysis_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeAnalysis" ADD CONSTRAINT "CodeAnalysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisFile" ADD CONSTRAINT "AnalysisFile_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisFile" ADD CONSTRAINT "AnalysisFile_snapshotFileId_fkey" FOREIGN KEY ("snapshotFileId") REFERENCES "SnapshotFile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "AnalysisFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeSymbol" ADD CONSTRAINT "CodeSymbol_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "CodeSymbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleDependency" ADD CONSTRAINT "ModuleDependency_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleDependency" ADD CONSTRAINT "ModuleDependency_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "AnalysisFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeCall" ADD CONSTRAINT "CodeCall_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeCall" ADD CONSTRAINT "CodeCall_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "AnalysisFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeCall" ADD CONSTRAINT "CodeCall_callerSymbolId_fkey" FOREIGN KEY ("callerSymbolId") REFERENCES "CodeSymbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeCall" ADD CONSTRAINT "CodeCall_targetSymbolId_fkey" FOREIGN KEY ("targetSymbolId") REFERENCES "CodeSymbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeRelation" ADD CONSTRAINT "CodeRelation_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeRelation" ADD CONSTRAINT "CodeRelation_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "AnalysisFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeRelation" ADD CONSTRAINT "CodeRelation_sourceSymbolId_fkey" FOREIGN KEY ("sourceSymbolId") REFERENCES "CodeSymbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodeRelation" ADD CONSTRAINT "CodeRelation_targetSymbolId_fkey" FOREIGN KEY ("targetSymbolId") REFERENCES "CodeSymbol"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisDiagnostic" ADD CONSTRAINT "AnalysisDiagnostic_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisDiagnostic" ADD CONSTRAINT "AnalysisDiagnostic_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "AnalysisFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisGraph" ADD CONSTRAINT "AnalysisGraph_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "CodeAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
