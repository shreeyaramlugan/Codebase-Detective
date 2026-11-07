// lib/analysis/analysis.mappers.ts
//
// Pure mapping between engine records and relational rows. Used both when
// persisting and when regenerating the graph from stored rows, which is what
// guarantees the read model can always be rebuilt from the source of truth.
import { randomUUID } from "node:crypto";

import type {
  AnalysisRecords,
  CallRecord,
  DependencyBinding,
  DependencyRecord,
  DiagnosticRecord,
  FileRecord,
  RelationRecord,
  SourceLocation,
  SymbolRecord,
} from "@/features/code-intelligence/contracts";
import { createSymbolRowId } from "@/features/code-intelligence/registry/symbol-identity";

type LocationColumns = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

const toColumns = (l: SourceLocation): LocationColumns => ({
  startLine: l.startLine,
  startColumn: l.startColumn,
  endLine: l.endLine,
  endColumn: l.endColumn,
});

const fromColumns = (c: LocationColumns): SourceLocation => ({
  startLine: c.startLine,
  startColumn: c.startColumn,
  endLine: c.endLine,
  endColumn: c.endColumn,
});

export interface FileRow {
  id: string;
  analysisId: string;
  snapshotFileId: string | null;
  path: string;
  extension: string;
  scriptKind: string | null;
  moduleSyntax: string;
  status: string;
  reason: string | null;
  contentHash: string;
  sizeBytes: number;
  lineCount: number;
  syntaxErrorCount: number;
  symbolCount: number;
}

export interface SymbolRow extends LocationColumns {
  id: string;
  analysisId: string;
  fileId: string;
  stableKey: string;
  name: string;
  kind: string;
  qualifiedName: string;
  parentId: string | null;
  isExported: boolean;
  isDefaultExport: boolean;
  exportNames: string[];
  details: unknown;
}

export interface DependencyRow extends LocationColumns {
  analysisId: string;
  fileId: string;
  key: string;
  sourcePath: string;
  kind: string;
  specifier: string;
  isTypeOnly: boolean;
  moduleSystem: string;
  bindings: unknown;
  status: string;
  targetPath: string | null;
  targetAnalysed: boolean;
  externalPackage: string | null;
  reason: string;
  candidates: string[];
  evidence: string[];
}

export interface CallRow extends LocationColumns {
  analysisId: string;
  fileId: string;
  key: string;
  sourcePath: string;
  kind: string;
  callerSymbolId: string | null;
  calleeText: string;
  optional: boolean;
  resolution: string;
  targetSymbolId: string | null;
  reason: string;
}

export interface RelationRow extends LocationColumns {
  analysisId: string;
  fileId: string;
  key: string;
  kind: string;
  sourcePath: string;
  sourceSymbolId: string | null;
  targetName: string;
  targetSymbolId: string | null;
  status: string;
  reason: string;
}

export interface DiagnosticRow {
  analysisId: string;
  fileId: string | null;
  severity: string;
  source: string;
  code: string;
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
  details: unknown;
}

