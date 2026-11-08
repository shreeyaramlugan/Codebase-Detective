// lib/findings/findings.prisma-store.ts
//
// Prisma implementations of the findings reader and store.
import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import type { AnalysisRecords } from "@/features/code-intelligence/contracts";
import { prisma } from "@/lib/db/prisma";
import {
  rowsToRecords,
  type StoredRows,
} from "@/lib/analysis/analysis.mappers";

import type {
  AnalysisHeader,
  FindingsReader,
  SourceRef,
} from "./findings.runner";
import type {
  CreateFindingsRunInput,
  FindingsStore,
  PersistFindingsInput,
} from "./findings.store";

const BATCH_SIZE = 500;
const TRANSACTION_TIMEOUT_MS = 120_000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const nullableJson = (value: unknown) =>
  value === null || value === undefined
    ? Prisma.JsonNull
    : (value as Prisma.InputJsonValue);

/** Deterministic row ids so a retried write cannot create duplicates. */
export function findingRowId(runId: string, fingerprint: string): string {
  return `fr_${createHash("sha256").update(`${runId}\0${fingerprint}`).digest("hex").slice(0, 32)}`;
}

export function evidenceRowId(findingId: string, ordinal: number): string {
  return `fe_${createHash("sha256").update(`${findingId}\0${ordinal}`).digest("hex").slice(0, 32)}`;
}

export const prismaFindingsReader: FindingsReader = {
  async findOwnedAnalysis(userId, analysisId): Promise<AnalysisHeader | null> {
    // Ownership is part of the query: another user's analysis is
    // indistinguishable from a missing one.
    return prisma.codeAnalysis.findFirst({
      where: { id: analysisId, repository: { ownerId: userId } },
      select: {
        id: true,
        snapshotId: true,
        repositoryId: true,
        status: true,
        snapshotCompleteness: true,
      },
    });
  },

  async loadRecords(analysisId): Promise<AnalysisRecords> {
    const [files, symbols, dependencies, calls, relations, diagnostics] =
      await Promise.all([
        prisma.analysisFile.findMany({ where: { analysisId } }),
        prisma.codeSymbol.findMany({ where: { analysisId } }),
        prisma.moduleDependency.findMany({ where: { analysisId } }),
        prisma.codeCall.findMany({ where: { analysisId } }),
        prisma.codeRelation.findMany({ where: { analysisId } }),
        prisma.analysisDiagnostic.findMany({ where: { analysisId } }),
      ]);

    return rowsToRecords({
      files,
      symbols,
      dependencies,
      calls,
      relations,
      diagnostics,
    } as unknown as StoredRows);
  },

  async listSourceRefs(snapshotId): Promise<SourceRef[]> {
    return prisma.snapshotFile.findMany({
      where: { snapshotId, status: "STORED" },
      select: { path: true, storageKey: true, contentHash: true },
    });
  },
};

export const prismaFindingsStore: FindingsStore = {
  async createRun(input: CreateFindingsRunInput) {
    return prisma.findingsRun.create({
      data: {
        analysisId: input.analysisId,
        repositoryId: input.repositoryId,
        requestedById: input.requestedById,
        engineVersion: input.engineVersion,
        catalogueVersion: input.catalogueVersion,
        thresholds: json(input.thresholds),
        status: "PENDING",
      },
      select: { id: true },
    });
  },

  async markProcessing(runId) {
    await prisma.findingsRun.update({
      where: { id: runId },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
  },

  async persistResults(runId, input: PersistFindingsInput) {
    const { result } = input;

    const findingRows = result.findings.map((finding) => ({
      id: findingRowId(runId, finding.fingerprint),
      runId,
      fingerprint: finding.fingerprint,
      ruleId: finding.ruleId,
      ruleVersion: finding.ruleVersion,
      category: finding.category,
      severity: finding.severity,
      certainty: finding.certainty,
      title: finding.title,
      description: finding.description,
      recommendation: finding.recommendation,
      subjectPath: finding.subjectPath,
      subjectKey: finding.subjectKey,
      symbolKey: finding.symbolKey,
      primaryLine: finding.primaryLine,
      measurements: nullableJson(finding.measurements),
    }));

    const evidenceRows = result.findings.flatMap((finding) => {
      const findingId = findingRowId(runId, finding.fingerprint);
      return finding.evidence.map((item) => ({
        id: evidenceRowId(findingId, item.ordinal),
        findingId,
        ordinal: item.ordinal,
        kind: item.kind,
        filePath: item.filePath,
        symbolKey: item.symbolKey,
        startLine: item.location?.startLine ?? null,
        startColumn: item.location?.startColumn ?? null,
        endLine: item.location?.endLine ?? null,
        endColumn: item.location?.endColumn ?? null,
        excerpt: item.excerpt,
        message: item.message,
        data: nullableJson(item.data ?? null),
      }));
    });

    await prisma.$transaction(
      async (tx) => {
        await tx.findingRuleRun.createMany({
          data: result.ruleRuns.map((run) => ({
            runId,
            ruleId: run.ruleId,
            ruleVersion: run.ruleVersion,
            status: run.status,
            reason: run.reason,
            findingCount: run.findingCount,
            rejectedCount: run.rejectedCount,
            duplicateCount: run.duplicateCount,
            limitations: json(run.limitations),
            configHash: run.configHash,
          })),
        });

        for (const batch of chunk(findingRows, BATCH_SIZE)) {
          await tx.finding.createMany({
            data: batch as Prisma.FindingCreateManyInput[],
          });
        }

        for (const batch of chunk(evidenceRows, BATCH_SIZE)) {
          await tx.findingEvidence.createMany({
            data: batch as Prisma.FindingEvidenceCreateManyInput[],
          });
        }

        await tx.findingsRun.update({
          where: { id: runId },
          data: {
            status: input.status,
            limitations: json(result.limitations),
            stats: json(input.stats),
            coverage: json(input.coverage),
            completedAt: new Date(),
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
  },

  async markFailed(runId, input) {
    await prisma.findingsRun.update({
      where: { id: runId },
      data: {
        status: "FAILED",
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        completedAt: new Date(),
      },
    });
  },
};
