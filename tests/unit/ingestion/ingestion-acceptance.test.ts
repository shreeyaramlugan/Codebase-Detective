// tests/unit/ingestion/ingestion-acceptance.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GitHubApiError } from "@/lib/github/github.errors";
import { SnapshotIngestionError } from "@/lib/ingestion/snapshot/snapshot.errors";
import { StorageError } from "@/lib/ingestion/storage/storage.errors";
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
  beginRetry: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { indexingJob: { findUnique: mocks.findJob } },
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
  beginFailedFileRetry: mocks.beginRetry,
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
const BLOB_A = "c".repeat(40);
const BLOB_B = "d".repeat(40);

const request: SnapshotIngestionRequest = {
  repositoryId: "repository-1",
  jobId: "job-1",
  owner: "test-owner",
  repositoryName: "test-repository",
  revision: COMMIT_SHA,
};

const commit = {
  sha: COMMIT_SHA,
  treeSha: TREE_SHA,
  message: "Test commit",
  authorName: "Test Author",
  committedAt: "2026-11-03T10:00:00.000Z",
};

function bytes(size: number): Buffer {
  return Buffer.alloc(size, "x");
}

function entry(path: string, sha: string, size: number) {
  return { path, mode: "100644", type: "blob" as const, sha, size };
}

function tree(entries: ReturnType<typeof entry>[]) {
  return {
    commitSha: COMMIT_SHA,
    rootTreeSha: TREE_SHA,
    entries,
    recoveredFromTruncation: false,
  };
}

function finalResult(
  completeness: "COMPLETE" | "PARTIAL" | "FAILED",
  failedFiles = 0,
) {
  return {
    snapshotId: "snapshot-1",
    status:
      completeness === "FAILED" ? ("FAILED" as const) : ("COMPLETED" as const),
    completeness,
    summary: {
      totalFiles: 2,
      eligibleFiles: 2,
      storedFiles: 2 - failedFiles,
      skippedFiles: 0,
      failedFiles,
      totalBytes: BigInt(100),
    },
  };
}

function createStorage(): SourceStorageAdapter {
  return {
    put: vi.fn().mockImplementation(async (content: Buffer) => ({
      storageKey: `objects/${content.length}`,
      contentHash: "f".repeat(64),
      sizeBytes: content.length,
    })),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn(),
  };
}

