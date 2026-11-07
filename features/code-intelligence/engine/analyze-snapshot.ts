// features/code-intelligence/engine/analyze-snapshot.ts
//
// The pure analysis pipeline. It receives already-loaded, hash-verified file
// contents and returns structured records. It has no database, storage or
// network access, never executes repository code, and is deterministic: the
// same inputs always produce the same output (files are processed in sorted
// path order and every output list is sorted).
//
//   parse -> extract -> register symbols -> read config -> resolve modules
//         -> link calls/relations -> assemble records
import {
  ANALYSIS_LIMITS,
  type AnalysisRecords,
  type AnalysisStats,
  type DependencyRecord,
  type DiagnosticRecord,
  type EngineSourceFile,
  type FileRecord,
  type UnavailableFile,
} from "../contracts";
import { extractFile, type ExtractedFile } from "../extraction/extract-file";
import { getExtension, getScriptKindName } from "../parser/script-kind";
import { parseSource } from "../parser/source-parser";
import { SymbolRegistry } from "../registry/symbol-registry";
import { linkCallsAndRelations } from "../resolution/linker";
import { ModuleResolver } from "../resolution/module-resolver";
import { loadProjectConfig } from "../resolution/project-config";

export interface EngineInput {
  /** Source files whose content was loaded and hash-verified. */
  sources: readonly EngineSourceFile[];
  /** package.json / tsconfig / jsconfig files, loaded and hash-verified. */
  configs: readonly EngineSourceFile[];
  /** Other stored files (assets, JSON, ...) known to exist but not parsed. */
  otherStoredPaths: readonly string[];
  /** Snapshot files that exist but could not be analysed, with the reason. */
  unavailable: readonly UnavailableFile[];
  /** File records for sources rejected before parsing (corrupt, missing, ...). */
  rejectedFiles?: readonly FileRecord[];
  /** Diagnostics raised while loading the snapshot. */
  loadDiagnostics?: readonly DiagnosticRecord[];
  snapshotCompleteness: string | null;
}

export interface EngineOutput {
  records: AnalysisRecords;
  stats: AnalysisStats;
}

export class EngineConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineConsistencyError";
  }
}

const MAX_SYNTAX_DIAGNOSTICS_PER_FILE = 200;

function engineDiagnostic(
  severity: DiagnosticRecord["severity"],
  code: string,
  message: string,
  path: string | null,
  source: DiagnosticRecord["source"] = "ENGINE",
): DiagnosticRecord {
  return {
    severity,
    source,
    code,
    message,
    path,
    line: null,
    column: null,
    details: null,
  };
}

