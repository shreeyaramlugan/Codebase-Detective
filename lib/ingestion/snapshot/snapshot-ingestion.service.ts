// lib/ingestion/snapshot/snapshot-ingestion.service.ts
import { prisma } from "@/lib/db/prisma";
import {
  getGitHubBlob,
  getGitHubRepositoryTreeForCommit,
  resolveGitHubCommit,
} from "@/lib/github/github.client";
import { GitHubApiError } from "@/lib/github/github.errors";
import { INGESTION_LIMITS } from "@/lib/ingestion/classification/ingestion-limits";
import { classifyGitHubTreeEntry } from "@/lib/ingestion/classification/file-classifier";
import { planSnapshotFiles } from "@/lib/ingestion/classification/snapshot-limit-planner";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";
import type { SourceStorageAdapter } from "@/lib/ingestion/storage/storage.types";
import { completeIndexingJob, failIndexingJob } from "@/lib/jobs/job-lifecycle";
import {
  beginFailedFileRetry,
  claimSnapshotForIngestion,
  clearSnapshotFiles,
  completeSnapshotRecovery,
  finalizeSnapshot,
  findSnapshotByCommit,
  getSnapshotStorageKeys,
  markSnapshotFailed,
  markSnapshotFileFailed,
  markSnapshotFileStored,
  persistSnapshotInventory,
  startSnapshotIngestion,
} from "./snapshot.repository";
import { SnapshotIngestionError } from "./snapshot.errors";
import type {
  SnapshotIngestionRequest,
  SnapshotIngestionResult,
} from "./snapshot.types";

const MAX_CONCURRENT_BLOBS = 3;

interface IngestionDependencies {
  storage: SourceStorageAdapter;
}

function getSafeErrorDetails(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof SnapshotIngestionError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  if (error instanceof GitHubApiError) {
    return {
      code: error.code,
      message: "GitHub could not provide one or more repository files.",
      retryable: error.retryable,
    };
  }

  return {
    code: "FILE_INGESTION_FAILED",
    message: "Repository file ingestion failed.",
    retryable: false,
  };
}

function safeFailureCode(error: unknown): string {
  const details = getSafeErrorDetails(error);

  return /^[A-Z0-9_]{1,64}$/.test(details.code)
    ? details.code
    : "FILE_INGESTION_FAILED";
}

async function retrieveBlobWithRetry(
  owner: string,
  repositoryName: string,
  blobSha: string,
) {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= INGESTION_LIMITS.MAX_BLOB_RETRIEVAL_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await getGitHubBlob(owner, repositoryName, blobSha);
    } catch (error) {
      lastError = error;

      if (
        !(error instanceof GitHubApiError) ||
        error.code === "RATE_LIMITED" ||
        !error.retryable ||
        attempt === INGESTION_LIMITS.MAX_BLOB_RETRIEVAL_ATTEMPTS
      ) {
        throw error;
      }

      // Keep retries bounded. Long GitHub rate-limit waits are left
      // to the indexing-job retry mechanism rather than blocking a worker.
      await new Promise((resolve) =>
        setTimeout(resolve, 250 * Math.pow(2, attempt - 1)),
      );
    }
  }

  throw lastError;
}

