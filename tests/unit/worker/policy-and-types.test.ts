// tests/unit/worker/policy-and-types.test.ts
import { describe, expect, it } from "vitest";

import {
  BASE_RETRY_DELAY_MS,
  isRetryableCode,
  JobFailure,
  MAX_RETRY_DELAY_MS,
  retryDelayMs,
  retryDelayWithHint,
} from "../../../lib/jobs/job-policy";
import {
  JobPayloadError,
  jobDisplayState,
  sanitiseResult,
  validatePayload,
} from "../../../lib/jobs/job-types";
import { executionMode } from "../../../lib/jobs/execution-mode";
import { isWorkerAdmin } from "../../../lib/jobs/job-admin";

function rejects(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e) { return e instanceof JobPayloadError ? e.message : `wrong error: ${String(e)}`; }
}

describe("retry policy", () => {
  it("backs off exponentially from 30 seconds and caps at 15 minutes", () => {
    expect(retryDelayMs(1)).toBe(BASE_RETRY_DELAY_MS);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(30)).toBe(MAX_RETRY_DELAY_MS);
    expect(retryDelayMs(0)).toBe(BASE_RETRY_DELAY_MS);
  });

  it("honours a longer provider Retry-After but never beyond the cap", () => {
    expect(retryDelayWithHint(1, 5_000)).toBe(30_000);
    expect(retryDelayWithHint(1, 120_000)).toBe(120_000);
    expect(retryDelayWithHint(1, 99 * 3_600_000)).toBe(MAX_RETRY_DELAY_MS);
    expect(retryDelayWithHint(1, Number.NaN)).toBe(30_000);
    expect(retryDelayWithHint(1, null)).toBe(30_000);
  });

  it("separates permanent from retryable failures", () => {
    for (const code of ["INVALID_PAYLOAD", "OWNERSHIP_VIOLATION", "NOT_FOUND", "GRAPH_VALIDATION_FAILED", "LIMIT_EXCEEDED"]) {
      expect(isRetryableCode(code)).toBe(false);
    }
    for (const code of ["PROVIDER_ERROR", "JOB_TIMEOUT", "WORKER_LOST", "RATE_LIMITED", "ANALYSIS_FAILED", "SOMETHING_NEW"]) {
      expect(isRetryableCode(code)).toBe(true);
    }
  });

  it("JobFailure defaults to the code's classification and can override it", () => {
    expect(new JobFailure("x", "INVALID_PAYLOAD").retryable).toBe(false);
    expect(new JobFailure("x", "PROVIDER_ERROR").retryable).toBe(true);
    expect(new JobFailure("x", "PROVIDER_ERROR", { retryable: false }).retryable).toBe(false);
  });
});

