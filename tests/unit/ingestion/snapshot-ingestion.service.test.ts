// tests/unit/ingestion/snapshot-ingestion.service.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubApiError } from "@/lib/github/github.errors";
import { SnapshotIngestionError } from "@/lib/ingestion/snapshot/snapshot.errors";
import type { SourceStorageAdapter } from "@/lib/ingestion/storage/storage.types";
import type { SnapshotIngestionRequest } from "@/lib/ingestion/snapshot/snapshot.types";

const mocks = vi.hoisted(() => ({
  findJob: vi.fn(),
  resolveCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
  createStorage: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
  claimSnapshot: vi.fn(),
  clearFiles: vi.fn(),
  completeRecovery: vi.fn(),
  finalizeSnapshot: vi.fn(),
  findSnapshot: vi.fn(),
  getStorageKeys: vi.fn(),
  markSnapshotFailed: vi.fn(),
  markFileFailed: vi.fn(),
  markFileStored: vi.fn(),
  persistInventory: vi.fn(),
  startSnapshot: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    indexingJob: {
      findUnique: mocks.findJob,
    },
  },
}));

vi.mock("@/lib/github/github.client", () => ({
  resolveGitHubCommit: mocks.resolveCommit,
  getGitHubRepositoryTreeForCommit: mocks.getTree,
  getGitHubBlob: mocks.getBlob,
}));

vi.mock("@/lib/ingestion/storage/storage.factory", () => ({
  createSourceStorageAdapter: mocks.createStorage,
}));

vi.mock("@/lib/jobs/job-lifecycle", () => ({
  completeIndexingJob: mocks.completeJob,
  failIndexingJob: mocks.failJob,
}));

vi.mock("@/lib/ingestion/snapshot/snapshot.repository", () => ({
  claimSnapshotForIngestion: mocks.claimSnapshot,
  clearSnapshotFiles: mocks.clearFiles,
  completeSnapshotRecovery: mocks.completeRecovery,
  finalizeSnapshot: mocks.finalizeSnapshot,
  findSnapshotByCommit: mocks.findSnapshot,
  getSnapshotStorageKeys: mocks.getStorageKeys,
  markSnapshotFailed: mocks.markSnapshotFailed,
  markSnapshotFileFailed: mocks.markFileFailed,
  markSnapshotFileStored: mocks.markFileStored,
  persistSnapshotInventory: mocks.persistInventory,
  startSnapshotIngestion: mocks.startSnapshot,
}));

import { ingestRepositorySnapshot } from "@/lib/ingestion/snapshot/snapshot-ingestion.service";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA_1 = "c".repeat(40);
const BLOB_SHA_2 = "d".repeat(40);

const request: SnapshotIngestionRequest = {
  repositoryId: "repository-1",
  jobId: "job-1",
  owner: "test-owner",
  repositoryName: "test-repository",
  revision: "main",
};

const commit = {
  sha: COMMIT_SHA,
  treeSha: TREE_SHA,
  message: "Test commit",
  authorName: "Test Author",
  committedAt: "2026-11-03T10:00:00.000Z",
};

const completeSummary = {
  totalFiles: 2,
  eligibleFiles: 1,
  storedFiles: 1,
  skippedFiles: 1,
  failedFiles: 0,
  totalBytes: BigInt(100),
};

const partialSummary = {
  totalFiles: 3,
  eligibleFiles: 2,
  storedFiles: 1,
  skippedFiles: 1,
  failedFiles: 1,
  totalBytes: BigInt(100),
};

function createTree(sourceFileCount = 1) {
  const entries = [
    {
      path: "assets/logo.png",
      mode: "100644",
      type: "blob" as const,
      sha: "e".repeat(40),
      size: 50,
    },
  ];

  if (sourceFileCount >= 1) {
    entries.push({
      path: "src/index.ts",
      mode: "100644",
      type: "blob" as const,
      sha: BLOB_SHA_1,
      size: 100,
    });
  }

  if (sourceFileCount >= 2) {
    entries.push({
      path: "src/utils.ts",
      mode: "100644",
      type: "blob" as const,
      sha: BLOB_SHA_2,
      size: 100,
    });
  }

  return {
    commitSha: COMMIT_SHA,
    rootTreeSha: TREE_SHA,
    entries,
    recoveredFromTruncation: false,
  };
}

/** Content padded to the 100 bytes declared for each tree entry. */
function sourceBytes(text: string): Buffer {
  return Buffer.from(text.padEnd(100, " "));
}

function createStorage(): SourceStorageAdapter {
  return {
    put: vi.fn().mockResolvedValue({
      storageKey: "objects/test-object",
      contentHash: "f".repeat(64),
      sizeBytes: 100,
    }),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn(),
  };
}

