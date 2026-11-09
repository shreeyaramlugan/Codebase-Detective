// lib/ai/ai.reader.ts
//
// Read-only evidence port. Every method is already scoped to one analysis (and
// therefore one snapshot of one repository); implementations must never accept
// ids from the client.
import type { SnapshotScope } from "@/features/ai/assistant/contracts";

export interface FileRow {
  path: string;
  lineCount: number;
  status: string;
}

export interface SymbolRow {
  id: string;
  stableKey: string;
  name: string;
  kind: string;
  qualifiedName: string;
  path: string;
  parentName: string | null;
  isExported: boolean;
  isDefaultExport: boolean;
  startLine: number;
  endLine: number;
}

export interface DependencyRow {
  path: string;
  kind: string;
  specifier: string;
  status: "RESOLVED" | "UNRESOLVED" | "AMBIGUOUS" | "EXTERNAL";
  targetPath: string | null;
  externalPackage: string | null;
  isTypeOnly: boolean;
  names: string[];
  reason: string;
  startLine: number;
  endLine: number;
}

export interface CallRow {
  path: string;
  callerName: string | null;
  calleeText: string;
  resolution: "CONFIRMED" | "POSSIBLE" | "UNRESOLVED";
  targetName: string | null;
  targetPath: string | null;
  reason: string;
  startLine: number;
  endLine: number;
}

export interface FindingRow {
  ruleId: string;
  severity: string;
  certainty: string;
  title: string;
  description: string;
  subjectPath: string;
  primaryLine: number | null;
  measurements: unknown;
  evidence: Array<{
    message: string;
    filePath: string;
    startLine: number | null;
    endLine: number | null;
  }>;
}

export interface OverviewRow {
  files: number;
  analysedFiles: number;
  symbols: number;
  dependencies: number;
  unresolvedDependencies: number;
  topLevel: string[];
}

export interface EvidenceReader {
  overview(scope: SnapshotScope): Promise<OverviewRow>;
  findFiles(
    scope: SnapshotScope,
    terms: string[],
    limit: number,
  ): Promise<FileRow[]>;
  listDocumentPaths(scope: SnapshotScope, limit: number): Promise<string[]>;
  findSymbols(
    scope: SnapshotScope,
    terms: string[],
    limit: number,
  ): Promise<SymbolRow[]>;
  fileDependencies(
    scope: SnapshotScope,
    path: string,
    limit: number,
  ): Promise<{ imports: DependencyRow[]; importers: DependencyRow[] }>;
  symbolCalls(
    scope: SnapshotScope,
    symbolId: string,
    limit: number,
  ): Promise<CallRow[]>;
  findFindings(
    scope: SnapshotScope,
    query: { terms: string[]; paths: string[]; top: boolean; limit: number },
  ): Promise<FindingRow[]>;
  /** Hash-verified source text, or null when missing/corrupt/unavailable. */
  readSource(scope: SnapshotScope, path: string): Promise<string | null>;
}
