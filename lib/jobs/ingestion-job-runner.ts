// lib/jobs/ingestion-job-runner.ts
import type { IndexingJob } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { ingestRepositorySnapshot } from "@/lib/ingestion/snapshot/snapshot-ingestion.service";
import { SnapshotIngestionError } from "@/lib/ingestion/snapshot/snapshot.errors";
import type { SnapshotIngestionResult } from "@/lib/ingestion/snapshot/snapshot.types";
import { JobTransitionError } from "./job-errors";
import { failIndexingJob, startIndexingJob } from "./job-lifecycle";

export type IndexingJobOutcome =
  | {
      kind: "INGESTED";
      jobId: string;
      result: SnapshotIngestionResult;
    }
  | {
      kind: "FAILED";
      jobId: string;
      code: string;
      /** Safe underlying GitHub code (for example RATE_LIMITED), for logs. */
      causeCode?: string;
      /** Fixed, content-free message of the ingestion error (safe to log). */
      detail?: string;
    }
  | {
      kind: "SKIPPED";
      jobId: string;
      reason: "CLAIMED_ELSEWHERE" | "MAX_ATTEMPTS_REACHED" | "NOT_FOUND";
    };

export function validateRepositoryMetadata(repository: {
  ownerLogin: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}): boolean {
  if (
    !repository.ownerLogin.trim() ||
    !repository.name.trim() ||
    !repository.fullName.trim() ||
    !repository.htmlUrl.trim()
  ) {
    return false;
  }

  try {
    const url = new URL(repository.htmlUrl);

    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      repository.fullName.toLowerCase() ===
        `${repository.ownerLogin}/${repository.name}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Run one existing Sprint 01 indexing job through snapshot ingestion.
 *
 * The job is claimed with the existing lifecycle function, so the job
 * state machine, attempts and retry back-off are unchanged. Snapshot
 * ingestion marks the job completed or failed itself.
 *
 * The exact commit comes from the job's targetCommitSha (established when
 * the job was created). The default branch is only a fallback for jobs
 * created before a commit was recorded.
 */
export async function processIndexingJob(
  jobId: string,
): Promise<IndexingJobOutcome> {
  let job;

  try {
    job = await startIndexingJob(jobId);
  } catch (error) {
    if (error instanceof JobTransitionError) {
      if (error.code === "MAX_ATTEMPTS_REACHED") {
        return { kind: "SKIPPED", jobId, reason: "MAX_ATTEMPTS_REACHED" };
      }

      if (error.code === "JOB_NOT_FOUND") {
        return { kind: "SKIPPED", jobId, reason: "NOT_FOUND" };
      }

      return { kind: "SKIPPED", jobId, reason: "CLAIMED_ELSEWHERE" };
    }

    throw error;
  }

  return runIngestionForClaimedJob(job);
}

/**
 * Ingest for a job that is already claimed (PROCESSING). Used by
 * processIndexingJob after its own claim and by the production worker, whose
 * queue claims atomically before handing the job over.
 */
export async function runIngestionForClaimedJob(
  job: Pick<IndexingJob, "id" | "repositoryId" | "targetCommitSha">,
): Promise<IndexingJobOutcome> {
  const repository = await prisma.repository.findUnique({
    where: { id: job.repositoryId },
    select: {
      id: true,
      ownerLogin: true,
      name: true,
      fullName: true,
      htmlUrl: true,
      defaultBranch: true,
    },
  });

  const revision = job.targetCommitSha ?? repository?.defaultBranch ?? null;

  if (!repository || !validateRepositoryMetadata(repository) || !revision) {
    await failIndexingJob(
      job.id,
      "INVALID_REPOSITORY_METADATA",
      "Repository metadata is missing or invalid.",
    );

    return {
      kind: "FAILED",
      jobId: job.id,
      code: "INVALID_REPOSITORY_METADATA",
    };
  }

  try {
    const result = await ingestRepositorySnapshot({
      repositoryId: repository.id,
      jobId: job.id,
      owner: repository.ownerLogin,
      repositoryName: repository.name,
      revision,
    });

    return { kind: "INGESTED", jobId: job.id, result };
  } catch (error) {
    // The ingestion service has already recorded the job failure.
    const code =
      error instanceof SnapshotIngestionError
        ? error.code
        : "FILE_INGESTION_FAILED";

    const rawCause =
      error instanceof SnapshotIngestionError &&
      error.cause &&
      typeof (error.cause as { code?: unknown }).code === "string"
        ? (error.cause as { code: string }).code
        : undefined;
    const causeCode =
      rawCause && /^[A-Z0-9_]{1,64}$/.test(rawCause) ? rawCause : undefined;

    const detail =
      error instanceof SnapshotIngestionError
        ? error.message.slice(0, 200)
        : undefined;

    return { kind: "FAILED", jobId: job.id, code, causeCode, detail };
  }
}