async function processEligibleFile(
  request: SnapshotIngestionRequest,
  snapshotId: string,
  file: ReturnType<typeof classifyGitHubTreeEntry>,
  storage: SourceStorageAdapter,
): Promise<void> {
  if (
    file.status !== "ELIGIBLE" ||
    !file.gitBlobSha ||
    file.sizeBytes === null
  ) {
    return;
  }

  let storedObject: Awaited<ReturnType<SourceStorageAdapter["put"]>> | null =
    null;

  try {
    const blob = await retrieveBlobWithRetry(
      request.owner,
      request.repositoryName,
      file.gitBlobSha,
    );

    if (blob.sha.toLowerCase() !== file.gitBlobSha.toLowerCase()) {
      throw new SnapshotIngestionError(
        "The retrieved file did not match its expected Git object.",
        "FILE_INGESTION_FAILED",
      );
    }

    if (blob.sizeBytes !== file.sizeBytes) {
      throw new SnapshotIngestionError(
        "The retrieved file size did not match the repository tree.",
        "FILE_INGESTION_FAILED",
      );
    }

    if (blob.content.length !== file.sizeBytes) {
      throw new SnapshotIngestionError(
        "The retrieved file content failed size validation.",
        "FILE_INGESTION_FAILED",
      );
    }

    storedObject = await storage.put(blob.content);

    if (storedObject.sizeBytes !== blob.sizeBytes) {
      throw new SnapshotIngestionError(
        "Stored file size validation failed.",
        "FILE_INGESTION_FAILED",
      );
    }

    await markSnapshotFileStored({
      snapshotId,
      path: file.path,
      contentHash: storedObject.contentHash,
      storageKey: storedObject.storageKey,
      sizeBytes: storedObject.sizeBytes,
    });
  } catch (error) {
    // Compensate for a successful storage write followed by a failed
    // database update.
    if (storedObject) {
      try {
        await storage.delete(storedObject.storageKey);
      } catch (cleanupError) {
        throw new SnapshotIngestionError(
          "A stored file could not be cleaned up after a persistence failure.",
          "STORAGE_CLEANUP_FAILED",
          true,
          cleanupError,
        );
      }
    }

    // Rate limiting is a job-level failure, not an individual file failure.
    // Let the job retry mechanism handle the next attempt.
    if (error instanceof GitHubApiError && error.code === "RATE_LIMITED") {
      throw new SnapshotIngestionError(
        "GitHub rate limits prevented repository ingestion.",
        "TREE_RETRIEVAL_FAILED",
        true,
        error,
      );
    }

    await markSnapshotFileFailed({
      snapshotId,
      path: file.path,
      failureCode: safeFailureCode(error),
    });
  }
}

async function processFilesWithConcurrency(
  request: SnapshotIngestionRequest,
  snapshotId: string,
  files: ReturnType<typeof classifyGitHubTreeEntry>[],
  storage: SourceStorageAdapter,
): Promise<void> {
  const eligibleFiles = files.filter((file) => file.status === "ELIGIBLE");

  let nextIndex = 0;
  let hasFailed = false;
  let firstError: unknown;

  async function worker(): Promise<void> {
    while (!hasFailed) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= eligibleFiles.length) {
        return;
      }

      try {
        await processEligibleFile(
          request,
          snapshotId,
          eligibleFiles[currentIndex],
          storage,
        );
      } catch (error) {
        if (!hasFailed) {
          hasFailed = true;
          firstError = error;
        }
      }
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_BLOBS, eligibleFiles.length);

  // Wait for every active worker to finish before allowing the
  // caller to fail the snapshot.
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (hasFailed) {
    throw firstError;
  }
}

async function recoverSnapshot(
  snapshotId: string,
  storage: SourceStorageAdapter,
): Promise<void> {
  const storageKeys = await getSnapshotStorageKeys(snapshotId);

  // Delete sequentially so recovery remains predictable and idempotent.
  for (const storageKey of storageKeys) {
    try {
      await storage.delete(storageKey);
    } catch (error) {
      throw new SnapshotIngestionError(
        "Previous snapshot files could not be cleaned up.",
        "STORAGE_CLEANUP_FAILED",
        true,
        error,
      );
    }
  }

  await clearSnapshotFiles(snapshotId);
  await completeSnapshotRecovery(snapshotId);
}

async function validateProcessingJob(
  request: SnapshotIngestionRequest,
): Promise<void> {
  const job = await prisma.indexingJob.findUnique({
    where: { id: request.jobId },
    include: {
      repository: true,
    },
  });

  if (!job || job.repositoryId !== request.repositoryId) {
    throw new SnapshotIngestionError(
      "The indexing job or its repository could not be found.",
      "INVALID_REQUEST",
    );
  }

  if (job.status !== "PROCESSING") {
    throw new SnapshotIngestionError(
      "The indexing job must already be claimed before ingestion.",
      "SNAPSHOT_CONFLICT",
    );
  }

  if (
    job.repository.ownerLogin.toLowerCase() !== request.owner.toLowerCase() ||
    job.repository.name.toLowerCase() !== request.repositoryName.toLowerCase()
  ) {
    throw new SnapshotIngestionError(
      "The requested repository does not match the indexing job.",
      "INVALID_REQUEST",
    );
  }

  if (job.repository.visibility.toUpperCase() !== "PUBLIC") {
    throw new SnapshotIngestionError(
      "Only public GitHub repositories can be ingested.",
      "INVALID_REQUEST",
    );
  }
}

