// lib/explorer/explorer.service.ts
//
// Read-only, owner-scoped queries that power the Sprint 04 explorer.
//
// It adds NO analysis logic: every number and row comes from the persisted
// Sprint 03 records. Every query is anchored to a CodeAnalysis (or
// Repository) that the user owns, with the owner in the WHERE clause, so
// another user's data is indistinguishable from missing data. Rows from
// different analysis runs can never be mixed because every query filters on
// the single analysisId that was ownership-checked first.
//
// The final `db` parameter exists so tests can inject a fake client.
import type { PrismaClient } from "@prisma/client";

import { AnalysisError } from "@/lib/analysis/analysis.errors";
import type { AnalysisSummaryView } from "@/lib/analysis/analysis.service";
import { prisma } from "@/lib/db/prisma";
import {
  toSnapshotSummaryView,
  type SnapshotSummaryView,
} from "@/lib/ingestion/source-content/source-content.service";
import {
  deriveOverviewState,
  type OverviewState,
} from "@/features/explorer/overview-state";
import type { TreeFileEntry } from "@/features/explorer/tree/file-tree";
import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SEARCH_CATEGORIES,
  type CategoryResults,
  type ExportSearchResult,
  type FileSearchResult,
  type ModuleSearchResult,
  type SearchCategory,
  type SymbolSearchResult,
  type UnifiedSearchResponse,
} from "@/features/explorer/search/search-model";

export type ExplorerDb = Pick<
  PrismaClient,
  | "repository"
  | "repositorySnapshot"
  | "codeAnalysis"
  | "analysisFile"
  | "snapshotFile"
  | "codeSymbol"
  | "moduleDependency"
  | "codeCall"
  | "codeRelation"
  | "analysisDiagnostic"
  | "analysisGraph"
>;

export const TREE_ENTRY_LIMIT = 25_000;
export const SYMBOL_PAGE_DEFAULT = 50;
export const SYMBOL_PAGE_MAX = 200;
export const SEARCH_LIMIT_DEFAULT = 15;
export const SEARCH_LIMIT_MAX = 50;
const HISTORY_LIMIT = 20;
const DETAIL_LIMIT = 50;

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

async function requireOwnedAnalysis(
  db: ExplorerDb,
  userId: string,
  analysisId: string,
) {
  const analysis = await db.codeAnalysis.findFirst({
    where: { id: analysisId, repository: { ownerId: userId } },
  });
  if (!analysis) throw new AnalysisError("Analysis not found.", "NOT_FOUND");
  return analysis;
}

