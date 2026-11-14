// lib/jobs/job-policy.ts
//
// Retry, timeout and recovery policy. Pure and deterministic so it can be
// tested without a database.
import type { JobType } from "./job-types";

export const BASE_RETRY_DELAY_MS = 30_000; // matches Sprint 01: 30s, 60s, 120s...
export const MAX_RETRY_DELAY_MS = 15 * 60_000;

/** Delay after the Nth failed attempt (1-based). Exponential, capped. */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * Math.pow(2, n - 1));
}

/**
 * Honour a provider's Retry-After when it asks for longer than our back-off,
 * but never beyond the cap, so a hostile or misconfigured provider cannot park
 * a job indefinitely.
 */
export function retryDelayWithHint(attempt: number, retryAfterMs?: number | null): number {
  const base = retryDelayMs(attempt);
  if (retryAfterMs === undefined || retryAfterMs === null || !Number.isFinite(retryAfterMs)) return base;
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(base, Math.floor(retryAfterMs)));
}

/** Codes that retrying can never fix. Everything else is retryable (bounded). */
export const PERMANENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "INVALID_REPOSITORY_METADATA",
  "INVALID_PAYLOAD",
  "OWNERSHIP_VIOLATION",
  "NOT_FOUND",
  "UNSUPPORTED_JOB_TYPE",
  "SNAPSHOT_NOT_READY",
  "ANALYSIS_NOT_READY",
  "NO_USABLE_SOURCE_FILES",
  "TREE_INCOMPLETE",
  "INVALID_REQUEST",
  "INVALID_INPUT",
  "INCOMPATIBLE_RUNS",
  "GRAPH_VALIDATION_FAILED",
  "ENGINE_CONSISTENCY_ERROR",
  "NOT_CONFIGURED",
  "LIMIT_EXCEEDED",
  "INVALID_STATE",
  "RUN_NOT_FOUND",
]);

export function isRetryableCode(code: string): boolean {
  return !PERMANENT_FAILURE_CODES.has(code);
}

/** Per-type hard wall-clock limits. Heartbeats keep a healthy long job from being
 * called stale; this timeout is what stops a job that is hung but still heart-beating. */
export const DEFAULT_JOB_TIMEOUTS_MS: Record<JobType, number> = {
  REPOSITORY_INDEX: 10 * 60_000,
  CODE_ANALYSIS: 5 * 60_000,
  FINDINGS_GENERATION: 5 * 60_000,
  RESEARCH_DISCOVERY: 90_000,
  RESEARCH_SYNTHESIS: 120_000,
};

/** A job is stale when its last heartbeat is older than this. */
export function isStale(heartbeatAt: Date | null, startedAt: Date | null, now: Date, staleAfterMs: number): boolean {
  const last = heartbeatAt ?? startedAt;
  if (!last) return true;
  return now.getTime() - last.getTime() > staleAfterMs;
}

export class JobFailure extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly options: { retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.name = "JobFailure";
  }
  get retryable(): boolean {
    return this.options.retryable ?? isRetryableCode(this.code);
  }
}
