// lib/ai/ai.prisma-reader.ts
//
// Prisma implementation of EvidenceReader. Every query filters by the scope's
// analysisId (or snapshotId); source text is read only through the protected
// source-content service, which verifies ownership and the SHA-256 hash.
import type { Prisma } from "@prisma/client";

import type { SnapshotScope } from "@/features/ai/assistant/contracts";
import { prisma } from "@/lib/db/prisma";
import {
  readSnapshotFileContent,
} from "@/lib/ingestion/source-content/source-content.service";
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";

import type {
  CallRow,
  DependencyRow,
  EvidenceReader,
  FindingRow,
  SymbolRow,
} from "./ai.reader";

const MAX_SOURCE_BYTES = 512 * 1024;

function names(bindings: unknown): string[] {
  if (!Array.isArray(bindings)) return [];
  const out: string[] = [];
  for (const b of bindings) {
    if (typeof b === "string") out.push(b);
    else if (b && typeof b === "object") {
      const rec = b as Record<string, unknown>;
      const value = rec.imported ?? rec.exported ?? rec.local ?? rec.name;
      if (typeof value === "string") out.push(value);
    }
  }
  return out.slice(0, 12);
}

const docMatch = (path: string) =>
  /(^|\/)readme(\.[a-z]+)?$/i.test(path) || /^docs\/.+\.md$/i.test(path);

function dependencyRow(r: {
  sourcePath: string;
  kind: string;
  specifier: string;
  status: string;
  targetPath: string | null;
  externalPackage: string | null;
  isTypeOnly: boolean;
  bindings: unknown;
  reason: string;
  startLine: number;
  endLine: number;
}): DependencyRow {
  return {
    path: r.sourcePath,
    kind: r.kind,
    specifier: r.specifier,
    status: r.status as DependencyRow["status"],
    targetPath: r.targetPath,
    externalPackage: r.externalPackage,
    isTypeOnly: r.isTypeOnly,
    names: names(r.bindings),
    reason: r.reason,
    startLine: r.startLine,
    endLine: r.endLine,
  };
}

