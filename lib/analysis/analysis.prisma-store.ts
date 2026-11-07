// lib/analysis/analysis.prisma-store.ts
//
// Prisma implementations of the snapshot reader and the analysis store.
import { Prisma } from "@prisma/client";

import type { DiagnosticRecord } from "@/features/code-intelligence/contracts";
import { GRAPH_SCHEMA_VERSION } from "@/features/code-intelligence/contracts";
import { prisma } from "@/lib/db/prisma";

import { orderSymbolsByDepth, recordsToRows } from "./analysis.mappers";
import type {
  AnalysisStore,
  CreateRunInput,
  PersistResultsInput,
} from "./analysis.store";
import type {
  SnapshotFileRow,
  SnapshotHeader,
  SnapshotSourceReader,
} from "./snapshot-source";

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

export const prismaSnapshotReader: SnapshotSourceReader = {
  async findOwnedSnapshot(userId, snapshotId): Promise<SnapshotHeader | null> {
    // Ownership is part of the query: another user's snapshot is
    // indistinguishable from a missing one.
    const snapshot = await prisma.repositorySnapshot.findFirst({
      where: { id: snapshotId, repository: { ownerId: userId } },
      select: {
        id: true,
        repositoryId: true,
        commitSha: true,
        status: true,
        completeness: true,
      },
    });

    return snapshot;
  },

  async listSnapshotFiles(snapshotId): Promise<SnapshotFileRow[]> {
    const files = await prisma.snapshotFile.findMany({
      where: { snapshotId },
      orderBy: { path: "asc" },
      select: {
        id: true,
        path: true,
        status: true,
        skipReason: true,
        failureCode: true,
        storageKey: true,
        contentHash: true,
        sizeBytes: true,
      },
    });

    return files.map((file) => ({
      ...file,
      sizeBytes: file.sizeBytes === null ? null : Number(file.sizeBytes),
    }));
  },
};

export const prismaAnalysisStore: AnalysisStore = {
  async createRun(input: CreateRunInput) {
    const run = await prisma.codeAnalysis.create({
      data: {
        snapshotId: input.snapshotId,
        repositoryId: input.repositoryId,
        requestedById: input.requestedById,
        commitSha: input.commitSha,
        snapshotCompleteness: input.snapshotCompleteness as
          "COMPLETE" | "PARTIAL" | "FAILED" | null,
        engineVersion: input.engineVersion,
        parserVersion: input.parserVersion,
        status: "PENDING",
      },
      select: { id: true },
    });

    return run;
  },

  async markProcessing(analysisId) {
    await prisma.codeAnalysis.update({
      where: { id: analysisId },
      data: { status: "PROCESSING", startedAt: new Date() },
    });
  },

  async persistResults(analysisId, input: PersistResultsInput) {
    const rows = recordsToRows(analysisId, input.records);
    const symbols = orderSymbolsByDepth(rows.symbols);

    await prisma.$transaction(
      async (tx) => {
        await tx.analysisFile.createMany({
          data: rows.files as Prisma.AnalysisFileCreateManyInput[],
        });

        for (const batch of chunk(symbols, BATCH_SIZE)) {
          await tx.codeSymbol.createMany({
            data: batch.map((row) => ({
              ...row,
              details: json(row.details),
            })) as Prisma.CodeSymbolCreateManyInput[],
          });
        }

        for (const batch of chunk(rows.dependencies, BATCH_SIZE)) {
          await tx.moduleDependency.createMany({
            data: batch.map((row) => ({
              ...row,
              bindings: json(row.bindings),
            })) as Prisma.ModuleDependencyCreateManyInput[],
          });
        }

        for (const batch of chunk(rows.calls, BATCH_SIZE)) {
          await tx.codeCall.createMany({
            data: batch as Prisma.CodeCallCreateManyInput[],
          });
        }

        for (const batch of chunk(rows.relations, BATCH_SIZE)) {
          await tx.codeRelation.createMany({
            data: batch as Prisma.CodeRelationCreateManyInput[],
          });
        }

        for (const batch of chunk(rows.diagnostics, BATCH_SIZE)) {
          await tx.analysisDiagnostic.createMany({
            data: batch.map((row) => ({
              ...row,
              details: nullableJson(row.details),
            })) as Prisma.AnalysisDiagnosticCreateManyInput[],
          });
        }

        await tx.analysisGraph.create({
          data: {
            analysisId,
            schemaVersion: GRAPH_SCHEMA_VERSION,
            nodeCount: input.graph.nodes.length,
            edgeCount: input.graph.edges.length,
            graph: json(input.graph),
          },
        });

        await tx.codeAnalysis.update({
          where: { id: analysisId },
          data: {
            status: input.status,
            stats: json(input.stats),
            graphSchemaVersion: GRAPH_SCHEMA_VERSION,
            completedAt: new Date(),
          },
        });
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 10_000 },
    );
  },

  async markFailed(analysisId, input) {
    const diagnostics: DiagnosticRecord[] = input.diagnostics;

    await prisma.$transaction(async (tx) => {
      await tx.analysisDiagnostic.createMany({
        data: diagnostics.map((d) => ({
          analysisId,
          fileId: null,
          severity: d.severity,
          source: d.source,
          code: d.code,
          message: d.message,
          path: d.path,
          line: d.line,
          column: d.column,
          details: nullableJson(d.details),
        })) as Prisma.AnalysisDiagnosticCreateManyInput[],
      });

      await tx.codeAnalysis.update({
        where: { id: analysisId },
        data: {
          status: "FAILED",
          errorCode: input.errorCode,
          errorMessage: input.errorMessage,
          stats: input.stats ? json(input.stats) : Prisma.JsonNull,
          completedAt: new Date(),
        },
      });
    });
  },
};