function compareDiagnostics(a: DiagnosticRecord, b: DiagnosticRecord): number {
  return (
    (a.path ?? "").localeCompare(b.path ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    a.code.localeCompare(b.code) ||
    a.message.localeCompare(b.message)
  );
}

export function analyzeSnapshotSources(input: EngineInput): EngineOutput {
  const diagnostics: DiagnosticRecord[] = [...(input.loadDiagnostics ?? [])];
  const fileRecords: FileRecord[] = [...(input.rejectedFiles ?? [])];
  const extracted: ExtractedFile[] = [];
  const unavailable = new Map<string, string>(
    input.unavailable.map((file) => [file.path, file.reason]),
  );

  for (const rejected of input.rejectedFiles ?? []) {
    unavailable.set(rejected.path, rejected.reason ?? rejected.status);
  }

  // ---------- parse and extract ----------

  const sources = [...input.sources].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  let totalBytes = 0;
  let analysedCount = 0;

  const skip = (
    file: EngineSourceFile,
    code: string,
    message: string,
    severity: DiagnosticRecord["severity"],
  ) => {
    fileRecords.push({
      path: file.path,
      fileId: file.fileId,
      contentHash: file.contentHash,
      extension: getExtension(file.path),
      scriptKind: getScriptKindName(file.path),
      moduleSyntax: "UNKNOWN",
      status: "SKIPPED",
      reason: message,
      sizeBytes: file.sizeBytes,
      lineCount: 0,
      syntaxErrorCount: 0,
      symbolCount: 0,
    });
    unavailable.set(file.path, `SKIPPED: ${message}`);
    diagnostics.push(engineDiagnostic(severity, code, message, file.path));
  };

  for (const file of sources) {
    if (getScriptKindName(file.path) === null) {
      skip(
        file,
        "UNSUPPORTED_EXTENSION",
        "File extension is not a supported JavaScript/TypeScript source type.",
        "INFO",
      );
      continue;
    }

    if (
      Buffer.byteLength(file.content, "utf8") > ANALYSIS_LIMITS.MAX_FILE_BYTES
    ) {
      skip(
        file,
        "OVERSIZED_SOURCE",
        `File is larger than the ${ANALYSIS_LIMITS.MAX_FILE_BYTES}-byte analysis limit and was not parsed.`,
        "WARNING",
      );
      continue;
    }

    if (
      analysedCount >= ANALYSIS_LIMITS.MAX_FILES ||
      totalBytes + file.sizeBytes > ANALYSIS_LIMITS.MAX_TOTAL_BYTES
    ) {
      skip(
        file,
        "ANALYSIS_LIMIT_EXCEEDED",
        "The analysis file-count or size limit was reached; this file was not parsed.",
        "WARNING",
      );
      continue;
    }

    try {
      const parsed = parseSource(file.path, file.content);
      const result = extractFile(parsed, file.path);

      const syntaxDiagnostics = parsed.syntaxDiagnostics;
      diagnostics.push(
        ...syntaxDiagnostics.slice(0, MAX_SYNTAX_DIAGNOSTICS_PER_FILE),
      );
      if (syntaxDiagnostics.length > MAX_SYNTAX_DIAGNOSTICS_PER_FILE) {
        diagnostics.push(
          engineDiagnostic(
            "WARNING",
            "SYNTAX_DIAGNOSTICS_TRUNCATED",
            `${syntaxDiagnostics.length - MAX_SYNTAX_DIAGNOSTICS_PER_FILE} further syntax errors were omitted.`,
            file.path,
            "PARSER",
          ),
        );
      }
      diagnostics.push(...result.diagnostics);

      fileRecords.push({
        path: file.path,
        fileId: file.fileId,
        contentHash: file.contentHash,
        extension: getExtension(file.path),
        scriptKind: parsed.scriptKind,
        moduleSyntax: result.moduleSyntax,
        status:
          syntaxDiagnostics.length > 0 ? "ANALYSED_WITH_ERRORS" : "ANALYSED",
        reason:
          syntaxDiagnostics.length > 0
            ? `${syntaxDiagnostics.length} syntax error(s); extraction is best-effort for this file.`
            : null,
        sizeBytes: file.sizeBytes,
        lineCount: parsed.lineCount,
        syntaxErrorCount: syntaxDiagnostics.length,
        symbolCount: result.symbols.length,
      });

      extracted.push(result);
      analysedCount += 1;
      totalBytes += file.sizeBytes;
    } catch (error) {
      // One bad file never terminates the run.
      const message = error instanceof Error ? error.message : "Unknown error";
      fileRecords.push({
        path: file.path,
        fileId: file.fileId,
        contentHash: file.contentHash,
        extension: getExtension(file.path),
        scriptKind: getScriptKindName(file.path),
        moduleSyntax: "UNKNOWN",
        status: "FAILED",
        reason: "Analysis of this file failed unexpectedly.",
        sizeBytes: file.sizeBytes,
        lineCount: 0,
        syntaxErrorCount: 0,
        symbolCount: 0,
      });
      unavailable.set(file.path, "FAILED: analysis error");
      diagnostics.push(
        engineDiagnostic(
          "ERROR",
          "FILE_ANALYSIS_FAILED",
          `Analysis failed: ${message}`,
          file.path,
        ),
      );
    }
  }

  // ---------- symbol registry ----------

  const registry = new SymbolRegistry();
  for (const file of extracted) {
    for (const symbol of file.symbols) registry.add(symbol);
  }

  const analysedPaths = new Set(extracted.map((file) => file.path));
  const registryProblems = registry.validate(analysedPaths);
  if (registryProblems.length > 0) {
    throw new EngineConsistencyError(
      `Symbol registry validation failed: ${registryProblems.slice(0, 5).join("; ")}`,
    );
  }

  // ---------- configuration ----------

  const config = loadProjectConfig(
    input.configs.map((file) => ({ path: file.path, text: file.content })),
  );
  diagnostics.push(...config.diagnostics);

  for (const file of input.configs) {
    fileRecords.push({
      path: file.path,
      fileId: file.fileId,
      contentHash: file.contentHash,
      extension: getExtension(file.path),
      scriptKind: null,
      moduleSyntax: "UNKNOWN",
      status: "CONFIG",
      reason: null,
      sizeBytes: file.sizeBytes,
      lineCount: 0,
      syntaxErrorCount: 0,
      symbolCount: 0,
    });
  }

  if (config.tsconfigs.size === 0) {
    diagnostics.push(
      engineDiagnostic(
        "INFO",
        "CONFIG_MISSING",
        "No tsconfig.json or jsconfig.json was found in the snapshot; path aliases and baseUrl resolution are unavailable. Relative, package and CommonJS resolution still apply.",
        null,
        "CONFIG",
      ),
    );
  }
  if (config.packages.size === 0) {
    diagnostics.push(
      engineDiagnostic(
        "INFO",
        "PACKAGE_METADATA_MISSING",
        "No package.json was found in the snapshot; package entry points and declared dependencies are unavailable.",
        null,
        "CONFIG",
      ),
    );
  }

  // ---------- module resolution ----------

  const otherStored = new Set<string>([
    ...input.otherStoredPaths,
    ...input.configs.map((file) => file.path),
  ]);

  const resolver = new ModuleResolver(
    {
      analysed: analysedPaths,
      otherStored,
      unavailable,
      partialSnapshot: input.snapshotCompleteness !== "COMPLETE",
    },
    config,
  );

  const dependencyRecords = new Map<string, DependencyRecord[]>();
  const usedKeys = new Set<string>();

  for (const file of extracted) {
    const records: DependencyRecord[] = [];

    for (const raw of file.dependencies) {
      const resolution = resolver.resolve({
        sourcePath: file.path,
        specifier: raw.specifier,
        kind: raw.kind,
      });

      let key = `${file.path}|${raw.location.startLine}:${raw.location.startColumn}|${raw.kind}|${raw.specifier}`;
      for (let suffix = 1; usedKeys.has(key); suffix += 1) {
        key = `${file.path}|${raw.location.startLine}:${raw.location.startColumn}|${raw.kind}|${raw.specifier}|${suffix}`;
      }
      usedKeys.add(key);

      records.push({
        key,
        sourcePath: file.path,
        kind: raw.kind,
        specifier: raw.specifier,
        isTypeOnly: raw.isTypeOnly,
        moduleSystem: raw.moduleSystem,
        bindings: raw.bindings,
        location: raw.location,
        status: resolution.status,
        targetPath: resolution.targetPath,
        targetAnalysed: resolution.targetAnalysed,
        externalPackage: resolution.externalPackage,
        reason: resolution.reason,
        candidates: resolution.candidates,
        evidence: resolution.evidence,
      });
    }

    dependencyRecords.set(file.path, records);
  }

  // ---------- linking ----------

  const linked = linkCallsAndRelations({
    files: extracted,
    dependencies: dependencyRecords,
    registry,
  });
  diagnostics.push(...linked.diagnostics);

  // ---------- assemble ----------

  const records: AnalysisRecords = {
    files: fileRecords.sort((a, b) => a.path.localeCompare(b.path)),
    symbols: [...registry.all()].sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        a.location.startLine - b.location.startLine ||
        a.location.startColumn - b.location.startColumn ||
        a.key.localeCompare(b.key),
    ),
    dependencies: [...dependencyRecords.values()]
      .flat()
      .sort((a, b) => a.key.localeCompare(b.key)),
    calls: linked.calls.sort((a, b) => a.key.localeCompare(b.key)),
    relations: linked.relations.sort((a, b) => a.key.localeCompare(b.key)),
    diagnostics: diagnostics.sort(compareDiagnostics),
  };

  const count = <T>(items: readonly T[], predicate: (item: T) => boolean) =>
    items.filter(predicate).length;

  const stats: AnalysisStats = {
    filesAnalysed: count(
      records.files,
      (f) => f.status === "ANALYSED" || f.status === "ANALYSED_WITH_ERRORS",
    ),
    filesWithSyntaxErrors: count(
      records.files,
      (f) => f.status === "ANALYSED_WITH_ERRORS",
    ),
    filesSkipped: count(records.files, (f) => f.status === "SKIPPED"),
    filesFailed: count(records.files, (f) => f.status === "FAILED"),
    symbols: records.symbols.length,
    dependencies: records.dependencies.length,
    unresolvedDependencies: count(
      records.dependencies,
      (d) => d.status === "UNRESOLVED",
    ),
    ambiguousDependencies: count(
      records.dependencies,
      (d) => d.status === "AMBIGUOUS",
    ),
    externalDependencies: count(
      records.dependencies,
      (d) => d.status === "EXTERNAL",
    ),
    calls: records.calls.length,
    confirmedCalls: count(records.calls, (c) => c.resolution === "CONFIRMED"),
    possibleCalls: count(records.calls, (c) => c.resolution === "POSSIBLE"),
    unresolvedCalls: count(records.calls, (c) => c.resolution === "UNRESOLVED"),
    relations: records.relations.length,
    droppedUnresolvedReferences: linked.droppedUnresolvedReferences,
    diagnostics: records.diagnostics.length,
  };

  return { records, stats };
}
