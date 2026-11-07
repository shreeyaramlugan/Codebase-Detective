// features/code-intelligence/contracts.ts
//
// Shared contracts for the Sprint 03 code intelligence engine.
//
// These shapes are the engine's canonical output. The persistence layer
// stores exactly these records relationally, and the graph read model is
// built from them (both at analysis time and when regenerating later), so
// there is a single definition of every fact the engine can produce.

/** Bump when extraction/resolution/graph behaviour changes (recorded per run). */
export const ENGINE_VERSION = "1.0.0";

/** Bump when the shape of the graph JSON read model changes. */
export const GRAPH_SCHEMA_VERSION = 1;

/** Safety limits. Exceeding a limit is diagnosed, never silently ignored. */
export const ANALYSIS_LIMITS = {
  /** Largest single source file parsed (matches the ingestion file limit). */
  MAX_FILE_BYTES: 1024 * 1024,
  /** Most source files parsed in one run. */
  MAX_FILES: 10_000,
  /** Most source bytes parsed in one run. */
  MAX_TOTAL_BYTES: 50 * 1024 * 1024,
  /** Deepest AST nesting that is traversed. */
  MAX_AST_DEPTH: 400,
  MAX_SYMBOLS_PER_FILE: 20_000,
  MAX_CALLS_PER_FILE: 10_000,
  /** Evidence locations kept on one merged graph edge. */
  MAX_EVIDENCE_PER_EDGE: 25,
  /** Longest source excerpt stored in a record. */
  MAX_TEXT_LENGTH: 200,
  /** Largest package.json / tsconfig considered. */
  MAX_CONFIG_BYTES: 256 * 1024,
} as const;

export type ScriptKindName = "JS" | "JSX" | "TS" | "TSX";
export type ModuleSyntax = "ESM" | "COMMONJS" | "UNKNOWN";

/** 1-based line and column, matching editor conventions. */
export interface SourceLocation {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type SymbolKind =
  "FUNCTION" | "CLASS" | "METHOD" | "INTERFACE" | "TYPE" | "VARIABLE" | "ENUM";

export type DependencyKind =
  | "IMPORT"
  | "SIDE_EFFECT_IMPORT"
  | "DYNAMIC_IMPORT"
  | "REQUIRE"
  | "RE_EXPORT"
  | "EXPORT_ALL";

export type ModuleSystem = "ESM" | "CJS";

export type ResolutionStatus =
  "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS" | "EXTERNAL";

export type CallKind = "CALL" | "NEW" | "SUPER";
export type CallResolution = "CONFIRMED" | "POSSIBLE" | "UNRESOLVED";
export type RelationKind = "EXTENDS" | "IMPLEMENTS" | "REFERENCES";

export type DiagnosticSeverity = "ERROR" | "WARNING" | "INFO";
export type DiagnosticSource =
  | "SNAPSHOT"
  | "PARSER"
  | "EXTRACTOR"
  | "RESOLVER"
  | "LINKER"
  | "CONFIG"
  | "GRAPH"
  | "ENGINE";

export type AnalysedFileStatus =
  "ANALYSED" | "ANALYSED_WITH_ERRORS" | "CONFIG" | "SKIPPED" | "FAILED";

/** One file handed to the engine. Content is untrusted text. */
export interface EngineSourceFile {
  /** Snapshot file id, kept for traceability. */
  fileId: string | null;
  /** Repository-relative POSIX path. */
  path: string;
  contentHash: string;
  sizeBytes: number;
  content: string;
}

/** A snapshot file that exists but was not (or could not be) analysed. */
export interface UnavailableFile {
  path: string;
  /** Why it is unavailable, e.g. "SKIPPED: too large". */
  reason: string;
}

export interface FileRecord {
  path: string;
  fileId: string | null;
  contentHash: string;
  extension: string;
  scriptKind: ScriptKindName | null;
  moduleSyntax: ModuleSyntax;
  status: AnalysedFileStatus;
  reason: string | null;
  sizeBytes: number;
  lineCount: number;
  syntaxErrorCount: number;
  symbolCount: number;
}

export interface SymbolRecord {
  /** Deterministic identity, independent of the analysis run. */
  key: string;
  filePath: string;
  name: string;
  kind: SymbolKind;
  qualifiedName: string;
  parentKey: string | null;
  isExported: boolean;
  isDefaultExport: boolean;
  /** Names this symbol is exported under ("default", "module.exports", ...). */
  exportNames: string[];
  location: SourceLocation;
  /** Kind-specific facts (parameters, members, generics, ...). */
  details: Record<string, unknown>;
}

export interface DependencyBinding {
  /** Name in the target module; null for default/whole-module forms. */
  imported: string | null;
  /** Local (or re-exported) name; null for none. */
  local: string | null;
  kind: "named" | "default" | "namespace" | "whole";
  isTypeOnly: boolean;
}

export interface DependencyRecord {
  key: string;
  sourcePath: string;
  kind: DependencyKind;
  /** The original module specifier, never altered. */
  specifier: string;
  isTypeOnly: boolean;
  moduleSystem: ModuleSystem;
  bindings: DependencyBinding[];
  location: SourceLocation;
  status: ResolutionStatus;
  targetPath: string | null;
  /** True when the target is a parsed source file (a graph node). */
  targetAnalysed: boolean;
  externalPackage: string | null;
  reason: string;
  candidates: string[];
  evidence: string[];
}

export interface CallRecord {
  key: string;
  sourcePath: string;
  callerKey: string | null;
  kind: CallKind;
  calleeText: string;
  optional: boolean;
  resolution: CallResolution;
  targetKey: string | null;
  reason: string;
  location: SourceLocation;
}

export interface RelationRecord {
  key: string;
  kind: RelationKind;
  sourcePath: string;
  sourceKey: string | null;
  targetName: string;
  targetKey: string | null;
  status: ResolutionStatus;
  reason: string;
  location: SourceLocation;
}

export interface DiagnosticRecord {
  severity: DiagnosticSeverity;
  source: DiagnosticSource;
  code: string;
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
  details: Record<string, unknown> | null;
}

export interface AnalysisRecords {
  files: FileRecord[];
  symbols: SymbolRecord[];
  dependencies: DependencyRecord[];
  calls: CallRecord[];
  relations: RelationRecord[];
  diagnostics: DiagnosticRecord[];
}

export interface AnalysisStats {
  filesAnalysed: number;
  filesWithSyntaxErrors: number;
  filesSkipped: number;
  filesFailed: number;
  symbols: number;
  dependencies: number;
  unresolvedDependencies: number;
  ambiguousDependencies: number;
  externalDependencies: number;
  calls: number;
  confirmedCalls: number;
  possibleCalls: number;
  unresolvedCalls: number;
  relations: number;
  droppedUnresolvedReferences: number;
  diagnostics: number;
}