describe("Sprint 02 ingestion acceptance and edge cases", () => {
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
    mocks.getTree.mockResolvedValue(tree([entry("src/a.ts", BLOB_A, 10)]));
    mocks.getBlob.mockImplementation(
      async (_o: string, _r: string, sha: string) => ({
        sha,
        sizeBytes: 10,
        content: bytes(10),
      }),
    );
    mocks.createStorage.mockReturnValue(storage);
    mocks.claimSnapshot.mockResolvedValue({
      kind: "CLAIMED",
      snapshotId: "snapshot-1",
      isNew: true,
    });
    mocks.finalizeSnapshot.mockResolvedValue(finalResult("COMPLETE"));
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

  describe("classification of every tree entry", () => {
    it("persists an explicit classification and reason for every discovered entry", async () => {
      mocks.getTree.mockResolvedValue(
        tree([
          entry("src/a.ts", BLOB_A, 10),
          entry("node_modules/pkg/index.js", BLOB_B, 10),
          entry(".env", "1".repeat(40), 10),
          entry("assets/logo.png", "2".repeat(40), 10),
          entry("keys/id_rsa", "3".repeat(40), 10),
          entry("dist/bundle.js", "4".repeat(40), 10),
        ]),
      );

      await ingestRepositorySnapshot(request, { storage });

      const { files } = mocks.persistInventory.mock.calls[0][0];

      expect(files).toHaveLength(6);

      for (const file of files) {
        expect(["ELIGIBLE", "SKIPPED"]).toContain(file.status);

        if (file.status === "SKIPPED") {
          expect(file.reason).toBeTruthy();
        } else {
          expect(file.reason).toBeNull();
        }
      }

      const eligible = files.filter(
        (file: { status: string }) => file.status === "ELIGIBLE",
      );

      expect(eligible.map((file: { path: string }) => file.path)).toEqual([
        "src/a.ts",
      ]);

      // Only the eligible file is ever downloaded.
      expect(mocks.getBlob).toHaveBeenCalledTimes(1);
    });

    it("never downloads sensitive files, dependency directories or binaries", async () => {
      mocks.getTree.mockResolvedValue(
        tree([
          entry(".env", BLOB_A, 10),
          entry(".env.production", BLOB_B, 10),
          entry("deploy/server.pem", "1".repeat(40), 10),
          entry("node_modules/x/index.js", "2".repeat(40), 10),
          entry("images/photo.jpg", "3".repeat(40), 10),
        ]),
      );
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("FAILED"));

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "NO_USABLE_SOURCE_FILES" });

      expect(mocks.getBlob).not.toHaveBeenCalled();
      expect(storage.put).not.toHaveBeenCalled();
    });

    it("skips oversized files with a recorded reason and does not download them", async () => {
      mocks.getTree.mockResolvedValue(
        tree([
          entry("src/a.ts", BLOB_A, 10),
          entry("src/huge.ts", BLOB_B, 5 * 1024 * 1024),
        ]),
      );

      await ingestRepositorySnapshot(request, { storage });

      const { files } = mocks.persistInventory.mock.calls[0][0];
      const huge = files.find(
        (file: { path: string }) => file.path === "src/huge.ts",
      );

      expect(huge.status).toBe("SKIPPED");
      expect(huge.reason).toBe("FILE_TOO_LARGE");
      expect(mocks.getBlob).toHaveBeenCalledTimes(1);
    });
  });

  describe("empty and excluded-only repositories", () => {
    it("fails an empty repository with a clear error and fails the job", async () => {
      mocks.getTree.mockResolvedValue(tree([]));
      mocks.finalizeSnapshot.mockResolvedValue({
        ...finalResult("FAILED"),
        summary: {
          totalFiles: 0,
          eligibleFiles: 0,
          storedFiles: 0,
          skippedFiles: 0,
          failedFiles: 0,
          totalBytes: BigInt(0),
        },
      });

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "NO_USABLE_SOURCE_FILES" });

      expect(mocks.markSnapshotFailed).toHaveBeenCalledWith("snapshot-1");
      expect(mocks.failJob).toHaveBeenCalledWith(
        request.jobId,
        "NO_USABLE_SOURCE_FILES",
        expect.any(String),
      );
      expect(mocks.completeJob).not.toHaveBeenCalled();
    });
  });

  describe("truncated trees and commit pinning", () => {
    it("fails the job when the tree cannot be retrieved completely", async () => {
      mocks.getTree.mockRejectedValue(
        new GitHubApiError("Tree truncated", "INVALID_RESPONSE", 200, false),
      );

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toBeInstanceOf(SnapshotIngestionError);

      expect(mocks.persistInventory).not.toHaveBeenCalled();
      expect(mocks.completeJob).not.toHaveBeenCalled();
      expect(mocks.failJob).toHaveBeenCalledOnce();
    });

    it("rejects a tree that belongs to a different commit", async () => {
      mocks.getTree.mockResolvedValue({
        ...tree([entry("src/a.ts", BLOB_A, 10)]),
        commitSha: "9".repeat(40),
      });

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "TREE_INCOMPLETE" });

      expect(mocks.getBlob).not.toHaveBeenCalled();
    });

    it("retrieves the tree for the exact resolved commit, not the branch name", async () => {
      await ingestRepositorySnapshot(
        { ...request, revision: "main" },
        { storage },
      );

      expect(mocks.getTree).toHaveBeenCalledWith(
        request.owner,
        request.repositoryName,
        commit,
      );
      expect(mocks.claimSnapshot).toHaveBeenCalledWith({
        repositoryId: request.repositoryId,
        commit,
      });
    });
  });

  describe("GitHub failures", () => {
    it("records a missing blob as a failed file and keeps a PARTIAL result", async () => {
      mocks.getTree.mockResolvedValue(
        tree([entry("src/a.ts", BLOB_A, 10), entry("src/b.ts", BLOB_B, 10)]),
      );
      mocks.getBlob.mockImplementation(
        async (_o: string, _r: string, sha: string) => {
          if (sha === BLOB_B) {
            throw new GitHubApiError("Not found", "NOT_FOUND", 404, false);
          }

          return { sha, sizeBytes: 10, content: bytes(10) };
        },
      );
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("PARTIAL", 1));

      const result = await ingestRepositorySnapshot(request, { storage });

      expect(result.completeness).toBe("PARTIAL");
      expect(mocks.markFileFailed).toHaveBeenCalledWith({
        snapshotId: "snapshot-1",
        path: "src/b.ts",
        failureCode: "NOT_FOUND",
      });
      expect(mocks.completeJob).toHaveBeenCalledWith(
        request.jobId,
        "PARTIALLY_INDEXED",
      );
    });

    it("treats a blob whose SHA differs from the tree as a failed file", async () => {
      mocks.getBlob.mockResolvedValue({
        sha: "9".repeat(40),
        sizeBytes: 10,
        content: bytes(10),
      });
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("FAILED"));

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "NO_USABLE_SOURCE_FILES" });

      expect(storage.put).not.toHaveBeenCalled();
      expect(mocks.markFileFailed).toHaveBeenCalledOnce();
    });

    it("treats a blob whose size differs from the tree as a failed file", async () => {
      mocks.getBlob.mockResolvedValue({
        sha: BLOB_A,
        sizeBytes: 11,
        content: bytes(11),
      });
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("FAILED"));

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "NO_USABLE_SOURCE_FILES" });

      expect(storage.put).not.toHaveBeenCalled();
    });

    it("surfaces a GitHub rate limit as a retryable job failure without failing files", async () => {
      mocks.getBlob.mockRejectedValue(
        new GitHubApiError("Rate limit", "RATE_LIMITED", 403, true, 60),
      );

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ retryable: true });

      expect(mocks.markFileFailed).not.toHaveBeenCalled();
      expect(mocks.failJob).toHaveBeenCalledOnce();
    });
  });

  describe("filesystem and database failures", () => {
    it("records a failed file when the storage write fails and stores no metadata", async () => {
      (storage.put as ReturnType<typeof vi.fn>).mockRejectedValue(
        new StorageError("disk full", "STORAGE_WRITE_FAILED", true),
      );
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("FAILED"));

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "NO_USABLE_SOURCE_FILES" });

      expect(mocks.markFileStored).not.toHaveBeenCalled();
      expect(mocks.markFileFailed).toHaveBeenCalledWith(
        expect.objectContaining({ failureCode: "FILE_INGESTION_FAILED" }),
      );
    });

    it("deletes the stored object when the database update fails (no orphan)", async () => {
      mocks.markFileStored.mockRejectedValue(
        new SnapshotIngestionError(
          "db down",
          "SNAPSHOT_PERSISTENCE_FAILED",
          true,
        ),
      );
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("FAILED"));

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toBeInstanceOf(SnapshotIngestionError);

      expect(storage.delete).toHaveBeenCalledWith("objects/10");
    });

    it("fails the job when the inventory cannot be saved", async () => {
      mocks.persistInventory.mockRejectedValue(
        new SnapshotIngestionError(
          "db down",
          "SNAPSHOT_PERSISTENCE_FAILED",
          true,
        ),
      );

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "SNAPSHOT_PERSISTENCE_FAILED" });

      expect(mocks.getBlob).not.toHaveBeenCalled();
      expect(mocks.markSnapshotFailed).toHaveBeenCalledWith("snapshot-1");
      expect(mocks.failJob).toHaveBeenCalledOnce();
    });

    it("reports a storage cleanup failure so orphaned objects are not silent", async () => {
      mocks.markFileStored.mockRejectedValue(new Error("db down"));
      (storage.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
        new StorageError("cannot delete", "STORAGE_DELETE_FAILED", true),
      );

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "STORAGE_CLEANUP_FAILED" });
    });
  });

  describe("duplicate and concurrent ingestion", () => {
    it("rejects a concurrent claim without touching the other worker's snapshot", async () => {
      mocks.claimSnapshot.mockRejectedValue(
        new SnapshotIngestionError(
          "already processing",
          "SNAPSHOT_ALREADY_PROCESSING",
          true,
        ),
      );

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({
        code: "SNAPSHOT_ALREADY_PROCESSING",
        retryable: true,
      });

      expect(mocks.markSnapshotFailed).not.toHaveBeenCalled();
      expect(mocks.getBlob).not.toHaveBeenCalled();
      expect(mocks.failJob).toHaveBeenCalledWith(
        request.jobId,
        "SNAPSHOT_ALREADY_PROCESSING",
        expect.any(String),
      );
    });

    it("reuses a complete snapshot for the same commit without any download", async () => {
      mocks.claimSnapshot.mockResolvedValue({
        kind: "COMPLETED",
        snapshotId: "snapshot-1",
      });
      mocks.findSnapshot.mockResolvedValue({
        id: "snapshot-1",
        completeness: "COMPLETE",
        totalFiles: 1,
        eligibleFiles: 1,
        storedFiles: 1,
        skippedFiles: 0,
        failedFiles: 0,
        totalBytes: BigInt(10),
      });

      const result = await ingestRepositorySnapshot(request, { storage });

      expect(result.snapshotId).toBe("snapshot-1");
      expect(mocks.getTree).not.toHaveBeenCalled();
      expect(mocks.getBlob).not.toHaveBeenCalled();
      expect(mocks.beginRetry).not.toHaveBeenCalled();
      expect(mocks.completeJob).toHaveBeenCalledWith(request.jobId, "INDEXED");
    });
  });

  describe("retrying failed files", () => {
    const partialExisting = {
      id: "snapshot-1",
      completeness: "PARTIAL",
      totalFiles: 2,
      eligibleFiles: 2,
      storedFiles: 1,
      skippedFiles: 0,
      failedFiles: 1,
      totalBytes: BigInt(10),
    };

    beforeEach(() => {
      mocks.claimSnapshot.mockResolvedValue({
        kind: "COMPLETED",
        snapshotId: "snapshot-1",
      });
      mocks.findSnapshot.mockResolvedValue(partialExisting);
      mocks.beginRetry.mockResolvedValue([
        {
          path: "src/b.ts",
          name: "b.ts",
          extension: ".ts",
          category: "SOURCE",
          gitBlobSha: BLOB_B,
          sizeBytes: 10,
        },
      ]);
    });

    it("downloads and stores only the failed file", async () => {
      const result = await ingestRepositorySnapshot(request, { storage });

      expect(mocks.beginRetry).toHaveBeenCalledWith("snapshot-1");
      expect(mocks.getBlob).toHaveBeenCalledTimes(1);
      expect(mocks.getBlob).toHaveBeenCalledWith(
        request.owner,
        request.repositoryName,
        BLOB_B,
      );
      expect(storage.put).toHaveBeenCalledTimes(1);
      expect(mocks.markFileStored).toHaveBeenCalledTimes(1);
      expect(mocks.markFileStored).toHaveBeenCalledWith(
        expect.objectContaining({ path: "src/b.ts" }),
      );

      // Already-stored files are never re-fetched, and the tree is not
      // re-read, so nothing is duplicated.
      expect(mocks.getTree).not.toHaveBeenCalled();
      expect(mocks.persistInventory).not.toHaveBeenCalled();
      expect(mocks.clearFiles).not.toHaveBeenCalled();

      expect(result.completeness).toBe("COMPLETE");
      expect(mocks.completeJob).toHaveBeenCalledWith(request.jobId, "INDEXED");
      expect(mocks.markSnapshotFailed).not.toHaveBeenCalled();
    });

    it("stays PARTIAL when the file fails again", async () => {
      mocks.getBlob.mockRejectedValue(
        new GitHubApiError("Not found", "NOT_FOUND", 404, false),
      );
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("PARTIAL", 1));

      const result = await ingestRepositorySnapshot(request, { storage });

      expect(result.completeness).toBe("PARTIAL");
      expect(mocks.markFileFailed).toHaveBeenCalledOnce();
      expect(mocks.completeJob).toHaveBeenCalledWith(
        request.jobId,
        "PARTIALLY_INDEXED",
      );
    });

    it("restores the snapshot instead of failing it when rate limited", async () => {
      mocks.getBlob.mockRejectedValue(
        new GitHubApiError("Rate limit", "RATE_LIMITED", 403, true, 60),
      );
      mocks.finalizeSnapshot.mockResolvedValue(finalResult("PARTIAL", 1));

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ retryable: true });

      expect(mocks.finalizeSnapshot).toHaveBeenCalledWith("snapshot-1");
      expect(mocks.markSnapshotFailed).not.toHaveBeenCalled();
      expect(storage.delete).not.toHaveBeenCalled();
      expect(mocks.failJob).toHaveBeenCalledOnce();
    });

    it("rejects the retry when another worker already owns the snapshot", async () => {
      mocks.beginRetry.mockRejectedValue(
        new SnapshotIngestionError(
          "already processing",
          "SNAPSHOT_ALREADY_PROCESSING",
          true,
        ),
      );

      await expect(
        ingestRepositorySnapshot(request, { storage }),
      ).rejects.toMatchObject({ code: "SNAPSHOT_ALREADY_PROCESSING" });

      expect(mocks.getBlob).not.toHaveBeenCalled();
      // The other worker's in-progress snapshot must not be marked failed.
      expect(mocks.markSnapshotFailed).not.toHaveBeenCalled();
    });
  });
});
