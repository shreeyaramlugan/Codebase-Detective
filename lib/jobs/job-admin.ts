// lib/jobs/job-admin.ts
//
// Read models and controlled operations for job visibility.
//
// - User views are owner scoped: a user only ever sees jobs of repositories
//   they own, and only safe fields (never payloads, lock owners or events
//   that mention other users).
// - Operator views (queue statistics, worker list, failed-job inspection and
//   controlled retry) are restricted to ids listed in WORKER_ADMIN_USER_IDS.
import type { IndexingJob } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { JobTransitionError } from "./job-errors";
import { retryIndexingJob } from "./job-lifecycle";
import { recordJobEvent } from "./job-queue";
import {
  JOB_TYPE_LABELS,
  jobDisplayState,
  type JobType,
} from "./job-types";

export function isWorkerAdmin(
  userId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const ids = (env.WORKER_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.includes(userId);
}

export function toJobView(job: IndexingJob) {
  const durationMs =
    job.startedAt && job.completedAt
      ? Math.max(0, job.completedAt.getTime() - job.startedAt.getTime())
      : null;
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    type: job.type,
    label: JOB_TYPE_LABELS[job.type as JobType] ?? job.type,
    status: job.status,
    state: jobDisplayState(job),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    nextRetryAt: job.nextRetryAt?.toISOString() ?? null,
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    durationMs,
    createdAt: job.createdAt.toISOString(),
    result: job.result,
  };
}

export class JobNotFoundError extends Error {
  constructor() {
    super("Job not found.");
    this.name = "JobNotFoundError";
  }
}

export async function getOwnedJob(userId: string, jobId: string) {
  const job = await prisma.indexingJob.findFirst({
    where: { id: jobId, repository: { ownerId: userId } },
  });
  if (!job) throw new JobNotFoundError();
  return toJobView(job);
}

export async function listOwnedJobs(
  userId: string,
  repositoryId: string,
  options: { limit?: number; type?: JobType } = {},
) {
  const repository = await prisma.repository.findFirst({
    where: { id: repositoryId, ownerId: userId },
    select: { id: true },
  });
  if (!repository) throw new JobNotFoundError();

  const jobs = await prisma.indexingJob.findMany({
    where: { repositoryId, ...(options.type ? { type: options.type } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, options.limit ?? 20), 50),
  });
  return { jobs: jobs.map(toJobView) };
}

/* ----------------------------------------------------------------- operator */

export interface QueueStats {
  generatedAt: string;
  counts: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    retryScheduled: number;
  };
  byType: Record<string, { queued: number; running: number; failed: number }>;
  oldestQueuedAgeMs: number | null;
  averageDurationMs: number | null;
  recentFailures: Array<ReturnType<typeof toJobView>>;
  workers: Array<{
    id: string;
    hostname: string;
    status: string;
    concurrency: number;
    activeJobs: number;
    startedAt: string;
    lastHeartbeatAt: string;
    healthy: boolean;
  }>;
}

/** A worker is healthy when it is running and heart-beat recently. */
export function workerIsHealthy(
  worker: { status: string; lastHeartbeatAt: Date },
  now: Date,
  staleAfterMs: number,
): boolean {
  return (
    (worker.status === "RUNNING" || worker.status === "STARTING") &&
    now.getTime() - worker.lastHeartbeatAt.getTime() <= staleAfterMs
  );
}

export async function getQueueStats(
  now: Date = new Date(),
  staleAfterMs = 90_000,
): Promise<QueueStats> {
  const [groups, retryScheduled, oldest, recentCompleted, failures, workers] =
    await Promise.all([
      prisma.indexingJob.groupBy({ by: ["status", "type"], _count: { _all: true } }),
      prisma.indexingJob.count({ where: { status: "FAILED", nextRetryAt: { not: null } } }),
      prisma.indexingJob.findFirst({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      prisma.indexingJob.findMany({
        where: { status: "COMPLETED", completedAt: { gte: new Date(now.getTime() - 86_400_000) } },
        orderBy: { completedAt: "desc" },
        take: 200,
        select: { startedAt: true, completedAt: true },
      }),
      prisma.indexingJob.findMany({
        where: { status: "FAILED" },
        orderBy: { updatedAt: "desc" },
        take: 20,
      }),
      prisma.workerInstance.findMany({
        where: { OR: [{ status: { not: "STOPPED" } }, { stoppedAt: { gte: new Date(now.getTime() - 3_600_000) } }] },
        orderBy: { lastHeartbeatAt: "desc" },
        take: 20,
      }),
    ]);

  const counts = { queued: 0, running: 0, completed: 0, failed: 0, retryScheduled };
  const byType: QueueStats["byType"] = {};
  for (const g of groups) {
    const n = g._count._all;
    const bucket = (byType[g.type] ??= { queued: 0, running: 0, failed: 0 });
    if (g.status === "PENDING") { counts.queued += n; bucket.queued += n; }
    else if (g.status === "PROCESSING") { counts.running += n; bucket.running += n; }
    else if (g.status === "COMPLETED") counts.completed += n;
    else { counts.failed += n; bucket.failed += n; }
  }

  const durations = recentCompleted
    .filter((j) => j.startedAt && j.completedAt)
    .map((j) => j.completedAt!.getTime() - j.startedAt!.getTime());

  return {
    generatedAt: now.toISOString(),
    counts,
    byType,
    oldestQueuedAgeMs: oldest ? now.getTime() - oldest.createdAt.getTime() : null,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    recentFailures: failures.map(toJobView),
    workers: workers.map((w) => ({
      id: w.id,
      hostname: w.hostname,
      status: w.status,
      concurrency: w.concurrency,
      activeJobs: w.activeJobs,
      startedAt: w.startedAt.toISOString(),
      lastHeartbeatAt: w.lastHeartbeatAt.toISOString(),
      healthy: workerIsHealthy(w, now, staleAfterMs),
    })),
  };
}

export async function getJobEvents(jobId: string) {
  const events = await prisma.jobEvent.findMany({
    where: { jobId },
    orderBy: { at: "asc" },
    take: 100,
  });
  return events.map((e) => ({
    at: e.at.toISOString(),
    event: e.event,
    workerId: e.workerId,
    attempt: e.attempt,
    code: e.code,
    message: e.message,
  }));
}

/**
 * Controlled operator retry: only FAILED jobs, one extra attempt at a time,
 * through the normal lifecycle (so the one-active-job rules still apply).
 */
export async function adminRetryJob(jobId: string, actorId: string) {
  const job = await prisma.indexingJob.findUnique({ where: { id: jobId } });
  if (!job) throw new JobNotFoundError();
  if (job.status !== "FAILED") {
    throw new JobTransitionError("Only failed jobs can be retried.", "INVALID_TRANSITION");
  }

  const bumped = job.attempts >= job.maxAttempts;
  await prisma.indexingJob.updateMany({
    where: { id: jobId, status: "FAILED" },
    data: {
      nextRetryAt: null,
      ...(bumped ? { maxAttempts: job.attempts + 1 } : {}),
    },
  });

  const updated = await retryIndexingJob(jobId);
  await recordJobEvent({
    jobId,
    event: "ADMIN_RETRY",
    attempt: updated.attempts,
    message: bumped ? "Retried by an operator with one extra attempt." : "Retried by an operator.",
    data: { actor: actorId.slice(0, 40) },
  });
  return toJobView(updated);
}