function needsFileRetry(snapshot: {
  completeness: string | null;
  eligibleFiles: number;
  storedFiles: number;
  failedFiles: number;
}): boolean {
  return (
    snapshot.completeness === "PARTIAL" &&
    (snapshot.failedFiles > 0 ||
      snapshot.storedFiles + snapshot.failedFiles < snapshot.eligibleFiles)
  );
}

/**
 * Retry only the failed/unprocessed eligible files of a PARTIAL snapshot.
 * Files that are already STORED are left untouched, so nothing is
 * downloaded or written twice. The pinned blob SHAs recorded for the
 * original commit are reused, so the exact commit never changes.
 */
async function retryFailedFiles(
  request: SnapshotIngestionRequest,
  commit: Awaited<ReturnType<typeof resolveGitHubCommit>>,
  snapshotId: string,
  storage: SourceStorageAdapter,
): Promise<SnapshotIngestionResult> {
  const retryFiles = await beginFailedFileRetry(snapshotId);

  if (retryFiles === null) {
    throw new SnapshotIngestionError(
      "The snapshot could not be reopened for file retry.",
      "SNAPSHOT_CONFLICT",
      true,
    );
  }

  const files = retryFiles.map((file) => ({
    path: file.path,
    name: file.name,
    extension: file.extension,
    status: "ELIGIBLE" as const,
    category: file.category,
    reason: null,
    gitBlobSha: file.gitBlobSha,
    sizeBytes: file.sizeBytes,
  }));

  try {
    await processFilesWithConcurrency(request, snapshotId, files, storage);
  } catch (error) {
    // Stored files remain valid. Recompute the snapshot from its file
    // records so that it returns to a consistent PARTIAL state.
    try {
      await finalizeSnapshot(snapshotId);
    } catch {
      // If it cannot be restored, mark it failed so a later run recovers it.
      try {
        await markSnapshotFailed(snapshotId);
      } catch {
        // Preserve the original error.
      }
    }

    throw error;
  }

  const finalized = await finalizeSnapshot(snapshotId);

  if (finalized.status === "FAILED") {
    throw new SnapshotIngestionError(
      "No usable source files could be stored for this repository snapshot.",
      "NO_USABLE_SOURCE_FILES",
    );
  }

  await completeIndexingJob(
    request.jobId,
    finalized.completeness === "PARTIAL" ? "PARTIALLY_INDEXED" : "INDEXED",
  );

  return buildResult(snapshotId, commit, finalized);
}

function buildResult(
  snapshotId: string,
  commit: Awaited<ReturnType<typeof resolveGitHubCommit>>,
  result: Awaited<ReturnType<typeof finalizeSnapshot>>,
): SnapshotIngestionResult {
  return {
    snapshotId,
    commit,
    status: result.status,
    completeness: result.completeness,
    summary: result.summary,
  };
}

