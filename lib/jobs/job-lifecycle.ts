// lib/jobs/job-lifecycle.ts
import { prisma } from "@/lib/db/prisma";
import { JobTransitionError } from "./job-errors";
import { retryDelayWithHint } from "./job-policy";
import { sanitiseResult } from "./job-types";

/** Only ingestion jobs drive the repository's own status. */
const drivesRepositoryStatus = (type: string) => type === "REPOSITORY_INDEX";

const LOCK_CLEARED = {
  lockedAt: null,
  lockedBy: null,
  heartbeatAt: null,
} as const;

/**
 * Start a pending job.
 *
 * The conditional update prevents two callers from claiming the same job
 * simultaneously. When a workerId is given the claim is recorded on the job
 * (owner and heartbeat) so abandoned work can be recognised and recovered.
 */
export async function startIndexingJob(
  jobId: string,
  options: { workerId?: string; now?: Date } = {},
) {
  return prisma.$transaction(async (tx) => {
    const existingJob = await tx.indexingJob.findUnique({
      where: { id: jobId },
    });

    if (!existingJob) {
      throw new JobTransitionError("Indexing job not found.", "JOB_NOT_FOUND");
    }

    const now = options.now ?? new Date();

    const result = await tx.indexingJob.updateMany({
      where: {
        id: jobId,
        status: "PENDING",
        attempts: {
          lt: existingJob.maxAttempts,
        },
      },
      data: {
        status: "PROCESSING",
        attempts: {
          increment: 1,
        },
        startedAt: now,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
        ...(options.workerId
          ? {
              lockedAt: now,
              lockedBy: options.workerId,
              heartbeatAt: now,
            }
          : {}),
      },
    });

    if (result.count !== 1) {
      const job = await tx.indexingJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new JobTransitionError(
          "Indexing job not found.",
          "JOB_NOT_FOUND",
        );
      }

      if (job.attempts >= job.maxAttempts) {
        throw new JobTransitionError(
          "Maximum processing attempts reached.",
          "MAX_ATTEMPTS_REACHED",
        );
      }

      throw new JobTransitionError(
        "Job is not available for processing.",
        "INVALID_TRANSITION",
      );
    }

    const job = await tx.indexingJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    if (drivesRepositoryStatus(job.type)) {
      await tx.repository.update({
        where: { id: job.repositoryId },
        data: { status: "INDEXING" },
      });
    }

    return job;
  });
}

/**
 * Mark a processing job as completed.
 *
 * Repository status defaults to INDEXED for backward compatibility and is
 * only touched by ingestion jobs. When a workerId is given, only the worker
 * that still owns the job can complete it.
 */
export async function completeIndexingJob(
  jobId: string,
  repositoryStatus: "INDEXED" | "PARTIALLY_INDEXED" = "INDEXED",
  options: { workerId?: string; result?: unknown } = {},
) {
  return prisma.$transaction(async (tx) => {
    const result = await tx.indexingJob.updateMany({
      where: {
        id: jobId,
        status: "PROCESSING",
        ...(options.workerId ? { lockedBy: options.workerId } : {}),
      },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
        ...LOCK_CLEARED,
        ...(options.result !== undefined
          ? { result: (sanitiseResult(options.result) ?? undefined) as never }
          : {}),
      },
    });

    if (result.count !== 1) {
      const job = await tx.indexingJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new JobTransitionError(
          "Indexing job not found.",
          "JOB_NOT_FOUND",
        );
      }

      throw new JobTransitionError(
        "Only processing jobs can be completed.",
        "INVALID_TRANSITION",
      );
    }

    const job = await tx.indexingJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    if (drivesRepositoryStatus(job.type)) {
      await tx.repository.update({
        where: { id: job.repositoryId },
        data: { status: repositoryStatus },
      });
    }

    return job;
  });
}

/**
 * Mark a processing job as failed and schedule its next retry.
 *
 * Retry policy (unchanged from Sprint 01 for the default case):
 * Attempt 1 failure: retry after 30 seconds.
 * Attempt 2 failure: retry after 60 seconds.
 * Maximum attempts reached, or a permanent failure: no further retry.
 *
 * Only safe, user-facing error information should be supplied.
 * Never pass stack traces, secrets or raw internal exceptions.
 */
