// lib/analysis/analysis.service.ts
//
// Public, owner-scoped service used by the API routes. Every query includes
// the owner in the WHERE clause, so another user's analysis is
// indistinguishable from a missing one. Responses never contain storage keys
// (they are not stored on any analysis table).
import type { Prisma } from "@prisma/client";

import { ENGINE_VERSION } from "@/features/code-intelligence/contracts";
import { buildGraph } from "@/features/code-intelligence/graph/build-graph";
import type { DependencyGraph } from "@/features/code-intelligence/graph/graph.types";
import { validateGraph } from "@/features/code-intelligence/graph/validate-graph";
import { prisma } from "@/lib/db/prisma";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";

import { AnalysisError } from "./analysis.errors";
import { rowsToRecords, type StoredRows } from "./analysis.mappers";
import {
  prismaAnalysisStore,
  prismaSnapshotReader,
} from "./analysis.prisma-store";
import { runSnapshotAnalysis, type AnalysisRunResult } from "./analysis.runner";

const DEFAULT_PAGE = 200;
const MAX_PAGE = 1000;

export interface AnalysisSummaryView {
  id: string;
  snapshotId: string;
  repositoryId: string;
  commitSha: string;
  status: string;
  /** Completeness of the snapshot that was analysed. */
  snapshotCompleteness: string | null;
  /** True only for COMPLETED runs over a COMPLETE snapshot. */
  isComplete: boolean;
  engineVersion: string;
  parserVersion: string;
  stats: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface PageOptions {
  limit?: number;
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Drops internal columns (analysis/file foreign keys) from API rows. */
function withoutInternalIds<T extends object>(
  row: T,
): Omit<T, "analysisId" | "fileId"> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.analysisId;
  delete copy.fileId;
  return copy as Omit<T, "analysisId" | "fileId">;
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PAGE;
  return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE);
}

function toSummary(analysis: {
  id: string;
  snapshotId: string;
  repositoryId: string;
  commitSha: string;
  status: string;
  snapshotCompleteness: string | null;
  engineVersion: string;
  parserVersion: string;
  stats: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): AnalysisSummaryView {
  return {
    id: analysis.id,
    snapshotId: analysis.snapshotId,
    repositoryId: analysis.repositoryId,
    commitSha: analysis.commitSha,
    status: analysis.status,
    snapshotCompleteness: analysis.snapshotCompleteness,
    isComplete:
      analysis.status === "COMPLETED" &&
      analysis.snapshotCompleteness === "COMPLETE",
    engineVersion: analysis.engineVersion,
    parserVersion: analysis.parserVersion,
    stats: analysis.stats,
    errorCode: analysis.errorCode,
    errorMessage: analysis.errorMessage,
    startedAt: analysis.startedAt?.toISOString() ?? null,
    completedAt: analysis.completedAt?.toISOString() ?? null,
    createdAt: analysis.createdAt.toISOString(),
  };
}

async function requireOwnedAnalysis(userId: string, analysisId: string) {
  const analysis = await prisma.codeAnalysis.findFirst({
    where: { id: analysisId, repository: { ownerId: userId } },
  });

  if (!analysis) throw new AnalysisError("Analysis not found.", "NOT_FOUND");
  return analysis;
}

/** Starts a new immutable analysis run for an owned snapshot. */
export async function startSnapshotAnalysis(
  userId: string,
  snapshotId: string,
  storage?: SourceStorage,
): Promise<AnalysisRunResult> {
  return runSnapshotAnalysis(
    {
      reader: prismaSnapshotReader,
      storage: storage ?? createSourceStorageAdapter(),
      store: prismaAnalysisStore,
    },
    { userId, snapshotId },
  );
}

export async function listSnapshotAnalyses(
  userId: string,
  snapshotId: string,
  limit = 50,
): Promise<AnalysisSummaryView[]> {
  const snapshot = await prisma.repositorySnapshot.findFirst({
    where: { id: snapshotId, repository: { ownerId: userId } },
    select: { id: true },
  });

  if (!snapshot) throw new AnalysisError("Snapshot not found.", "NOT_FOUND");

  const analyses = await prisma.codeAnalysis.findMany({
    where: { snapshotId, repository: { ownerId: userId } },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, Math.floor(limit)), 100),
  });

  return analyses.map(toSummary);
}