export async function ingestRepositorySnapshot(
  request: SnapshotIngestionRequest,
  dependencies?: Partial<IngestionDependencies>,
): Promise<SnapshotIngestionResult> {
  let claimedSnapshotId: string | null = null;

  const storage = dependencies?.storage ?? createSourceStorageAdapter();

  try {
    if (
      !request.repositoryId.trim() ||
      !request.jobId.trim() ||
      !request.owner.trim() ||
      !request.repositoryName.trim() ||
      !request.revision.trim()
    ) {
      throw new SnapshotIngestionError(
        "All repository ingestion request fields are required.",
        "INVALID_REQUEST",
      );
    }

    await validateProcessingJob(request);

    // Resolve the mutable branch/tag once. Everything afterwards uses
    // the immutable commit SHA and its tree.
    const commit = await resolveGitHubCommit(
      request.owner,
      request.repositoryName,
      request.revision,
    );

    const claim = await claimSnapshotForIngestion({
      repositoryId: request.repositoryId,
      commit,
    });

    claimedSnapshotId = claim.snapshotId;

    if (claim.kind === "COMPLETED") {
      const existing = await findSnapshotByCommit(
        request.repositoryId,
        commit.sha,
      );

      if (!existing || !existing.completeness) {
        throw new SnapshotIngestionError(
          "The completed snapshot metadata could not be retrieved.",
          "SNAPSHOT_PERSISTENCE_FAILED",
          true,
        );
      }

      if (needsFileRetry(existing)) {
        // The retry path restores the snapshot itself. Never mark a
        // completed snapshot (or one another worker now owns) as failed.
        claimedSnapshotId = null;

        return await retryFailedFiles(request, commit, existing.id, storage);
      }

      await completeIndexingJob(
        request.jobId,
        existing.completeness === "PARTIAL" ? "PARTIALLY_INDEXED" : "INDEXED",
      );

      return {
        snapshotId: existing.id,
        commit,
        status: "COMPLETED",
        completeness: existing.completeness,
        summary: {
          totalFiles: existing.totalFiles,
          eligibleFiles: existing.eligibleFiles,
          storedFiles: existing.storedFiles,
          skippedFiles: existing.skippedFiles,
          failedFiles: existing.failedFiles,
          totalBytes: existing.totalBytes,
        },
      };
    }

    if (claim.kind === "RECOVERY_REQUIRED") {
      await recoverSnapshot(claim.snapshotId, storage);
    }

    const tree = await getGitHubRepositoryTreeForCommit(
      request.owner,
      request.repositoryName,
      commit,
    );

    if (tree.commitSha.toLowerCase() !== commit.sha.toLowerCase()) {
      throw new SnapshotIngestionError(
        "The retrieved repository tree does not match the requested commit.",
        "TREE_INCOMPLETE",
      );
    }

    if (tree.entries.length > INGESTION_LIMITS.MAX_TREE_ENTRIES) {
      throw new SnapshotIngestionError(
        "The repository tree exceeds the permitted entry limit.",
        "TREE_INCOMPLETE",
      );
    }

    await startSnapshotIngestion(claim.snapshotId);

    const classifications = tree.entries.map((entry) =>
      classifyGitHubTreeEntry(entry),
    );

    const plan = planSnapshotFiles(classifications);

    await persistSnapshotInventory({
      snapshotId: claim.snapshotId,
      files: plan.files,
    });

    await processFilesWithConcurrency(
      request,
      claim.snapshotId,
      plan.files,
      storage,
    );

    const finalized = await finalizeSnapshot(claim.snapshotId);

    if (finalized.status === "FAILED") {
      throw new SnapshotIngestionError(
        "No usable source files could be stored for this repository snapshot.",
        "NO_USABLE_SOURCE_FILES",
      );
    }

    await completeIndexingJob(
      request.jobId,
      finalized.completeness === "PARTIAL" ? "PARTIALLY_INDEXED" : "INDEXED",
    );

    return buildResult(claim.snapshotId, commit, finalized);
  } catch (error) {
    if (claimedSnapshotId) {
      try {
        await markSnapshotFailed(claimedSnapshotId);
      } catch {
        // Preserve the original ingestion error.
      }
    }

    const details = getSafeErrorDetails(error);

    try {
      await failIndexingJob(request.jobId, details.code, details.message);
    } catch {
      // The job may already have transitioned. Do not mask the original error.
    }

    if (error instanceof SnapshotIngestionError) {
      throw error;
    }

    if (error instanceof GitHubApiError) {
      throw new SnapshotIngestionError(
        "GitHub repository ingestion could not be completed.",
        "TREE_RETRIEVAL_FAILED",
        error.retryable,
        error,
      );
    }

    throw new SnapshotIngestionError(
      "Repository snapshot ingestion failed.",
      "FILE_INGESTION_FAILED",
      false,
      error,
    );
  }
}