export interface AnalysisRows {
  files: FileRow[];
  symbols: SymbolRow[];
  dependencies: DependencyRow[];
  calls: CallRow[];
  relations: RelationRow[];
  diagnostics: DiagnosticRow[];
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

export function recordsToRows(
  analysisId: string,
  records: AnalysisRecords,
): AnalysisRows {
  const fileIds = new Map<string, string>();

  const files: FileRow[] = records.files.map((file) => {
    const id = randomUUID();
    fileIds.set(file.path, id);
    return {
      id,
      analysisId,
      snapshotFileId: file.fileId,
      path: file.path,
      extension: file.extension,
      scriptKind: file.scriptKind,
      moduleSyntax: file.moduleSyntax,
      status: file.status,
      reason: file.reason,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      lineCount: file.lineCount,
      syntaxErrorCount: file.syntaxErrorCount,
      symbolCount: file.symbolCount,
    };
  });

  const fileIdFor = (path: string): string => {
    const id = fileIds.get(path);
    if (!id) throw new MappingError(`No analysed file record for ${path}.`);
    return id;
  };

  const symbolIds = new Map<string, string>();
  for (const symbol of records.symbols) {
    symbolIds.set(symbol.key, createSymbolRowId(analysisId, symbol.key));
  }

  const symbolIdFor = (key: string | null): string | null => {
    if (key === null) return null;
    const id = symbolIds.get(key);
    if (!id) throw new MappingError(`Reference to unknown symbol ${key}.`);
    return id;
  };

  const symbols: SymbolRow[] = records.symbols.map((symbol) => ({
    id: symbolIds.get(symbol.key) as string,
    analysisId,
    fileId: fileIdFor(symbol.filePath),
    stableKey: symbol.key,
    name: symbol.name,
    kind: symbol.kind,
    qualifiedName: symbol.qualifiedName,
    parentId: symbolIdFor(symbol.parentKey),
    isExported: symbol.isExported,
    isDefaultExport: symbol.isDefaultExport,
    exportNames: symbol.exportNames,
    ...toColumns(symbol.location),
    details: symbol.details,
  }));

  return {
    files,
    symbols,
    dependencies: records.dependencies.map((dep) => ({
      analysisId,
      fileId: fileIdFor(dep.sourcePath),
      key: dep.key,
      sourcePath: dep.sourcePath,
      kind: dep.kind,
      specifier: dep.specifier,
      isTypeOnly: dep.isTypeOnly,
      moduleSystem: dep.moduleSystem,
      bindings: dep.bindings,
      ...toColumns(dep.location),
      status: dep.status,
      targetPath: dep.targetPath,
      targetAnalysed: dep.targetAnalysed,
      externalPackage: dep.externalPackage,
      reason: dep.reason,
      candidates: dep.candidates,
      evidence: dep.evidence,
    })),
    calls: records.calls.map((call) => ({
      analysisId,
      fileId: fileIdFor(call.sourcePath),
      key: call.key,
      sourcePath: call.sourcePath,
      kind: call.kind,
      callerSymbolId: symbolIdFor(call.callerKey),
      calleeText: call.calleeText,
      optional: call.optional,
      resolution: call.resolution,
      targetSymbolId: symbolIdFor(call.targetKey),
      reason: call.reason,
      ...toColumns(call.location),
    })),
    relations: records.relations.map((relation) => ({
      analysisId,
      fileId: fileIdFor(relation.sourcePath),
      key: relation.key,
      kind: relation.kind,
      sourcePath: relation.sourcePath,
      sourceSymbolId: symbolIdFor(relation.sourceKey),
      targetName: relation.targetName,
      targetSymbolId: symbolIdFor(relation.targetKey),
      status: relation.status,
      reason: relation.reason,
      ...toColumns(relation.location),
    })),
    diagnostics: records.diagnostics.map((d) => ({
      analysisId,
      fileId: d.path ? (fileIds.get(d.path) ?? null) : null,
      severity: d.severity,
      source: d.source,
      code: d.code,
      message: d.message,
      path: d.path,
      line: d.line,
      column: d.column,
      details: d.details,
    })),
  };
}

/** Rows as read back from the database, including joined file paths. */
export interface StoredRows {
  files: FileRow[];
  symbols: SymbolRow[];
  dependencies: DependencyRow[];
  calls: CallRow[];
  relations: RelationRow[];
  diagnostics: DiagnosticRow[];
}

export function rowsToRecords(rows: StoredRows): AnalysisRecords {
  const filePaths = new Map(rows.files.map((file) => [file.id, file.path]));
  const keyById = new Map(
    rows.symbols.map((symbol) => [symbol.id, symbol.stableKey]),
  );

  const keyFor = (id: string | null): string | null => {
    if (id === null) return null;
    const key = keyById.get(id);
    if (!key) throw new MappingError(`Row references unknown symbol ${id}.`);
    return key;
  };

  const files: FileRecord[] = rows.files.map((row) => ({
    path: row.path,
    fileId: row.snapshotFileId,
    contentHash: row.contentHash,
    extension: row.extension,
    scriptKind: row.scriptKind as FileRecord["scriptKind"],
    moduleSyntax: row.moduleSyntax as FileRecord["moduleSyntax"],
    status: row.status as FileRecord["status"],
    reason: row.reason,
    sizeBytes: row.sizeBytes,
    lineCount: row.lineCount,
    syntaxErrorCount: row.syntaxErrorCount,
    symbolCount: row.symbolCount,
  }));

  const symbols: SymbolRecord[] = rows.symbols.map((row) => {
    const filePath = filePaths.get(row.fileId);
    if (!filePath)
      throw new MappingError(`Symbol ${row.id} references an unknown file.`);
    return {
      key: row.stableKey,
      filePath,
      name: row.name,
      kind: row.kind as SymbolRecord["kind"],
      qualifiedName: row.qualifiedName,
      parentKey: keyFor(row.parentId),
      isExported: row.isExported,
      isDefaultExport: row.isDefaultExport,
      exportNames: row.exportNames,
      location: fromColumns(row),
      details: (row.details ?? {}) as Record<string, unknown>,
    };
  });

  const dependencies: DependencyRecord[] = rows.dependencies.map((row) => ({
    key: row.key,
    sourcePath: row.sourcePath,
    kind: row.kind as DependencyRecord["kind"],
    specifier: row.specifier,
    isTypeOnly: row.isTypeOnly,
    moduleSystem: row.moduleSystem as DependencyRecord["moduleSystem"],
    bindings: (row.bindings ?? []) as DependencyBinding[],
    location: fromColumns(row),
    status: row.status as DependencyRecord["status"],
    targetPath: row.targetPath,
    targetAnalysed: row.targetAnalysed,
    externalPackage: row.externalPackage,
    reason: row.reason,
    candidates: row.candidates,
    evidence: row.evidence,
  }));

  const calls: CallRecord[] = rows.calls.map((row) => ({
    key: row.key,
    sourcePath: row.sourcePath,
    callerKey: keyFor(row.callerSymbolId),
    kind: row.kind as CallRecord["kind"],
    calleeText: row.calleeText,
    optional: row.optional,
    resolution: row.resolution as CallRecord["resolution"],
    targetKey: keyFor(row.targetSymbolId),
    reason: row.reason,
    location: fromColumns(row),
  }));

  const relations: RelationRecord[] = rows.relations.map((row) => ({
    key: row.key,
    kind: row.kind as RelationRecord["kind"],
    sourcePath: row.sourcePath,
    sourceKey: keyFor(row.sourceSymbolId),
    targetName: row.targetName,
    targetKey: keyFor(row.targetSymbolId),
    status: row.status as RelationRecord["status"],
    reason: row.reason,
    location: fromColumns(row),
  }));

  const diagnostics: DiagnosticRecord[] = rows.diagnostics.map((row) => ({
    severity: row.severity as DiagnosticRecord["severity"],
    source: row.source as DiagnosticRecord["source"],
    code: row.code,
    message: row.message,
    path: row.path,
    line: row.line,
    column: row.column,
    details: (row.details ?? null) as Record<string, unknown> | null,
  }));

  return { files, symbols, dependencies, calls, relations, diagnostics };
}

/** Parents before children, so a self-referencing insert never violates FKs. */
export function orderSymbolsByDepth(
  symbols: readonly SymbolRow[],
): SymbolRow[] {
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const depth = new Map<string, number>();

  const depthOf = (symbol: SymbolRow): number => {
    const cached = depth.get(symbol.id);
    if (cached !== undefined) return cached;
    const parent = symbol.parentId ? byId.get(symbol.parentId) : undefined;
    const value = parent ? depthOf(parent) + 1 : 0;
    depth.set(symbol.id, value);
    return value;
  };

  return [...symbols].sort((a, b) => depthOf(a) - depthOf(b));
}
