import { prisma } from "@/lib/db/prisma";
import { JobTransitionError } from "./job-errors";

/**
 * Start a pending indexing job.
 *
 * The conditional update prevents two callers from
 * claiming the same job simultaneously.
 */
export async function startIndexingJob(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const existingJob = await tx.indexingJob.findUnique({
      where: { id: jobId },
    });

    if (!existingJob) {
      throw new JobTransitionError("Indexing job not found.", "JOB_NOT_FOUND");
    }
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
        startedAt: new Date(),
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
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

    await tx.repository.update({
      where: { id: job.repositoryId },
      data: { status: "INDEXING" },
    });

    return job;
  });
}

/**
 * Mark a processing job as completed.
 */
export async function completeIndexingJob(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const result = await tx.indexingJob.updateMany({
      where: {
        id: jobId,
        status: "PROCESSING",
      },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
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

    await tx.repository.update({
      where: { id: job.repositoryId },
      data: { status: "INDEXED" },
    });

    return job;
  });
}

/**
 * Mark a processing job as failed and schedule its next retry.
 *
 * Retry policy:
 * Attempt 1 failure: retry after 30 seconds.
 * Attempt 2 failure: retry after 60 seconds.
 * Maximum attempts reached: no further retry.
 *
 * Only safe, user-facing error information should be supplied.
 * Never pass stack traces, secrets or raw internal exceptions.
 */
export async function failIndexingJob(
  jobId: string,
  errorCode: string,
  errorMessage: string,
) {
  return prisma.$transaction(async (tx) => {
    const existingJob = await tx.indexingJob.findUnique({
      where: { id: jobId },
    });

    if (!existingJob) {
      throw new JobTransitionError("Indexing job not found.", "JOB_NOT_FOUND");
    }

    const now = new Date();

    // Schedule another attempt only if attempts remain.
    const retryDelayMs =
      30_000 * Math.pow(2, Math.max(0, existingJob.attempts - 1));

    const nextRetryAt =
      existingJob.attempts < existingJob.maxAttempts
        ? new Date(now.getTime() + retryDelayMs)
        : null;

    const result = await tx.indexingJob.updateMany({
      where: {
        id: jobId,
        status: "PROCESSING",
      },
      data: {
        status: "FAILED",
        completedAt: now,
        errorCode: errorCode.slice(0, 100),
        errorMessage: errorMessage.slice(0, 500),
        nextRetryAt,
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

    await tx.repository.update({
      where: { id: job.repositoryId },
      data: { status: "FAILED" },
    });

    return job;
  });
}

/**
 * Return an eligible failed job to the pending queue.
 */
export async function retryIndexingJob(jobId: string) {
  return prisma.$transaction(async (tx) => {
    const existingJob = await tx.indexingJob.findUnique({
      where: { id: jobId },
    });

    if (!existingJob) {
      throw new JobTransitionError("Indexing job not found.", "JOB_NOT_FOUND");
    }
    const now = new Date();

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

    await tx.repository.update({
      where: { id: job.repositoryId },
      data: { status: "QUEUED" },
    });

    return job;
  });
}
