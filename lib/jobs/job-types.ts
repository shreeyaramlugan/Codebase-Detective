// lib/jobs/job-types.ts
//
// Job types and payload contracts. Pure module (no database, no Node APIs) so
// it can be unit tested and shared by the web app and the worker.
//
// A payload only ever holds identifiers and small validated options. It never
// holds source code, file contents, tokens or user-supplied paths.
export const JOB_TYPES = [
  "REPOSITORY_INDEX",
  "CODE_ANALYSIS",
  "FINDINGS_GENERATION",
  "RESEARCH_DISCOVERY",
  "RESEARCH_SYNTHESIS",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Sprint 08 vocabulary mapped onto the persisted enum values. */
export const JOB_TYPE_LABELS: Record<JobType, string> = {
  REPOSITORY_INDEX: "Repository ingestion",
  CODE_ANALYSIS: "Code analysis",
  FINDINGS_GENERATION: "Findings generation",
  RESEARCH_DISCOVERY: "Research discovery",
  RESEARCH_SYNTHESIS: "Research recommendations",
};

export const JOB_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Presentation state. "RETRY_SCHEDULED" is derived (FAILED with a pending
 * retry), not persisted, so the Sprint 01 status enum and its consumers are
 * unchanged.
 */
export type JobDisplayState =
  | "QUEUED"
  | "RUNNING"
  | "COMPLETED"
  | "RETRY_SCHEDULED"
  | "FAILED";

export function jobDisplayState(job: {
  status: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: Date | string | null;
}): JobDisplayState {
  switch (job.status) {
    case "PENDING":
      return "QUEUED";
    case "PROCESSING":
      return "RUNNING";
    case "COMPLETED":
      return "COMPLETED";
    default:
      return job.nextRetryAt !== null && job.attempts < job.maxAttempts
        ? "RETRY_SCHEDULED"
        : "FAILED";
  }
}

export function isJobType(value: unknown): value is JobType {
  return typeof value === "string" && (JOB_TYPES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------- payloads */

export class JobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobPayloadError";
  }
}

export interface AnalysisPayload { snapshotId: string }
export interface FindingsPayload { analysisId: string; thresholds?: Record<string, number> }
export interface ResearchDiscoveryPayload { runId: string }
export interface ResearchSynthesisPayload { runId: string }

export type JobPayload =
  | AnalysisPayload
  | FindingsPayload
  | ResearchDiscoveryPayload
  | ResearchSynthesisPayload
  | null;

export const MAX_PAYLOAD_BYTES = 4_096;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const THRESHOLD_NAME = /^[A-Za-z][A-Za-z0-9]{0,40}$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function id(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID.test(value)) {
    throw new JobPayloadError(`${name} is invalid.`);
  }
  return value;
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new JobPayloadError(`Unexpected field "${key.slice(0, 40)}".`);
  }
}

/**
 * Validates a payload for a job type and returns a clean copy. Unknown fields
 * are rejected, sizes are bounded, and ids must look like ids.
 */
export function validatePayload(type: JobType, raw: unknown): JobPayload {
  if (type === "REPOSITORY_INDEX") {
    if (raw !== null && raw !== undefined) throw new JobPayloadError("Ingestion jobs take no payload.");
    return null;
  }
  if (!isObject(raw)) throw new JobPayloadError("Payload must be an object.");
  let size = 0;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    throw new JobPayloadError("Payload is not serialisable.");
  }
  if (size > MAX_PAYLOAD_BYTES) throw new JobPayloadError("Payload is too large.");

  switch (type) {
    case "CODE_ANALYSIS":
      onlyKeys(raw, ["snapshotId"]);
      return { snapshotId: id(raw.snapshotId, "snapshotId") };
    case "FINDINGS_GENERATION": {
      onlyKeys(raw, ["analysisId", "thresholds"]);
      const out: FindingsPayload = { analysisId: id(raw.analysisId, "analysisId") };
      if (raw.thresholds !== undefined && raw.thresholds !== null) {
        if (!isObject(raw.thresholds)) throw new JobPayloadError("thresholds must be an object.");
        const entries = Object.entries(raw.thresholds);
        if (entries.length > 40) throw new JobPayloadError("Too many thresholds.");
        const clean: Record<string, number> = {};
        for (const [key, value] of entries) {
          if (!THRESHOLD_NAME.test(key) || typeof value !== "number" || !Number.isFinite(value)) {
            throw new JobPayloadError("thresholds contains an invalid entry.");
          }
          clean[key] = value;
        }
        if (entries.length > 0) out.thresholds = clean;
      }
      return out;
    }
    case "RESEARCH_DISCOVERY":
    case "RESEARCH_SYNTHESIS":
      onlyKeys(raw, ["runId"]);
      return { runId: id(raw.runId, "runId") };
  }
}

/** Jobs whose owner must be recorded and re-validated at execution time. */
export function requiresRequester(type: JobType): boolean {
  return type !== "REPOSITORY_INDEX";
}

/** Result references are small id maps; anything else is dropped. */
export function sanitiseResult(result: unknown): Record<string, string | number | boolean | null> | null {
  if (!isObject(result)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(result).slice(0, 20)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
    if (value === null || typeof value === "boolean" || typeof value === "number") out[key] = value;
    else if (typeof value === "string") out[key] = value.slice(0, 120);
  }
  return out;
}
