// lib/analysis/analysis.store.ts
//
// Persistence port for analysis runs. The runner depends on this interface;
// the Prisma implementation lives in analysis.prisma-store.ts.
import type {
  AnalysisRecords,
  DiagnosticRecord,
} from "@/features/code-intelligence/contracts";
import type { DependencyGraph } from "@/features/code-intelligence/graph/graph.types";

export interface CreateRunInput {
  snapshotId: string;
  repositoryId: string;
  requestedById: string;
  commitSha: string;
  snapshotCompleteness: string | null;
  engineVersion: string;
  parserVersion: string;
}

export interface PersistResultsInput {
  status: "COMPLETED" | "PARTIAL";
  records: AnalysisRecords;
  graph: DependencyGraph;
  stats: Record<string, unknown>;
}

export interface AnalysisStore {
  /** Always creates a brand-new run; never reuses or updates a previous one. */
  createRun(input: CreateRunInput): Promise<{ id: string }>;
  markProcessing(analysisId: string): Promise<void>;
  /**
   * Atomically writes every relational record and the graph read model, then
   * sets the final status. Either everything is stored or nothing is.
   */
  persistResults(analysisId: string, input: PersistResultsInput): Promise<void>;
  markFailed(
    analysisId: string,
    input: {
      errorCode: string;
      errorMessage: string;
      diagnostics: DiagnosticRecord[];
      stats: Record<string, unknown> | null;
    },
  ): Promise<void>;
}