export async function failIndexingJob(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  options: {
    retryable?: boolean;
    retryAfterMs?: number | null;
    workerId?: string;
  } = {},
) {
  return prisma.$transaction(async (tx) => {
    const existingJob = await tx.indexingJob.findUnique({
      where: { id: jobId },
    });

    if (!existingJob) {
      throw new JobTransitionError("Indexing job not found.", "JOB_NOT_FOUND");
    }

    const now = new Date();

    // Schedule another attempt only if the failure is retryable and attempts remain.
    const mayRetry =
      options.retryable !== false &&
      existingJob.attempts < existingJob.maxAttempts;

    const nextRetryAt = mayRetry
      ? new Date(
          now.getTime() +
            retryDelayWithHint(existingJob.attempts, options.retryAfterMs),
        )
      : null;

    const result = await tx.indexingJob.updateMany({
      where: {
        id: jobId,
        status: "PROCESSING",
        ...(options.workerId ? { lockedBy: options.workerId } : {}),
      },
      data: {
        status: "FAILED",
        completedAt: now,
        errorCode: errorCode.slice(0, 100),
        errorMessage: errorMessage.slice(0, 500),
        nextRetryAt,
        ...LOCK_CLEARED,
      },
    });

    if (result.count !== 1) {
      const job = await tx.indexingJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new JobTransitionError(
          "Indexing job not found.",
          "JOB_NOT_FOUND",
        );
      }

      throw new JobTransitionError(
        "Only processing jobs can be failed.",
        "INVALID_TRANSITION",
      );
    }

    const job = await tx.indexingJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    if (drivesRepositoryStatus(job.type)) {
      await tx.repository.update({
        where: { id: job.repositoryId },
        data: { status: "FAILED" },
      });
    }

    return job;
  });
}

/**
 * Return an eligible failed job to the pending queue.
 */
export async function retryIndexingJob(jobId: string, options: { now?: Date } = {}) {
  return prisma.$transaction(async (tx) => {
    const existingJob = await tx.indexingJob.findUnique({
      where: { id: jobId },
    });

    if (!existingJob) {
      throw new JobTransitionError("Indexing job not found.", "JOB_NOT_FOUND");
    }
    const now = options.now ?? new Date();

    const result = await tx.indexingJob.updateMany({
      where: {
        id: jobId,
        status: "FAILED",
        attempts: {
          lt: existingJob.maxAttempts,
        },
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      data: {
        status: "PENDING",
        startedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
        ...LOCK_CLEARED,
      },
    });

    if (result.count !== 1) {
      const job = await tx.indexingJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        throw new JobTransitionError(
          "Indexing job not found.",
          "JOB_NOT_FOUND",
        );
      }

      if (job.attempts >= job.maxAttempts) {
        throw new JobTransitionError(
          "Maximum processing attempts reached.",
          "MAX_ATTEMPTS_REACHED",
        );
      }

      throw new JobTransitionError(
        "Job is not currently eligible for retry.",
        "INVALID_TRANSITION",
      );
    }

    const job = await tx.indexingJob.findUniqueOrThrow({
      where: { id: jobId },
    });

    // Never run two active jobs of the same kind at the same time: one per
    // repository for ingestion, one per dedupe key for everything else.
    // Checked only after the job is known to be eligible, so existing error
    // codes are unchanged. Throwing rolls the transaction back, so the job
    // stays FAILED.
    const otherActiveJob = await tx.indexingJob.findFirst({
      where: drivesRepositoryStatus(job.type)
        ? {
            repositoryId: job.repositoryId,
            type: "REPOSITORY_INDEX",
            id: { not: jobId },
            status: { in: ["PENDING", "PROCESSING"] },
          }
        : {
            dedupeKey: job.dedupeKey ?? `job:${job.id}`,
            id: { not: jobId },
            status: { in: ["PENDING", "PROCESSING"] },
          },
      select: { id: true },
    });

    if (otherActiveJob) {
      throw new JobTransitionError(
        "Another job is already active for this repository.",
        "JOB_ALREADY_CLAIMED",
      );
    }

    if (drivesRepositoryStatus(job.type)) {
      await tx.repository.update({
        where: { id: job.repositoryId },
        data: { status: "QUEUED" },
      });
    }

    return job;
  });
}
