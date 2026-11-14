// lib/jobs/job-queue.ts
//
// Database-backed queue operations used by the worker: claiming, heartbeats,
// stale-job recovery, graceful release, history events and worker registry.
//
// Claiming is built on the existing atomic lifecycle transition
// (startIndexingJob: a conditional PENDING -> PROCESSING update), so two
// workers can race for a job but only one update can succeed. No second queue
// system and no advisory locks are required.
import type { IndexingJob } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { JobTransitionError } from "./job-errors";
import {
  completeIndexingJob,
  failIndexingJob,
  retryIndexingJob,
  startIndexingJob,
} from "./job-lifecycle";
import type { JobType } from "./job-types";

export type ClaimedJob = IndexingJob;

export interface JobEventInput {
  jobId: string;
  event: string;
  workerId?: string | null;
  attempt?: number | null;
  code?: string | null;
  message?: string | null;
  data?: Record<string, string | number | boolean | null>;
}

/** History must never break the operation it describes. */
export async function recordJobEvent(input: JobEventInput): Promise<void> {
  try {
    await prisma.jobEvent.create({
      data: {
        jobId: input.jobId,
        event: input.event.slice(0, 40),
        workerId: input.workerId ?? null,
        attempt: input.attempt ?? null,
        code: input.code ? input.code.slice(0, 100) : null,
        message: input.message ? input.message.slice(0, 300) : null,
        ...(input.data ? { data: input.data } : {}),
      },
    });
  } catch {
    // Intentionally ignored.
  }
}