function createSnapshotResult(
  completeness: "COMPLETE" | "PARTIAL" | "FAILED",
  summary = completeSummary,
) {
  return {
    snapshotId: "snapshot-1",
    status:
      completeness === "FAILED" ? ("FAILED" as const) : ("COMPLETED" as const),
    completeness,
    summary,
  };
}

describe("ingestRepositorySnapshot", () => {
  let storage: SourceStorageAdapter;

  beforeEach(() => {
    vi.resetAllMocks();

    storage = createStorage();

    mocks.findJob.mockResolvedValue({
      id: request.jobId,
      repositoryId: request.repositoryId,
      status: "PROCESSING",
      repository: {
        ownerLogin: request.owner,
        name: request.repositoryName,
        visibility: "PUBLIC",
      },
    });

    mocks.resolveCommit.mockResolvedValue(commit);

    mocks.getTree.mockResolvedValue(createTree());

    mocks.getBlob.mockResolvedValue({
      sha: BLOB_SHA_1,
      sizeBytes: 100,
      content: sourceBytes("export const answer = 42;"),
    });

    mocks.createStorage.mockReturnValue(storage);

    mocks.claimSnapshot.mockResolvedValue({
      kind: "CLAIMED",
      snapshotId: "snapshot-1",
      isNew: true,
    });

    mocks.finalizeSnapshot.mockResolvedValue(createSnapshotResult("COMPLETE"));

    mocks.completeJob.mockResolvedValue({});
    mocks.failJob.mockResolvedValue({});
    mocks.markSnapshotFailed.mockResolvedValue(undefined);
    mocks.startSnapshot.mockResolvedValue(undefined);
    mocks.persistInventory.mockResolvedValue(undefined);
    mocks.markFileStored.mockResolvedValue(undefined);
    mocks.markFileFailed.mockResolvedValue(undefined);
    mocks.getStorageKeys.mockResolvedValue([]);
    mocks.clearFiles.mockResolvedValue(undefined);
    mocks.completeRecovery.mockResolvedValue(undefined);
  });

  it("ingests a public repository snapshot successfully", async () => {
    const result = await ingestRepositorySnapshot(request, { storage });

    expect(result).toEqual({
      snapshotId: "snapshot-1",
      commit,
      status: "COMPLETED",
      completeness: "COMPLETE",
      summary: completeSummary,
    });

    expect(mocks.findJob).toHaveBeenCalledWith({
      where: { id: request.jobId },
      include: { repository: true },
    });

    expect(mocks.resolveCommit).toHaveBeenCalledWith(
      request.owner,
      request.repositoryName,
      request.revision,
    );

    expect(mocks.getTree).toHaveBeenCalledWith(
      request.owner,
      request.repositoryName,
      commit,
    );

    expect(mocks.startSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(mocks.persistInventory).toHaveBeenCalledOnce();

    expect(mocks.getBlob).toHaveBeenCalledTimes(1);
    expect(storage.put).toHaveBeenCalledOnce();
    expect(mocks.markFileStored).toHaveBeenCalledOnce();

    expect(mocks.finalizeSnapshot).toHaveBeenCalledWith("snapshot-1");

    expect(mocks.completeJob).toHaveBeenCalledWith(request.jobId, "INDEXED");

    expect(mocks.failJob).not.toHaveBeenCalled();
    expect(mocks.markSnapshotFailed).not.toHaveBeenCalled();
  });

  it("marks a usable snapshot as partially indexed when one file fails", async () => {
    mocks.getTree.mockResolvedValue(createTree(2));

    mocks.getBlob
      .mockRejectedValueOnce(
        new GitHubApiError("Blob not found", "NOT_FOUND", 404, false),
      )
      .mockResolvedValueOnce({
        sha: BLOB_SHA_2,
        sizeBytes: 100,
        content: sourceBytes("export const helper = true;"),
      });

    mocks.finalizeSnapshot.mockResolvedValue(
      createSnapshotResult("PARTIAL", partialSummary),
    );

    const result = await ingestRepositorySnapshot(request, { storage });

    expect(result.completeness).toBe("PARTIAL");
    expect(result.status).toBe("COMPLETED");

    expect(mocks.getBlob).toHaveBeenCalledTimes(2);
    expect(mocks.markFileFailed).toHaveBeenCalledOnce();
    expect(mocks.markFileStored).toHaveBeenCalledOnce();

    expect(mocks.completeJob).toHaveBeenCalledWith(
      request.jobId,
      "PARTIALLY_INDEXED",
    );

    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("fails the job immediately when GitHub rate limits blob retrieval", async () => {
    mocks.getBlob.mockRejectedValue(
      new GitHubApiError(
        "GitHub rate limit exceeded",
        "RATE_LIMITED",
        403,
        true,
        60,
      ),
    );

    await expect(
      ingestRepositorySnapshot(request, { storage }),
    ).rejects.toMatchObject({
      code: "TREE_RETRIEVAL_FAILED",
      retryable: true,
    });

    // Rate limits are handled by the job retry mechanism.
    expect(mocks.getBlob).toHaveBeenCalledTimes(1);

    expect(mocks.markFileFailed).not.toHaveBeenCalled();
    expect(mocks.finalizeSnapshot).not.toHaveBeenCalled();

    expect(mocks.markSnapshotFailed).toHaveBeenCalledWith("snapshot-1");

    expect(mocks.failJob).toHaveBeenCalledWith(
      request.jobId,
      "TREE_RETRIEVAL_FAILED",
      "GitHub rate limits prevented repository ingestion.",
    );

    expect(mocks.completeJob).not.toHaveBeenCalled();
  });

  it("rejects a repository with no usable source files", async () => {
    mocks.getTree.mockResolvedValue({
      commitSha: COMMIT_SHA,
      rootTreeSha: TREE_SHA,
      entries: [
        {
          path: "assets/logo.png",
          mode: "100644",
          type: "blob",
          sha: "e".repeat(40),
          size: 50,
        },
      ],
      recoveredFromTruncation: false,
    });

    mocks.finalizeSnapshot.mockResolvedValue(
      createSnapshotResult("FAILED", {
        totalFiles: 1,
        eligibleFiles: 0,
        storedFiles: 0,
        skippedFiles: 1,
        failedFiles: 0,
        totalBytes: BigInt(0),
      }),
    );

    await expect(
      ingestRepositorySnapshot(request, { storage }),
    ).rejects.toMatchObject({
      code: "NO_USABLE_SOURCE_FILES",
    });

    expect(mocks.getBlob).not.toHaveBeenCalled();
    expect(mocks.completeJob).not.toHaveBeenCalled();

    expect(mocks.markSnapshotFailed).toHaveBeenCalledWith("snapshot-1");

    expect(mocks.failJob).toHaveBeenCalledWith(
      request.jobId,
      "NO_USABLE_SOURCE_FILES",
      "No usable source files could be stored for this repository snapshot.",
    );
  });

  it("reuses an already completed snapshot without downloading files again", async () => {
    mocks.claimSnapshot.mockResolvedValue({
      kind: "COMPLETED",
      snapshotId: "snapshot-1",
    });

    mocks.findSnapshot.mockResolvedValue({
      id: "snapshot-1",
      completeness: "COMPLETE",
      totalFiles: 2,
      eligibleFiles: 1,
      storedFiles: 1,
      skippedFiles: 1,
      failedFiles: 0,
      totalBytes: BigInt(100),
    });

    const result = await ingestRepositorySnapshot(request, { storage });

    expect(result.snapshotId).toBe("snapshot-1");
    expect(result.completeness).toBe("COMPLETE");

    expect(mocks.findSnapshot).toHaveBeenCalledWith(
      request.repositoryId,
      COMMIT_SHA,
    );

    expect(mocks.getTree).not.toHaveBeenCalled();
    expect(mocks.getBlob).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();

    expect(mocks.completeJob).toHaveBeenCalledWith(request.jobId, "INDEXED");

    expect(mocks.markSnapshotFailed).not.toHaveBeenCalled();
  });

  it("cleans up a previously failed snapshot before ingesting it again", async () => {
    mocks.claimSnapshot.mockResolvedValue({
      kind: "RECOVERY_REQUIRED",
      snapshotId: "snapshot-1",
    });

    mocks.getStorageKeys.mockResolvedValue(["objects/old-source-file"]);

    const deleteStorage = vi.fn().mockResolvedValue(undefined);

    const recoveryStorage: SourceStorageAdapter = {
      ...storage,
      delete: deleteStorage,
    };

    await ingestRepositorySnapshot(request, { storage: recoveryStorage });

    expect(mocks.getStorageKeys).toHaveBeenCalledWith("snapshot-1");

    expect(deleteStorage).toHaveBeenCalledWith("objects/old-source-file");

    expect(mocks.clearFiles).toHaveBeenCalledWith("snapshot-1");

    expect(mocks.completeRecovery).toHaveBeenCalledWith("snapshot-1");

    expect(mocks.getTree).toHaveBeenCalledOnce();
    expect(mocks.completeJob).toHaveBeenCalledOnce();
  });
});