describe("payload validation", () => {
  it("accepts well-formed payloads for each type", () => {
    expect(validatePayload("CODE_ANALYSIS", { snapshotId: "snap_1" })).toEqual({ snapshotId: "snap_1" });
    expect(validatePayload("FINDINGS_GENERATION", { analysisId: "an_1" })).toEqual({ analysisId: "an_1" });
    expect(validatePayload("FINDINGS_GENERATION", { analysisId: "an_1", thresholds: { cyclomaticMedium: 20 } })).toEqual({
      analysisId: "an_1",
      thresholds: { cyclomaticMedium: 20 },
    });
    expect(validatePayload("RESEARCH_DISCOVERY", { runId: "r1" })).toEqual({ runId: "r1" });
    expect(validatePayload("RESEARCH_SYNTHESIS", { runId: "r1" })).toEqual({ runId: "r1" });
    expect(validatePayload("REPOSITORY_INDEX", null)).toBeNull();
  });

  it("rejects bad ids, path-like values, unknown fields and non-objects", () => {
    expect(rejects(() => validatePayload("CODE_ANALYSIS", { snapshotId: "../../etc/passwd" }))).toContain("snapshotId");
    expect(rejects(() => validatePayload("CODE_ANALYSIS", { snapshotId: "" }))).toContain("snapshotId");
    expect(rejects(() => validatePayload("CODE_ANALYSIS", { snapshotId: "s", storageKey: "x" }))).toContain("Unexpected");
    expect(rejects(() => validatePayload("CODE_ANALYSIS", "snap"))).toContain("object");
    expect(rejects(() => validatePayload("CODE_ANALYSIS", null))).toContain("object");
    expect(rejects(() => validatePayload("RESEARCH_DISCOVERY", { runId: 5 }))).toContain("runId");
    expect(rejects(() => validatePayload("REPOSITORY_INDEX", { x: 1 }))).toContain("no payload");
  });

  it("bounds thresholds and payload size", () => {
    expect(rejects(() => validatePayload("FINDINGS_GENERATION", { analysisId: "a", thresholds: { x: "1" } }))).toContain("invalid entry");
    expect(rejects(() => validatePayload("FINDINGS_GENERATION", { analysisId: "a", thresholds: { "bad key": 1 } }))).toContain("invalid entry");
    const many: Record<string, number> = {};
    for (let i = 0; i < 41; i++) many[`t${i}`] = i;
    expect(rejects(() => validatePayload("FINDINGS_GENERATION", { analysisId: "a", thresholds: many }))).toContain("Too many");
    expect(rejects(() => validatePayload("FINDINGS_GENERATION", { analysisId: "a", thresholds: { a: Infinity } }))).toContain("invalid entry");
  });

  it("keeps only small id-like references in results", () => {
    expect(sanitiseResult({ analysisId: "a1", n: 3, ok: true, nested: { x: 1 }, "bad key": 1 })).toEqual({ analysisId: "a1", n: 3, ok: true });
    expect(sanitiseResult("x")).toBeNull();
    const out = sanitiseResult({ big: "x".repeat(5000) });
    expect((out!.big as string).length).toBe(120);
  });
});

describe("display state", () => {
  const base = { attempts: 1, maxAttempts: 3, nextRetryAt: null as Date | null };
  it("maps persisted status to the five visible states", () => {
    expect(jobDisplayState({ ...base, status: "PENDING" })).toBe("QUEUED");
    expect(jobDisplayState({ ...base, status: "PROCESSING" })).toBe("RUNNING");
    expect(jobDisplayState({ ...base, status: "COMPLETED" })).toBe("COMPLETED");
    expect(jobDisplayState({ ...base, status: "FAILED", nextRetryAt: new Date() })).toBe("RETRY_SCHEDULED");
    expect(jobDisplayState({ ...base, status: "FAILED" })).toBe("FAILED");
    expect(jobDisplayState({ ...base, status: "FAILED", attempts: 3, nextRetryAt: new Date() })).toBe("FAILED");
  });
});

describe("execution mode and operator access", () => {
  it("never runs inline in production", () => {
    expect(executionMode({ NODE_ENV: "production", BACKGROUND_EXECUTION: "inline" })).toBe("worker");
    expect(executionMode({ NODE_ENV: "development", BACKGROUND_EXECUTION: "inline" })).toBe("inline");
    expect(executionMode({ NODE_ENV: "development" })).toBe("worker");
    expect(executionMode({})).toBe("worker");
  });

  it("recognises operators by user id only", () => {
    const env = { WORKER_ADMIN_USER_IDS: "u1, u2" };
    expect(isWorkerAdmin("u1", env)).toBe(true);
    expect(isWorkerAdmin("u2", env)).toBe(true);
    expect(isWorkerAdmin("u3", env)).toBe(false);
    expect(isWorkerAdmin("u1", {})).toBe(false);
    expect(isWorkerAdmin("", { WORKER_ADMIN_USER_IDS: "" })).toBe(false);
    // An email-looking value is just an id string; it must match exactly.
    expect(isWorkerAdmin("someone@example.test", env)).toBe(false);
  });
});
