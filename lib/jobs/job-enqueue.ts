// lib/jobs/job-enqueue.ts
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getLatestCommitSha } from "@/lib/github/github.client";

export class EnqueueError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "REPOSITORY_NOT_FOUND"
      | "JOB_ALREADY_ACTIVE"
      | "NO_COMMITS"
      | "NO_BRANCH",
  ) {
    super(message);
    this.name = "EnqueueError";
  }
}

const ACTIVE_JOB_STATUSES = ["PENDING", "PROCESSING"] as const;

/**
 * Queue a new ingestion job for a repository owned by the caller.
 *
 * - Ownership is enforced in the query, so another user's repository is
 *   indistinguishable from a missing one.
 * - The latest commit is resolved once and stored on the job; ingestion
 *   later uses exactly that SHA.
 * - Only one PENDING/PROCESSING job may exist per repository. The check
 *   and insert run in a serializable transaction so two simultaneous
 *   requests cannot both create a job.
 * - If a snapshot already exists for the commit it is reused by the
 *   worker, and only its failed files are retried.
 */
export async function enqueueIngestionJob(input: {
  repositoryId: string;
  ownerId: string;
}) {
  const repository = await prisma.repository.findFirst({
    where: { id: input.repositoryId, ownerId: input.ownerId },
    select: {
      id: true,
      ownerLogin: true,
      name: true,
      defaultBranch: true,
      lastCommitSha: true,
    },
  });

  if (!repository) {
    throw new EnqueueError("Repository not found.", "REPOSITORY_NOT_FOUND");
  }

  const activeJob = await prisma.indexingJob.findFirst({
    where: {
      repositoryId: repository.id,
      status: { in: [...ACTIVE_JOB_STATUSES] },
    },
    select: { id: true },
  });

  if (activeJob) {
    throw new EnqueueError(
      "An indexing job is already queued or running for this repository.",
      "JOB_ALREADY_ACTIVE",
    );
  }

  if (!repository.defaultBranch) {
    throw new EnqueueError(
      "The repository has no known default branch.",
      "NO_BRANCH",
    );
  }

  const commitSha =
    (await getLatestCommitSha(
      repository.ownerLogin,
      repository.name,
      repository.defaultBranch,
    )) ?? null;

  if (!commitSha) {
    throw new EnqueueError("The repository has no commits.", "NO_COMMITS");
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const conflicting = await tx.indexingJob.findFirst({
          where: {
            repositoryId: repository.id,
            status: { in: [...ACTIVE_JOB_STATUSES] },
          },
          select: { id: true },
        });

        if (conflicting) {
          throw new EnqueueError(
            "An indexing job is already queued or running for this repository.",
            "JOB_ALREADY_ACTIVE",
          );
        }

        const job = await tx.indexingJob.create({
          data: {
            repositoryId: repository.id,
            type: "REPOSITORY_INDEX",
            status: "PENDING",
            targetCommitSha: commitSha,
          },
        });

        await tx.repository.update({
          where: { id: repository.id },
          data: { status: "QUEUED", lastCommitSha: commitSha },
        });

        return job;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (error instanceof EnqueueError) {
      throw error;
    }

    // Serialization failure or unique violation: a concurrent request won.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2002")
    ) {
      throw new EnqueueError(
        "An indexing job is already queued or running for this repository.",
        "JOB_ALREADY_ACTIVE",
      );
    }

    throw error;
  }
}