export function createPrismaReader(
  userId: string,
  storage?: SourceStorage,
): EvidenceReader {
  return {
    async overview(scope) {
      const [files, analysed, symbols, dependencies, unresolved, stored] =
        await Promise.all([
          prisma.analysisFile.count({ where: { analysisId: scope.analysisId } }),
          prisma.analysisFile.count({
            where: {
              analysisId: scope.analysisId,
              status: { in: ["ANALYSED", "ANALYSED_WITH_ERRORS"] },
            },
          }),
          prisma.codeSymbol.count({ where: { analysisId: scope.analysisId } }),
          prisma.moduleDependency.count({
            where: { analysisId: scope.analysisId },
          }),
          prisma.moduleDependency.count({
            where: { analysisId: scope.analysisId, status: "UNRESOLVED" },
          }),
          prisma.snapshotFile.findMany({
            where: { snapshotId: scope.snapshotId, status: "STORED" },
            select: { path: true },
            take: 5000,
          }),
        ]);
      const top = new Set<string>();
      for (const { path } of stored) {
        const [first, ...rest] = path.split("/");
        top.add(rest.length ? `${first}/` : first);
      }
      return {
        files,
        analysedFiles: analysed,
        symbols,
        dependencies,
        unresolvedDependencies: unresolved,
        topLevel: [...top].sort(),
      };
    },

    async findFiles(scope, terms, limit) {
      const rows = await prisma.analysisFile.findMany({
        where: {
          analysisId: scope.analysisId,
          OR: terms.map((t) => ({
            path: { contains: t, mode: "insensitive" as const },
          })),
        },
        select: { path: true, lineCount: true, status: true },
        orderBy: { path: "asc" },
        take: limit,
      });
      return rows;
    },

    async listDocumentPaths(scope, limit) {
      const rows = await prisma.snapshotFile.findMany({
        where: {
          snapshotId: scope.snapshotId,
          status: "STORED",
          OR: [
            { path: { contains: "readme", mode: "insensitive" } },
            { path: { startsWith: "docs/" } },
          ],
        },
        select: { path: true },
        take: 300,
      });
      return rows
        .map((r) => r.path)
        .filter(docMatch)
        .sort(
          (a, b) =>
            a.split("/").length - b.split("/").length || a.localeCompare(b),
        )
        .slice(0, limit);
    },

    async findSymbols(scope, terms, limit): Promise<SymbolRow[]> {
      const rows = await prisma.codeSymbol.findMany({
        where: {
          analysisId: scope.analysisId,
          OR: terms.flatMap((t) => [
            { name: { contains: t, mode: "insensitive" as const } },
            { qualifiedName: { contains: t, mode: "insensitive" as const } },
          ]),
        },
        include: {
          file: { select: { path: true } },
          parent: { select: { name: true } },
        },
        orderBy: [{ isExported: "desc" }, { qualifiedName: "asc" }],
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        stableKey: r.stableKey,
        name: r.name,
        kind: r.kind,
        qualifiedName: r.qualifiedName,
        path: r.file.path,
        parentName: r.parent?.name ?? null,
        isExported: r.isExported,
        isDefaultExport: r.isDefaultExport,
        startLine: r.startLine,
        endLine: r.endLine,
      }));
    },

    async fileDependencies(scope, path, limit) {
      const [imports, importers] = await Promise.all([
        prisma.moduleDependency.findMany({
          where: { analysisId: scope.analysisId, sourcePath: path },
          orderBy: { startLine: "asc" },
          take: limit,
        }),
        prisma.moduleDependency.findMany({
          where: {
            analysisId: scope.analysisId,
            targetPath: path,
            status: "RESOLVED",
          },
          orderBy: { sourcePath: "asc" },
          take: limit,
        }),
      ]);
      return {
        imports: imports.map(dependencyRow),
        importers: importers.map(dependencyRow),
      };
    },

    async symbolCalls(scope, symbolId, limit): Promise<CallRow[]> {
      const rows = await prisma.codeCall.findMany({
        where: {
          analysisId: scope.analysisId,
          OR: [{ callerSymbolId: symbolId }, { targetSymbolId: symbolId }],
        },
        include: {
          callerSymbol: { select: { qualifiedName: true } },
          targetSymbol: {
            select: { qualifiedName: true, file: { select: { path: true } } },
          },
        },
        orderBy: [{ sourcePath: "asc" }, { startLine: "asc" }],
        take: limit,
      });
      return rows.map((r) => ({
        path: r.sourcePath,
        callerName: r.callerSymbol?.qualifiedName ?? null,
        calleeText: r.calleeText,
        resolution: r.resolution,
        targetName: r.targetSymbol?.qualifiedName ?? null,
        targetPath: r.targetSymbol?.file.path ?? null,
        reason: r.reason,
        startLine: r.startLine,
        endLine: r.endLine,
      }));
    },

    async findFindings(scope: SnapshotScope, query): Promise<FindingRow[]> {
      if (!scope.findingsRunId) return [];
      const or: Prisma.FindingWhereInput[] = [
        ...(query.paths.length ? [{ subjectPath: { in: query.paths } }] : []),
        ...query.terms.flatMap((t) => [
          { title: { contains: t, mode: "insensitive" as const } },
          { ruleId: { contains: t, mode: "insensitive" as const } },
          { subjectPath: { contains: t, mode: "insensitive" as const } },
        ]),
      ];
      if (!query.top && or.length === 0) return [];
      const rows = await prisma.finding.findMany({
        where: {
          // Scoped to the one findings run of this analysis.
          runId: scope.findingsRunId,
          run: { analysisId: scope.analysisId },
          ...(query.top ? {} : { OR: or }),
        },
        include: {
          evidence: { orderBy: { ordinal: "asc" }, take: 3 },
        },
        orderBy: [{ severity: "asc" }, { subjectPath: "asc" }],
        take: query.limit,
      });
      return rows.map((r) => ({
        ruleId: r.ruleId,
        severity: r.severity,
        certainty: r.certainty,
        title: r.title,
        description: r.description,
        subjectPath: r.subjectPath,
        primaryLine: r.primaryLine,
        measurements: r.measurements,
        evidence: r.evidence.map((e) => ({
          message: e.message,
          filePath: e.filePath,
          startLine: e.startLine,
          endLine: e.endLine,
        })),
      }));
    },

    async readSource(scope, path) {
      try {
        const result = await readSnapshotFileContent(
          {
            userId,
            repositoryId: scope.repositoryId,
            snapshotId: scope.snapshotId,
            path,
          },
          storage,
        );
        if (result.content.length > MAX_SOURCE_BYTES) return null;
        if (result.content.includes(0)) return null; // binary
        return result.content.toString("utf8");
      } catch {
        return null; // missing, corrupt or unavailable: no evidence
      }
    },
  };
}