/** Claim the oldest eligible job of the given types, or null. */
export async function claimNextJob(
  workerId: string,
  types: readonly JobType[],
  now: Date = new Date(),
): Promise<ClaimedJob | null> {
  const candidates = await prisma.indexingJob.findMany({
    where: {
      status: "PENDING",
      type: { in: [...types] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  });

  for (const candidate of candidates) {
    try {
      const job = await startIndexingJob(candidate.id, { workerId, now });
      await recordJobEvent({
        jobId: job.id,
        event: "CLAIMED",
        workerId,
        attempt: job.attempts,
      });
      return job;
    } catch (error) {
      // Another worker won the race, or the job is no longer claimable.
      if (error instanceof JobTransitionError) continue;
      throw error;
    }
  }

  return null;
}

/** Move failed jobs whose back-off has elapsed back to PENDING. */
export async function promoteDueRetries(
  now: Date = new Date(),
  limit = 20,
): Promise<number> {
  const due = await prisma.indexingJob.findMany({
    where: { status: "FAILED", nextRetryAt: { lte: now } },
    orderBy: { nextRetryAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let promoted = 0;
  for (const job of due) {
    try {
      const updated = await retryIndexingJob(job.id, { now });
      await recordJobEvent({
        jobId: updated.id,
        event: "RETRY_QUEUED",
        attempt: updated.attempts,
      });
      promoted += 1;
    } catch (error) {
      // Not eligible any more (attempts exhausted, another active job, raced).
      if (!(error instanceof JobTransitionError)) throw error;
    }
  }
  return promoted;
}

/** Record liveness. False means this worker no longer owns the job. */
export async function heartbeatJob(
  jobId: string,
  workerId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await prisma.indexingJob.updateMany({
    where: { id: jobId, status: "PROCESSING", lockedBy: workerId },
    data: { heartbeatAt: now },
  });
  return result.count === 1;
}

export interface RecoveryOutcome {
  recovered: number;
  /** Jobs that were abandoned on their last allowed attempt. */
  exhausted: ClaimedJob[];
}

/**
 * Fail jobs whose worker stopped heart-beating. A recovered job with attempts
 * left becomes retryable immediately; one without stays failed (visible).
 * Completed snapshots and analyses are never touched: only the job row moves.
 */
export async function recoverStaleJobs(
  now: Date,
  staleAfterMs: number,
  limit = 20,
): Promise<RecoveryOutcome> {
  const threshold = new Date(now.getTime() - staleAfterMs);

  const stale = await prisma.indexingJob.findMany({
    where: {
      status: "PROCESSING",
      OR: [
        { heartbeatAt: { lt: threshold } },
        { heartbeatAt: null, startedAt: { lt: threshold } },
      ],
    },
    orderBy: { startedAt: "asc" },
    take: limit,
  });

  const exhausted: ClaimedJob[] = [];
  let recovered = 0;

  for (const job of stale) {
    const mayRetry = job.attempts < job.maxAttempts;
    const moved = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction: the worker may have just woken up.
      const result = await tx.indexingJob.updateMany({
        where: {
          id: job.id,
          status: "PROCESSING",
          lockedBy: job.lockedBy,
          OR: [
            { heartbeatAt: { lt: threshold } },
            { heartbeatAt: null, startedAt: { lt: threshold } },
          ],
        },
        data: {
          status: "FAILED",
          completedAt: now,
          errorCode: "WORKER_LOST",
          errorMessage: "The worker stopped responding while processing this job.",
          nextRetryAt: mayRetry ? now : null,
          lockedAt: null,
          lockedBy: null,
          heartbeatAt: null,
        },
      });
      if (result.count !== 1) return false;
      if (job.type === "REPOSITORY_INDEX") {
        await tx.repository.update({
          where: { id: job.repositoryId },
          data: { status: "FAILED" },
        });
      }
      return true;
    });

    if (!moved) continue;
    recovered += 1;
    if (!mayRetry) exhausted.push(job);
    await recordJobEvent({
      jobId: job.id,
      event: "RECOVERED",
      workerId: job.lockedBy,
      attempt: job.attempts,
      code: "WORKER_LOST",
      message: mayRetry ? "Re-queued after worker loss." : "Abandoned on its final attempt.",
    });
  }

  return { recovered, exhausted };
}

/**
 * Give a job back during graceful shutdown. The interrupted attempt is not
 * counted, so a deploy or restart never consumes a job's retry budget.
 */
export async function releaseJob(jobId: string, workerId: string): Promise<boolean> {
  const moved = await prisma.$transaction(async (tx) => {
    const job = await tx.indexingJob.findFirst({
      where: { id: jobId, status: "PROCESSING", lockedBy: workerId },
    });
    if (!job) return null;
    const result = await tx.indexingJob.updateMany({
      where: { id: jobId, status: "PROCESSING", lockedBy: workerId },
      data: {
        status: "PENDING",
        attempts: { decrement: 1 },
        startedAt: null,
        lockedAt: null,
        lockedBy: null,
        heartbeatAt: null,
      },
    });
    if (result.count !== 1) return null;
    if (job.type === "REPOSITORY_INDEX") {
      await tx.repository.update({
        where: { id: job.repositoryId },
        data: { status: "QUEUED" },
      });
    }
    return job;
  });

  if (!moved) return false;
  await recordJobEvent({
    jobId,
    event: "RELEASED",
    workerId,
    message: "Released during worker shutdown.",
  });
  return true;
}

/** Complete/fail wrappers that bind the worker identity and write history. */
export async function completeJobForWorker(
  job: ClaimedJob,
  workerId: string,
  result: unknown,
): Promise<void> {
  await completeIndexingJob(job.id, "INDEXED", { workerId, result });
  await recordJobEvent({
    jobId: job.id,
    event: "COMPLETED",
    workerId,
    attempt: job.attempts,
  });
}

export async function failJobForWorker(
  job: ClaimedJob,
  workerId: string,
  failure: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number | null;
  },
): Promise<void> {
  const updated = await failIndexingJob(job.id, failure.code, failure.message, {
    retryable: failure.retryable,
    retryAfterMs: failure.retryAfterMs,
    workerId,
  });
  await recordJobEvent({
    jobId: job.id,
    event: updated.nextRetryAt ? "RETRY_SCHEDULED" : "FAILED",
    workerId,
    attempt: job.attempts,
    code: failure.code,
    message: failure.message,
    data: updated.nextRetryAt
      ? { retryAt: updated.nextRetryAt.toISOString() }
      : undefined,
  });
}

/* --------------------------------------------------------- worker registry */

export interface WorkerRegistration {
  id: string;
  hostname: string;
  pid: number;
  version: string;
  concurrency: number;
  startedAt: Date;
}

export async function registerWorker(w: WorkerRegistration): Promise<void> {
  await prisma.workerInstance.upsert({
    where: { id: w.id },
    create: {
      id: w.id,
      hostname: w.hostname,
      pid: w.pid,
      version: w.version,
      status: "STARTING",
      concurrency: w.concurrency,
      startedAt: w.startedAt,
      lastHeartbeatAt: w.startedAt,
    },
    update: {
      hostname: w.hostname,
      pid: w.pid,
      version: w.version,
      status: "STARTING",
      concurrency: w.concurrency,
      startedAt: w.startedAt,
      lastHeartbeatAt: w.startedAt,
      stoppedAt: null,
      activeJobs: 0,
    },
  });
}

export async function workerHeartbeat(
  id: string,
  state: { status: "RUNNING" | "DRAINING"; activeJobs: number; now: Date },
): Promise<void> {
  await prisma.workerInstance.updateMany({
    where: { id },
    data: {
      status: state.status,
      activeJobs: state.activeJobs,
      lastHeartbeatAt: state.now,
    },
  });
}

export async function markWorkerStopped(id: string, now: Date): Promise<void> {
  await prisma.workerInstance.updateMany({
    where: { id },
    data: { status: "STOPPED", activeJobs: 0, stoppedAt: now, lastHeartbeatAt: now },
  });
}
