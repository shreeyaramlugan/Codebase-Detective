// lib/research/research.store.ts
//
// Persistence port for research runs. Every method that takes a userId must
// scope its query by that owner; another user's rows are indistinguishable
// from missing ones.
import type { SnapshotScope } from "@/features/ai/assistant/contracts";
import type {
  EvaluatedSource,
  ProviderDiagnostic,
  QueryPlan,
  SourceRecord,
} from "@/features/research/engine/contracts";
import type { Recommendation, SynthesisResult } from "@/features/research/engine/synthesis";
import type { RecommendationStatus } from "@/features/research/engine/lifecycle";

export type RunStatus =
  | "DISCOVERING"
  | "AWAITING_REVIEW"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "FAILED";

export interface ResearchFinding {
  id: string;
  fingerprint: string;
  ruleId: string;
  severity: string;
  certainty: string;
  title: string;
  description: string;
  subjectPath: string;
  primaryLine: number | null;
  measurements: unknown;
  evidence: Array<{ message: string; filePath: string; startLine: number | null; endLine: number | null }>;
  repositoryId: string;
  analysisId: string;
  snapshotId: string;
}

export interface RunRow {
  id: string;
  userId: string;
  repositoryId: string;
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  findingsRunId: string | null;
  trigger: "FINDING" | "QUESTION";
  findingId: string | null;
  findingFingerprint: string | null;
  ruleId: string | null;
  question: string;
  title: string;
  status: RunStatus;
  queries: QueryPlan[];
  diagnostics: ProviderDiagnostic[] | null;
  discarded: { lowRelevance: number; overLimit: number } | null;
  partial: boolean;
  engineVersion: string;
  synthesis: Omit<SynthesisResult, "recommendations"> | null;
  provider: string | null;
  model: string | null;
  totalTokens: number | null;
  errorCode: string | null;
  busyUntil: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export type RunDraft = Pick<
  RunRow,
  | "userId" | "repositoryId" | "snapshotId" | "analysisId" | "commitSha" | "findingsRunId"
  | "trigger" | "findingId" | "findingFingerprint" | "ruleId" | "question" | "title"
  | "queries" | "engineVersion"
>;

export interface RunSourceRow {
  runId: string;
  sourceKey: string;
  position: number;
  record: SourceRecord;
  evaluation: EvaluatedSource["evaluation"];
  passages: EvaluatedSource["passages"];
  queryOrdinals: number[];
  reused: boolean;
  included: boolean;
}

export interface RecommendationRow extends Recommendation {
  id: string;
  runId: string;
  status: RecommendationStatus;
  note: string | null;
  statusChangedAt: Date | null;
  updatedAt: Date;
}

export interface ResearchUsageRow {
  runCount: number;
  synthesisCount: number;
  tokenCount: number;
  providerRequestCount: number;
}

export type UsageCounter = "runCount" | "synthesisCount" | "providerRequestCount";

export interface ResearchStore {
  repositoryExists(userId: string, repositoryId: string): Promise<boolean>;
  resolveScope(
    userId: string,
    repositoryId: string,
    selector: { snapshotId?: string; analysisId?: string },
  ): Promise<SnapshotScope | null>;
  /** Owned finding (via its repository). */
  findFinding(userId: string, findingId: string): Promise<ResearchFinding | null>;

  createRun(draft: RunDraft, lockUntil: Date): Promise<RunRow>;
  findRun(userId: string, runId: string): Promise<RunRow | null>;
  listRuns(
    userId: string,
    repositoryId: string,
    opts: { archived: boolean; findingFingerprint?: string; limit: number },
  ): Promise<RunRow[]>;
  updateRun(
    userId: string,
    runId: string,
    patch: { title?: string; archivedAt?: Date | null },
  ): Promise<RunRow | null>;
  deleteRun(userId: string, runId: string): Promise<boolean>;

  /** Compare-and-set lock. True when taken. `status` must match when given. */
  acquireLock(
    runId: string,
    now: Date,
    until: Date,
    requireStatus?: RunStatus,
  ): Promise<boolean>;
  releaseLock(runId: string): Promise<void>;

  /** Stores discovery output and moves DISCOVERING -> AWAITING_REVIEW. */
  saveDiscovery(
    runId: string,
    data: {
      sources: Array<Omit<RunSourceRow, "runId" | "included">>;
      diagnostics: ProviderDiagnostic[];
      discarded: { lowRelevance: number; overLimit: number };
      partial: boolean;
    },
  ): Promise<void>;
  failRun(runId: string, errorCode: string): Promise<void>;
  listRunSources(userId: string, runId: string): Promise<RunSourceRow[]>;
  /** Only effective while the run is AWAITING_REVIEW. Returns false otherwise. */
  setIncluded(userId: string, runId: string, included: Record<string, boolean>): Promise<boolean>;

  /** Stores the validated synthesis and moves SYNTHESIZING/AWAITING_REVIEW -> COMPLETED. */
  saveSynthesis(
    runId: string,
    data: {
      synthesis: Omit<SynthesisResult, "recommendations">;
      recommendations: Recommendation[];
      provider: string | null;
      model: string | null;
      totalTokens: number | null;
    },
  ): Promise<void>;
  listRecommendations(userId: string, runId: string): Promise<RecommendationRow[]>;
  findRecommendation(userId: string, id: string): Promise<RecommendationRow | null>;
  updateRecommendation(
    userId: string,
    id: string,
    patch: { status?: RecommendationStatus; note?: string | null },
    now: Date,
  ): Promise<RecommendationRow | null>;

  /** Fresh cached source for a canonical URL, owner scoped. */
  findCachedSource(userId: string, canonicalUrl: string, now: Date): Promise<SourceRecord | null>;
  cacheSources(userId: string, entries: Array<{ record: SourceRecord; expiresAt: Date }>): Promise<void>;

  getUsage(userId: string, day: string): Promise<ResearchUsageRow>;
  /** Atomic conditional increment; false when the cap is already reached. */
  reserve(userId: string, day: string, counter: UsageCounter, limit: number, tokenLimit?: number): Promise<boolean>;
  recordUsage(
    userId: string,
    day: string,
    record: {
      runId: string;
      provider: string;
      model: string;
      status: "SUCCEEDED" | "FAILED";
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      errorCode: string | null;
      durationMs: number;
    },
  ): Promise<void>;
}