export async function getAnalysisSummary(userId: string, analysisId: string) {
  return toSummary(await requireOwnedAnalysis(userId, analysisId));
}

export async function listAnalysisSymbols(
  userId: string,
  analysisId: string,
  options: PageOptions & {
    kind?: string;
    path?: string;
    name?: string;
    exported?: boolean;
  } = {},
): Promise<Page<unknown>> {
  await requireOwnedAnalysis(userId, analysisId);
  const take = pageSize(options.limit);

  const where: Prisma.CodeSymbolWhereInput = {
    analysisId,
    ...(options.kind ? { kind: options.kind as never } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.exported !== undefined ? { isExported: options.exported } : {}),
    ...(options.path ? { file: { path: options.path } } : {}),
  };

  const rows = await prisma.codeSymbol.findMany({
    where,
    orderBy: { id: "asc" },
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    include: { file: { select: { path: true } } },
  });

  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map((row) => ({
    id: row.id,
    key: row.stableKey,
    name: row.name,
    kind: row.kind,
    qualifiedName: row.qualifiedName,
    path: row.file.path,
    parentId: row.parentId,
    isExported: row.isExported,
    isDefaultExport: row.isDefaultExport,
    exportNames: row.exportNames,
    location: {
      startLine: row.startLine,
      startColumn: row.startColumn,
      endLine: row.endLine,
      endColumn: row.endColumn,
    },
    details: row.details,
  }));

  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function listAnalysisDependencies(
  userId: string,
  analysisId: string,
  options: PageOptions & { status?: string; kind?: string; path?: string } = {},
): Promise<Page<unknown>> {
  await requireOwnedAnalysis(userId, analysisId);
  const take = pageSize(options.limit);

  const rows = await prisma.moduleDependency.findMany({
    where: {
      analysisId,
      ...(options.status ? { status: options.status as never } : {}),
      ...(options.kind ? { kind: options.kind as never } : {}),
      ...(options.path ? { sourcePath: options.path } : {}),
    },
    orderBy: { id: "asc" },
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map((dependency) => {
    const row = withoutInternalIds(dependency);
    return {
      ...row,
      location: {
        startLine: row.startLine,
        startColumn: row.startColumn,
        endLine: row.endLine,
        endColumn: row.endColumn,
      },
    };
  });

  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

export async function listAnalysisDiagnostics(
  userId: string,
  analysisId: string,
  options: PageOptions & {
    severity?: string;
    source?: string;
    path?: string;
  } = {},
): Promise<Page<unknown>> {
  await requireOwnedAnalysis(userId, analysisId);
  const take = pageSize(options.limit);

  const rows = await prisma.analysisDiagnostic.findMany({
    where: {
      analysisId,
      ...(options.severity ? { severity: options.severity as never } : {}),
      ...(options.source ? { source: options.source as never } : {}),
      ...(options.path ? { path: options.path } : {}),
    },
    orderBy: { id: "asc" },
    take: take + 1,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map(withoutInternalIds);

  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}

/**
 * Everything the analysis knows about one file. The file must belong to the
 * requested analysis, so a file id from another run (or another user) fails.
 */
export async function getAnalysisFile(
  userId: string,
  analysisId: string,
  fileId: string,
) {
  await requireOwnedAnalysis(userId, analysisId);

  const file = await prisma.analysisFile.findFirst({
    where: { id: fileId, analysisId },
  });

  if (!file)
    throw new AnalysisError("File not found in this analysis.", "NOT_FOUND");

  const [symbols, outgoing, incoming, calls, diagnostics] = await Promise.all([
    prisma.codeSymbol.findMany({
      where: { analysisId, fileId },
      orderBy: [{ startLine: "asc" }, { startColumn: "asc" }],
    }),
    prisma.moduleDependency.findMany({
      where: { analysisId, fileId },
      orderBy: [{ startLine: "asc" }, { startColumn: "asc" }],
    }),
    prisma.moduleDependency.findMany({
      where: { analysisId, targetPath: file.path, status: "RESOLVED" },
      select: {
        sourcePath: true,
        specifier: true,
        kind: true,
        startLine: true,
        startColumn: true,
      },
      orderBy: [{ sourcePath: "asc" }, { startLine: "asc" }],
    }),
    prisma.codeCall.findMany({
      where: { analysisId, fileId },
      orderBy: [{ startLine: "asc" }, { startColumn: "asc" }],
    }),
    prisma.analysisDiagnostic.findMany({
      where: { analysisId, fileId },
      orderBy: { id: "asc" },
    }),
  ]);

  const { analysisId: _unusedAnalysis, ...fileView } = file;
  void _unusedAnalysis;

  return {
    file: fileView,
    symbols: symbols.map(withoutInternalIds),
    dependencies: outgoing.map(withoutInternalIds),
    importedBy: incoming,
    calls: calls.map(withoutInternalIds),
    diagnostics: diagnostics.map(withoutInternalIds),
  };
}

async function loadStoredRows(analysisId: string): Promise<StoredRows> {
  const [files, symbols, dependencies, calls, relations, diagnostics] =
    await Promise.all([
      prisma.analysisFile.findMany({ where: { analysisId } }),
      prisma.codeSymbol.findMany({ where: { analysisId } }),
      prisma.moduleDependency.findMany({ where: { analysisId } }),
      prisma.codeCall.findMany({ where: { analysisId } }),
      prisma.codeRelation.findMany({ where: { analysisId } }),
      prisma.analysisDiagnostic.findMany({ where: { analysisId } }),
    ]);

  return {
    files,
    symbols,
    dependencies,
    calls,
    relations,
    diagnostics,
  } as unknown as StoredRows;
}

/**
 * Rebuilds the graph purely from the relational records. Read-only: it does
 * not modify the stored read model.
 */
export async function regenerateAnalysisGraph(
  userId: string,
  analysisId: string,
): Promise<DependencyGraph> {
  const analysis = await requireOwnedAnalysis(userId, analysisId);

  if (analysis.status !== "COMPLETED" && analysis.status !== "PARTIAL") {
    throw new AnalysisError("This analysis has no graph.", "GRAPH_UNAVAILABLE");
  }

  const records = rowsToRecords(await loadStoredRows(analysisId));

  const graph = buildGraph(records, {
    analysisId: analysis.id,
    snapshotId: analysis.snapshotId,
    commitSha: analysis.commitSha,
    snapshotCompleteness: analysis.snapshotCompleteness,
    engineVersion: analysis.engineVersion || ENGINE_VERSION,
    parserVersion: analysis.parserVersion,
  });

  const issues = validateGraph(graph);
  if (issues.length > 0) {
    throw new Error(`Regenerated graph is invalid: ${issues[0].message}`);
  }

  return graph;
}

export async function getAnalysisGraph(
  userId: string,
  analysisId: string,
  source: "stored" | "relational" = "stored",
): Promise<DependencyGraph> {
  if (source === "relational")
    return regenerateAnalysisGraph(userId, analysisId);

  const analysis = await requireOwnedAnalysis(userId, analysisId);

  const stored = await prisma.analysisGraph.findFirst({
    where: { analysisId: analysis.id },
    select: { graph: true },
  });

  if (!stored) {
    throw new AnalysisError("This analysis has no graph.", "GRAPH_UNAVAILABLE");
  }

  return stored.graph as unknown as DependencyGraph;
}
