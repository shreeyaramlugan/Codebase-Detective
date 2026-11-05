// lib/jobs/ingestion-job-runner.ts
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

    return { kind: "FAILED", jobId: job.id, code };
  }
}
