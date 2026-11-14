// lib/jobs/job-client.ts
//
// Browser-side helper: wait for a background job by polling its owner-scoped
// status endpoint. No server imports, so it is safe in client components and
// testable with an injected fetch.
import type { JobDisplayState } from "./job-types";

export interface JobViewLite {
  id: string;
  type: string;
  label: string;
  state: JobDisplayState;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  nextRetryAt: string | null;
  result: unknown;
}

export class JobFailedError extends Error {
  constructor(
    message: string,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "JobFailedError";
  }
}

export interface WaitOptions {
  intervalMs?: number;
  /** Give up waiting (the job keeps running on the worker). */
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (job: JobViewLite) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export const WAIT_TIMED_OUT = "WAIT_TIMED_OUT";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolves with the finished job. Rejects with JobFailedError when the job
 * failed for good. RETRY_SCHEDULED keeps waiting, because the worker will try
 * again by itself.
 */
export async function waitForJob(jobId: string, options: WaitOptions = {}): Promise<JobViewLite> {
  const { intervalMs = 2000, timeoutMs = 10 * 60_000, signal, onUpdate } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const startedAt = Date.now();
  let consecutiveErrors = 0;

  for (;;) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() - startedAt > timeoutMs) {
      throw new JobFailedError("This is taking longer than expected. It is still running; check back shortly.", WAIT_TIMED_OUT);
    }

    try {
      const response = await doFetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
        credentials: "same-origin",
        signal,
      });
      if (response.status === 401 || response.status === 404) {
        throw new JobFailedError("The job could not be found.", "NOT_FOUND");
      }
      if (!response.ok) throw new Error(`status ${response.status}`);
      const { job } = (await response.json()) as { job: JobViewLite };
      consecutiveErrors = 0;
      onUpdate?.(job);
      if (job.state === "COMPLETED") return job;
      if (job.state === "FAILED") {
        throw new JobFailedError(job.errorMessage ?? "The job failed.", job.errorCode);
      }
    } catch (error) {
      if (error instanceof JobFailedError) throw error;
      if (signal?.aborted) throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) throw new JobFailedError("Could not check the job status.", "NETWORK");
    }

    await sleep(intervalMs);
  }
}

/** Short human text for a job state (dashboard and panels). */
export function describeJobState(job: Pick<JobViewLite, "state" | "attempts" | "maxAttempts">): string {
  switch (job.state) {
    case "QUEUED":
      return "Waiting for a worker";
    case "RUNNING":
      return job.attempts > 1 ? `Running (attempt ${job.attempts} of ${job.maxAttempts})` : "Running";
    case "RETRY_SCHEDULED":
      return "Will retry automatically";
    case "COMPLETED":
      return "Completed";
    default:
      return "Failed";
  }
}