function clamp(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

// ---------------------------------------------------------------------------
// Repository overview (04.1)
// ---------------------------------------------------------------------------

export interface ExplorerSnapshotView extends SnapshotSummaryView {
  branchName: string | null;
  commitAuthor: string | null;
  committedAt: string | null;
}

export interface AnalysisStatsView {
  files: { total: number; byStatus: Record<string, number> };
  symbols: {
    total: number;
    exported: number;
    byKind: Record<string, number>;
  };
  dependencies: { total: number; byStatus: Record<string, number> };
  calls: { total: number; byResolution: Record<string, number> };
  relations: { total: number };
  diagnostics: { total: number; bySeverity: Record<string, number> };
  graph: {
    nodeCount: number;
    edgeCount: number;
    schemaVersion: number;
  } | null;
  diagnosticsPreview: Array<{
    id: string;
    severity: string;
    source: string;
    code: string;
    message: string;
    path: string | null;
    line: number | null;
  }>;
}

export interface RepositoryExplorerOverview {
  repository: {
    id: string;
    ownerLogin: string;
    name: string;
    fullName: string;
    htmlUrl: string;
    description: string | null;
    visibility: string;
    defaultBranch: string | null;
    language: string | null;
    stars: number;
    forks: number;
    status: string;
  };
  snapshots: ExplorerSnapshotView[];
  selectedSnapshotId: string | null;
  analyses: AnalysisSummaryView[];
  selectedAnalysisId: string | null;
  stats: AnalysisStatsView | null;
  state: OverviewState;
}

function toAnalysisSummary(a: {
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
    id: a.id,
    snapshotId: a.snapshotId,
    repositoryId: a.repositoryId,
    commitSha: a.commitSha,
    status: a.status,
    snapshotCompleteness: a.snapshotCompleteness,
    isComplete:
      a.status === "COMPLETED" && a.snapshotCompleteness === "COMPLETE",
    engineVersion: a.engineVersion,
    parserVersion: a.parserVersion,
    stats: a.stats,
    errorCode: a.errorCode,
    errorMessage: a.errorMessage,
    startedAt: a.startedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

type Group = Array<{ _count: { _all: number } } & Record<string, unknown>>;

function groupToRecord(rows: Group, key: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) result[String(row[key])] = row._count._all;
  return result;
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

export async function getAnalysisStats(
  analysisId: string,
  db: ExplorerDb = prisma,
): Promise<AnalysisStatsView> {
  const [
    files,
    symbolsByKind,
    exported,
    dependencies,
    calls,
    relations,
    diagnostics,
    graph,
    preview,
  ] = await Promise.all([
    db.analysisFile.groupBy({
      by: ["status"],
      where: { analysisId },
      _count: { _all: true },
    }),
    db.codeSymbol.groupBy({
      by: ["kind"],
      where: { analysisId },
      _count: { _all: true },
    }),
    db.codeSymbol.count({ where: { analysisId, isExported: true } }),
    db.moduleDependency.groupBy({
      by: ["status"],
      where: { analysisId },
      _count: { _all: true },
    }),
    db.codeCall.groupBy({
      by: ["resolution"],
      where: { analysisId },
      _count: { _all: true },
    }),
    db.codeRelation.count({ where: { analysisId } }),
    db.analysisDiagnostic.groupBy({
      by: ["severity"],
      where: { analysisId },
      _count: { _all: true },
    }),
    db.analysisGraph.findFirst({
      where: { analysisId },
      select: { nodeCount: true, edgeCount: true, schemaVersion: true },
    }),
    db.analysisDiagnostic.findMany({
      where: { analysisId, severity: { in: ["ERROR", "WARNING"] } },
      orderBy: [{ severity: "asc" }, { id: "asc" }],
      take: 5,
      select: {
        id: true,
        severity: true,
        source: true,
        code: true,
        message: true,
        path: true,
        line: true,
      },
    }),
  ]);

  const byStatus = groupToRecord(files as unknown as Group, "status");
  const byKind = groupToRecord(symbolsByKind as unknown as Group, "kind");
  const depByStatus = groupToRecord(dependencies as unknown as Group, "status");
  const callByResolution = groupToRecord(
    calls as unknown as Group,
    "resolution",
  );
  const bySeverity = groupToRecord(diagnostics as unknown as Group, "severity");

  return {
    files: { total: sum(byStatus), byStatus },
    symbols: { total: sum(byKind), exported: exported as number, byKind },
    dependencies: { total: sum(depByStatus), byStatus: depByStatus },
    calls: { total: sum(callByResolution), byResolution: callByResolution },
    relations: { total: relations as number },
    diagnostics: { total: sum(bySeverity), bySeverity },
    graph: graph
      ? {
          nodeCount: graph.nodeCount,
          edgeCount: graph.edgeCount,
          schemaVersion: graph.schemaVersion,
        }
      : null,
    diagnosticsPreview: preview as AnalysisStatsView["diagnosticsPreview"],
  };
}

export async function getRepositoryExplorerOverview(
  userId: string,
  repositoryId: string,
  selection: { snapshotId?: string | null; analysisId?: string | null } = {},
  db: ExplorerDb = prisma,
): Promise<RepositoryExplorerOverview> {
  const repository = await db.repository.findFirst({
    where: { id: repositoryId, ownerId: userId },
    select: {
      id: true,
      ownerLogin: true,
      name: true,
      fullName: true,
      htmlUrl: true,
      description: true,
      visibility: true,
      defaultBranch: true,
      language: true,
      stars: true,
      forks: true,
      status: true,
    },
  });

  if (!repository)
    throw new AnalysisError("Repository not found.", "NOT_FOUND");

  const snapshotRows = await db.repositorySnapshot.findMany({
    where: { repositoryId, repository: { ownerId: userId } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  let snapshotId: string | null = null;
  let requestedAnalysis: Awaited<
    ReturnType<ExplorerDb["codeAnalysis"]["findFirst"]>
  > = null;

  if (selection.analysisId) {
    // An explicitly requested analysis must belong to this repository.
    requestedAnalysis = await db.codeAnalysis.findFirst({
      where: {
        id: selection.analysisId,
        repositoryId,
        repository: { ownerId: userId },
      },
    });
    if (!requestedAnalysis) {
      throw new AnalysisError("Analysis not found.", "NOT_FOUND");
    }
    snapshotId = requestedAnalysis.snapshotId;
  } else if (selection.snapshotId) {
    const owned = await db.repositorySnapshot.findFirst({
      where: {
        id: selection.snapshotId,
        repositoryId,
        repository: { ownerId: userId },
      },
      select: { id: true },
    });
    if (!owned) throw new AnalysisError("Snapshot not found.", "NOT_FOUND");
    snapshotId = owned.id;
  } else {
    const preferred =
      snapshotRows.find((s) => s.status === "COMPLETED") ?? snapshotRows[0];
    snapshotId = preferred?.id ?? null;
  }

  const snapshot = snapshotId
    ? (snapshotRows.find((s) => s.id === snapshotId) ??
      (await db.repositorySnapshot.findFirst({
        where: {
          id: snapshotId,
          repositoryId,
          repository: { ownerId: userId },
        },
      })))
    : null;

  const analysisRows = snapshotId
    ? await db.codeAnalysis.findMany({
        where: { snapshotId, repository: { ownerId: userId } },
        orderBy: { createdAt: "desc" },
        take: HISTORY_LIMIT,
      })
    : [];

  const selectedAnalysis =
    requestedAnalysis ??
    analysisRows.find(
      (a) => a.status === "COMPLETED" || a.status === "PARTIAL",
    ) ??
    analysisRows[0] ??
    null;

  const stats =
    selectedAnalysis &&
    (selectedAnalysis.status === "COMPLETED" ||
      selectedAnalysis.status === "PARTIAL")
      ? await getAnalysisStats(selectedAnalysis.id, db)
      : null;

  const snapshots: ExplorerSnapshotView[] = snapshotRows.map((row) => ({
    ...toSnapshotSummaryView(row),
    branchName: row.branchName,
    commitAuthor: row.commitAuthor,
    committedAt: row.committedAt?.toISOString() ?? null,
  }));

  return {
    repository: repository as RepositoryExplorerOverview["repository"],
    snapshots,
    selectedSnapshotId: snapshotId,
    analyses: analysisRows.map(toAnalysisSummary),
    selectedAnalysisId: selectedAnalysis?.id ?? null,
    stats,
    state: deriveOverviewState({
      snapshot: snapshot
        ? { status: snapshot.status, completeness: snapshot.completeness }
        : null,
      analysis: selectedAnalysis
        ? {
            status: selectedAnalysis.status,
            snapshotCompleteness: selectedAnalysis.snapshotCompleteness,
            errorMessage: selectedAnalysis.errorMessage,
          }
        : null,
    }),
  };
}

// ---------------------------------------------------------------------------
// File tree (04.2)
// ---------------------------------------------------------------------------

export interface AnalysisTreeView {
  analysisId: string;
  snapshotId: string;
  repositoryId: string;
  entries: TreeFileEntry[];
  truncated: boolean;
}

interface TreeSnapshotRow {
  path: string;
  name: string;
  extension: string | null;
  status: string;
  skipReason: string | null;
  failureCode: string | null;
  sizeBytes: bigint | number | null;
}

interface TreeAnalysisRow {
  id: string;
  path: string;
  extension: string;
  status: string;
  sizeBytes: number;
  lineCount: number;
  symbolCount: number;
  syntaxErrorCount: number;
}

/**
 * Every file the snapshot discovered, merged with what the analysis recorded
 * for it. Skipped and failed files are included (with their reason) so the UI
 * can distinguish "not stored" from "stored but not analysed". No storage
 * keys are selected.
 */
export async function getAnalysisTree(
  userId: string,
  analysisId: string,
  db: ExplorerDb = prisma,
): Promise<AnalysisTreeView> {
  const analysis = await requireOwnedAnalysis(db, userId, analysisId);

  const [snapshotRows, analysisRows] = await Promise.all([
    db.snapshotFile.findMany({
      where: { snapshotId: analysis.snapshotId },
      orderBy: { path: "asc" },
      take: TREE_ENTRY_LIMIT + 1,
      select: {
        path: true,
        name: true,
        extension: true,
        status: true,
        skipReason: true,
        failureCode: true,
        sizeBytes: true,
      },
    }),
    db.analysisFile.findMany({
      where: { analysisId },
      select: {
        id: true,
        path: true,
        extension: true,
        status: true,
        sizeBytes: true,
        lineCount: true,
        symbolCount: true,
        syntaxErrorCount: true,
      },
    }),
  ]);

  const snapshotFiles = snapshotRows as unknown as TreeSnapshotRow[];
  const analysisFiles = analysisRows as unknown as TreeAnalysisRow[];
  const truncated = snapshotFiles.length > TREE_ENTRY_LIMIT;
  const analysed = new Map(analysisFiles.map((f) => [f.path, f]));
  const entries: TreeFileEntry[] = [];
  const seen = new Set<string>();

  for (const file of snapshotFiles.slice(0, TREE_ENTRY_LIMIT)) {
    const a = analysed.get(file.path);
    seen.add(file.path);
    entries.push({
      path: file.path,
      name: file.name,
      extension: file.extension,
      snapshotStatus: file.status,
      skipReason: file.skipReason,
      failureCode: file.failureCode,
      analysisFileId: a?.id ?? null,
      analysisStatus: a?.status ?? null,
      sizeBytes:
        file.sizeBytes === null || file.sizeBytes === undefined
          ? (a?.sizeBytes ?? null)
          : Number(file.sizeBytes),
      lineCount: a?.lineCount ?? null,
      symbolCount: a?.symbolCount ?? null,
      syntaxErrorCount: a?.syntaxErrorCount ?? null,
    });
  }

  // Analysed files that fell outside the capped snapshot listing.
  if (truncated) {
    for (const a of analysisFiles) {
      if (seen.has(a.path)) continue;
      entries.push({
        path: a.path,
        name: a.path.split("/").pop() ?? a.path,
        extension: a.extension,
        snapshotStatus: "STORED",
        skipReason: null,
        failureCode: null,
        analysisFileId: a.id,
        analysisStatus: a.status,
        sizeBytes: a.sizeBytes,
        lineCount: a.lineCount,
        symbolCount: a.symbolCount,
        syntaxErrorCount: a.syntaxErrorCount,
      });
    }
  }

  return {
    analysisId: analysis.id,
    snapshotId: analysis.snapshotId,
    repositoryId: analysis.repositoryId,
    entries,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Symbols (04.4)
// ---------------------------------------------------------------------------

export const EXPLORER_SYMBOL_KINDS = [
  "FUNCTION",
  "CLASS",
  "METHOD",
  "INTERFACE",
  "TYPE",
  "VARIABLE",
  "ENUM",
] as const;

export interface ExplorerSymbolRow {
  id: string;
  key: string;
  name: string;
  kind: string;
  qualifiedName: string;
  path: string;
  parentId: string | null;
  isExported: boolean;
  isDefaultExport: boolean;
  exportNames: string[];
  location: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
}

type SymbolRecord = {
  id: string;
  stableKey: string;
  name: string;
  kind: string;
  qualifiedName: string;
  parentId: string | null;
  isExported: boolean;
  isDefaultExport: boolean;
  exportNames: string[];
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  file: { path: string };
};

function toSymbolRow(row: SymbolRecord): ExplorerSymbolRow {
  return {
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
  };
}

export interface SymbolQuery {
  q?: string;
  kinds?: readonly string[];
  /** Exact file path. */
  path?: string;
  pathContains?: string;
  exported?: boolean;
  /** "none" = top-level only; an id = direct children of that symbol. */
  parent?: string;
  limit?: number;
  cursor?: string | null;
}

export interface SymbolPage {
  items: ExplorerSymbolRow[];
  nextCursor: string | null;
  /** Counts per kind under the same non-kind filters (first page only). */
  facets: Record<string, number> | null;
}

function textFilter(q: string) {
  return {
    OR: [
      { name: { contains: q, mode: "insensitive" } },
      { qualifiedName: { contains: q, mode: "insensitive" } },
    ],
  };
}

export async function listExplorerSymbols(
  userId: string,
  analysisId: string,
  query: SymbolQuery = {},
  db: ExplorerDb = prisma,
): Promise<SymbolPage> {
  await requireOwnedAnalysis(db, userId, analysisId);

  const take = clamp(query.limit, SYMBOL_PAGE_DEFAULT, SYMBOL_PAGE_MAX);
  const q = query.q?.trim();

  const common = {
    analysisId,
    ...(q ? textFilter(q) : {}),
    ...(query.exported !== undefined ? { isExported: query.exported } : {}),
    ...(query.parent === "none"
      ? { parentId: null }
      : query.parent
        ? { parentId: query.parent }
        : {}),
    ...(query.path || query.pathContains
      ? {
          file: query.path
            ? { path: query.path }
            : { path: { contains: query.pathContains, mode: "insensitive" } },
        }
      : {}),
  };

  const where = {
    ...common,
    ...(query.kinds && query.kinds.length > 0
      ? { kind: { in: [...query.kinds] } }
      : {}),
  };

  const rows = (await db.codeSymbol.findMany({
    where: where as never,
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: take + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: { file: { select: { path: true } } },
  })) as unknown as SymbolRecord[];

  const hasMore = rows.length > take;
  const items = rows.slice(0, take).map(toSymbolRow);

  let facets: Record<string, number> | null = null;
  if (!query.cursor) {
    const grouped = await db.codeSymbol.groupBy({
      by: ["kind"],
      where: common as never,
      _count: { _all: true },
    });
    facets = groupToRecord(grouped as unknown as Group, "kind");
  }

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1].id : null,
    facets,
  };
}

export interface SymbolBrief {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  path: string;
  startLine: number;
}

export interface SymbolDetailView {
  symbol: ExplorerSymbolRow & { details: unknown };
  parent: SymbolBrief | null;
  children: SymbolBrief[];
  extendsOrImplements: Array<{
    kind: string;
    targetName: string;
    status: string;
    target: SymbolBrief | null;
  }>;
  extendedBy: Array<{ kind: string; source: SymbolBrief | null }>;
  callers: Array<{
    resolution: string;
    caller: SymbolBrief | null;
    path: string;
    line: number;
  }>;
  callees: Array<{
    calleeText: string;
    resolution: string;
    target: SymbolBrief | null;
    line: number;
  }>;
  limits: { perList: number };
}

type BriefRecord = {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  startLine: number;
  file: { path: string };
};

const BRIEF_SELECT = {
  id: true,
  name: true,
  kind: true,
  qualifiedName: true,
  startLine: true,
  file: { select: { path: true } },
} as const;

function toBrief(row: BriefRecord | null | undefined): SymbolBrief | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    qualifiedName: row.qualifiedName,
    path: row.file.path,
    startLine: row.startLine,
  };
}

/** One symbol with its hierarchy and relationships, scoped to one analysis. */
export async function getExplorerSymbol(
  userId: string,
  analysisId: string,
  symbolId: string,
  db: ExplorerDb = prisma,
): Promise<SymbolDetailView> {
  await requireOwnedAnalysis(db, userId, analysisId);

  // Accepts the row id or the stable key (graph nodes are keyed by stable key).
  const row = (await db.codeSymbol.findFirst({
    where: { analysisId, OR: [{ id: symbolId }, { stableKey: symbolId }] },
    include: { file: { select: { path: true } } },
  })) as unknown as (SymbolRecord & { details: unknown }) | null;

  if (!row) throw new AnalysisError("Symbol not found.", "NOT_FOUND");

  const [parent, children, relationsOut, relationsIn, callsIn, callsOut] =
    await Promise.all([
      row.parentId
        ? db.codeSymbol.findFirst({
            where: { id: row.parentId, analysisId },
            select: BRIEF_SELECT,
          })
        : Promise.resolve(null),
      db.codeSymbol.findMany({
        where: { analysisId, parentId: row.id },
        orderBy: [{ startLine: "asc" }, { startColumn: "asc" }],
        take: DETAIL_LIMIT,
        select: BRIEF_SELECT,
      }),
      db.codeRelation.findMany({
        where: { analysisId, sourceSymbolId: row.id },
        orderBy: { id: "asc" },
        take: DETAIL_LIMIT,
        select: {
          kind: true,
          targetName: true,
          status: true,
          targetSymbol: { select: BRIEF_SELECT },
        },
      }),
      db.codeRelation.findMany({
        where: { analysisId, targetSymbolId: row.id },
        orderBy: { id: "asc" },
        take: DETAIL_LIMIT,
        select: { kind: true, sourceSymbol: { select: BRIEF_SELECT } },
      }),
      db.codeCall.findMany({
        where: { analysisId, targetSymbolId: row.id },
        orderBy: [{ sourcePath: "asc" }, { startLine: "asc" }],
        take: DETAIL_LIMIT,
        select: {
          resolution: true,
          sourcePath: true,
          startLine: true,
          callerSymbol: { select: BRIEF_SELECT },
        },
      }),
      db.codeCall.findMany({
        where: { analysisId, callerSymbolId: row.id },
        orderBy: [{ startLine: "asc" }, { startColumn: "asc" }],
        take: DETAIL_LIMIT,
        select: {
          calleeText: true,
          resolution: true,
          startLine: true,
          targetSymbol: { select: BRIEF_SELECT },
        },
      }),
    ]);

  const out = relationsOut as unknown as Array<{
    kind: string;
    targetName: string;
    status: string;
    targetSymbol: BriefRecord | null;
  }>;
  const inc = relationsIn as unknown as Array<{
    kind: string;
    sourceSymbol: BriefRecord | null;
  }>;
  const ci = callsIn as unknown as Array<{
    resolution: string;
    sourcePath: string;
    startLine: number;
    callerSymbol: BriefRecord | null;
  }>;
  const co = callsOut as unknown as Array<{
    calleeText: string;
    resolution: string;
    startLine: number;
    targetSymbol: BriefRecord | null;
  }>;

  return {
    symbol: { ...toSymbolRow(row), details: row.details },
    parent: toBrief(parent as unknown as BriefRecord | null),
    children: (children as unknown as BriefRecord[]).map((c) => toBrief(c)!),
    extendsOrImplements: out.map((r) => ({
      kind: r.kind,
      targetName: r.targetName,
      status: r.status,
      target: toBrief(r.targetSymbol),
    })),
    extendedBy: inc.map((r) => ({
      kind: r.kind,
      source: toBrief(r.sourceSymbol),
    })),
    callers: ci.map((c) => ({
      resolution: c.resolution,
      caller: toBrief(c.callerSymbol),
      path: c.sourcePath,
      line: c.startLine,
    })),
    callees: co.map((c) => ({
      calleeText: c.calleeText,
      resolution: c.resolution,
      target: toBrief(c.targetSymbol),
      line: c.startLine,
    })),
    limits: { perList: DETAIL_LIMIT },
  };
}

// ---------------------------------------------------------------------------
// Unified search (04.6)
// ---------------------------------------------------------------------------

export interface SearchOptions {
  q: string;
  categories?: readonly SearchCategory[];
  limit?: number;
}

export function normaliseSearchQuery(raw: string): string {
  const q = raw.trim();
  if (q.length < MIN_QUERY_LENGTH) {
    throw new AnalysisError(
      `Search text must be at least ${MIN_QUERY_LENGTH} characters.`,
      "INVALID_QUERY",
    );
  }
  if (q.length > MAX_QUERY_LENGTH) {
    throw new AnalysisError(
      `Search text must be at most ${MAX_QUERY_LENGTH} characters.`,
      "INVALID_QUERY",
    );
  }
  return q;
}

function limited<T>(rows: T[], limit: number): CategoryResults<T> {
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function searchAnalysis(
  userId: string,
  analysisId: string,
  options: SearchOptions,
  db: ExplorerDb = prisma,
): Promise<UnifiedSearchResponse> {
  const q = normaliseSearchQuery(options.q);
  await requireOwnedAnalysis(db, userId, analysisId);

  const limit = clamp(options.limit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX);
  const wanted = new Set<SearchCategory>(
    options.categories && options.categories.length > 0
      ? options.categories
      : SEARCH_CATEGORIES,
  );

  const insensitive = "insensitive" as const;
  const results: UnifiedSearchResponse["results"] = {};

  const tasks: Array<Promise<void>> = [];

  if (wanted.has("files")) {
    tasks.push(
      (async () => {
        const rows = (await db.analysisFile.findMany({
          where: { analysisId, path: { contains: q, mode: insensitive } },
          orderBy: { path: "asc" },
          take: limit + 1,
          select: { path: true, status: true, symbolCount: true },
        })) as unknown as Array<{
          path: string;
          status: string;
          symbolCount: number;
        }>;
        const mapped: FileSearchResult[] = rows.map((r) => ({
          path: r.path,
          name: r.path.split("/").pop() ?? r.path,
          status: r.status,
          symbolCount: r.symbolCount,
        }));
        results.files = limited(mapped, limit);
      })(),
    );
  }

  if (wanted.has("symbols")) {
    tasks.push(
      (async () => {
        const rows = (await db.codeSymbol.findMany({
          where: { analysisId, ...textFilter(q) } as never,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: limit + 1,
          include: { file: { select: { path: true } } },
        })) as unknown as SymbolRecord[];
        const mapped: SymbolSearchResult[] = rows.map(toSymbolSearchResult);
        results.symbols = limited(mapped, limit);
      })(),
    );
  }

  if (wanted.has("exports")) {
    tasks.push(
      (async () => {
        const rows = (await db.codeSymbol.findMany({
          where: {
            analysisId,
            OR: [
              { isExported: true, ...textFilter(q) },
              // Aliased exports (`export { a as b }`) match on the exported
              // name; this is an exact, case-sensitive match.
              { isExported: true, exportNames: { has: q } },
            ],
          } as never,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: limit + 1,
          include: { file: { select: { path: true } } },
        })) as unknown as SymbolRecord[];
        const mapped: ExportSearchResult[] = rows.map((row) => ({
          ...toSymbolSearchResult(row),
          exportNames: row.exportNames,
          isDefaultExport: row.isDefaultExport,
        }));
        results.exports = limited(mapped, limit);
      })(),
    );
  }

  if (wanted.has("modules")) {
    tasks.push(
      (async () => {
        const rows = (await db.moduleDependency.findMany({
          where: {
            analysisId,
            OR: [
              { specifier: { contains: q, mode: insensitive } },
              { externalPackage: { contains: q, mode: insensitive } },
              { targetPath: { contains: q, mode: insensitive } },
            ],
          },
          distinct: ["specifier", "status", "targetPath"],
          orderBy: [
            { specifier: "asc" },
            { status: "asc" },
            { targetPath: "asc" },
          ],
          take: limit + 1,
          select: {
            specifier: true,
            status: true,
            targetPath: true,
            externalPackage: true,
            sourcePath: true,
            startLine: true,
          },
        })) as unknown as Array<{
          specifier: string;
          status: string;
          targetPath: string | null;
          externalPackage: string | null;
          sourcePath: string;
          startLine: number;
        }>;
        const mapped: ModuleSearchResult[] = rows.map((r) => ({
          specifier: r.specifier,
          status: r.status,
          targetPath: r.status === "RESOLVED" ? r.targetPath : null,
          externalPackage: r.externalPackage,
          importedBy: { path: r.sourcePath, line: r.startLine },
        }));
        results.modules = limited(mapped, limit);
      })(),
    );
  }

  await Promise.all(tasks);

  return { query: q, analysisId, results };
}

function toSymbolSearchResult(row: SymbolRecord): SymbolSearchResult {
  return {
    id: row.id,
    name: row.name,
    qualifiedName: row.qualifiedName,
    kind: row.kind,
    path: row.file.path,
    startLine: row.startLine,
    startColumn: row.startColumn,
    isExported: row.isExported,
  };
}
