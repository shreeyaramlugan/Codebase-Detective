// lib/findings/findings.store.ts
//
// Persistence port for findings runs. The runner depends on this interface;
// the Prisma implementation lives in findings.prisma-store.ts.
import type {
  FindingsEngineResult,
  Thresholds,
} from "@/features/findings/contracts";

export interface CreateFindingsRunInput {
  analysisId: string;
  repositoryId: string;
  requestedById: string;
  engineVersion: string;
  catalogueVersion: string;
  thresholds: Thresholds;
}

export interface PersistFindingsInput {
  status: "COMPLETED" | "PARTIAL";
  result: FindingsEngineResult;
  stats: Record<string, unknown>;
  coverage: { factsMissing: Record<string, string>; truncated: boolean };
}

export interface FindingsStore {
  /** Always creates a brand-new run; never reuses or updates a previous one. */
  createRun(input: CreateFindingsRunInput): Promise<{ id: string }>;
  markProcessing(runId: string): Promise<void>;
  /** Atomically writes every finding, evidence row and rule run, then the status. */
  persistResults(runId: string, input: PersistFindingsInput): Promise<void>;
  markFailed(
    runId: string,
    input: { errorCode: string; errorMessage: string },
  ): Promise<void>;
}
