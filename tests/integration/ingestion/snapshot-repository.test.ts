import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env" });

import { prisma } from "@/lib/db/prisma";
import type { GitHubCommitReference } from "@/lib/github/github.type";
import {
  claimSnapshotForIngestion,
  startSnapshotIngestion,
  persistSnapshotInventory,
  markSnapshotFileStored,
  markSnapshotFileFailed,
  finalizeSnapshot,
  markSnapshotFailed,
  getSnapshotStorageKeys,
  clearSnapshotFiles,
  completeSnapshotRecovery,
} from "@/lib/ingestion/snapshot/snapshot.repository";

describe("Snapshot repository integration tests", () => {
  const testRunId = randomUUID();

  let userId: string;
  let repositoryId: string;

  const commit: GitHubCommitReference = {
    sha: "a".repeat(40),
    treeSha: "b".repeat(40),
    message: "Snapshot integration test",
    authorName: "Test Author",
    committedAt: "2026-01-01T12:00:00.000Z",
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing. Check your .env file.");
    }

    const user = await prisma.user.create({
      data: {
        email: `snapshot-${testRunId}@example.test`,
        name: "Snapshot Test User",
      },
    });

    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        ownerId: userId,
        provider: "github",
        externalId: `snapshot-${testRunId}`,
        ownerLogin: "test-owner",
        name: "snapshot-test",
        fullName: `test-owner/snapshot-${testRunId}`,
        htmlUrl: "https://github.com/test-owner/snapshot-test",
        visibility: "PUBLIC",
        status: "QUEUED",
      },
    });

    repositoryId = repository.id;
  });

  afterAll(async () => {
    try {
      if (userId) {
        await prisma.user.deleteMany({
          where: { id: userId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function claimNewSnapshot() {
    const result = await claimSnapshotForIngestion({
      repositoryId,
      commit: {
        ...commit,
        sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
      },
    });

    expect(result.kind).toBe("CLAIMED");

    if (result.kind !== "CLAIMED") {
      throw new Error("Expected a newly claimed snapshot.");
    }

    return result.snapshotId;
  }

  async function createInventory(snapshotId: string) {
    await startSnapshotIngestion(snapshotId);

    await persistSnapshotInventory({
      snapshotId,
      files: [
        {
          path: "src/index.ts",
          name: "index.ts",
          extension: ".ts",
          status: "ELIGIBLE",
          category: "SOURCE",
          reason: null,
          gitBlobSha: "c".repeat(40),
          sizeBytes: 100,
        },
        {
          path: "src/utils.ts",
          name: "utils.ts",
          extension: ".ts",
          status: "ELIGIBLE",
          category: "SOURCE",
          reason: null,
          gitBlobSha: "d".repeat(40),
          sizeBytes: 200,
        },
        {
          path: "README.md",
          name: "README.md",
          extension: ".md",
          status: "SKIPPED",
          category: null,
          reason: "UNSUPPORTED_FILE_TYPE",
          gitBlobSha: "e".repeat(40),
          sizeBytes: 50,
        },
      ],
    });
  }

  it("creates a snapshot for a repository commit", async () => {
    const snapshotId = await claimNewSnapshot();

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("DISCOVERING");
    expect(snapshot.commitSha).toHaveLength(40);
  });

  it("rejects a duplicate claim while a snapshot is processing", async () => {
    const first = await claimSnapshotForIngestion({
      repositoryId,
      commit,
    });

    expect(first.kind).toBe("CLAIMED");

    await expect(
      claimSnapshotForIngestion({
        repositoryId,
        commit,
      }),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_ALREADY_PROCESSING",
    });
  });

  it("persists inventory and calculates initial counters", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("INGESTING");
    expect(snapshot.totalFiles).toBe(3);
    expect(snapshot.eligibleFiles).toBe(2);
    expect(snapshot.skippedFiles).toBe(1);
  });

  it("marks a file as stored and updates counters", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.storedFiles).toBe(1);
    expect(snapshot.totalBytes).toBe(BigInt(100));

    const file = await prisma.snapshotFile.findUniqueOrThrow({
      where: {
        snapshotId_path: {
          snapshotId,
          path: "src/index.ts",
        },
      },
    });

    expect(file.status).toBe("STORED");
    expect(file.contentHash).toBe("f".repeat(64));
  });

  it("rejects storing the same file twice without incrementing counters", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    const input = {
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    };

    await markSnapshotFileStored(input);

    await expect(markSnapshotFileStored(input)).rejects.toMatchObject({
      code: "SNAPSHOT_CONFLICT",
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.storedFiles).toBe(1);
    expect(snapshot.totalBytes).toBe(BigInt(100));
  });

  it("marks an eligible file as failed", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileFailed({
      snapshotId,
      path: "src/index.ts",
      failureCode: "BLOB_RETRIEVAL_FAILED",
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.failedFiles).toBe(1);

    const file = await prisma.snapshotFile.findUniqueOrThrow({
      where: {
        snapshotId_path: {
          snapshotId,
          path: "src/index.ts",
        },
      },
    });

    expect(file.status).toBe("FAILED");
    expect(file.failureCode).toBe("BLOB_RETRIEVAL_FAILED");
  });

  it("finalises a complete snapshot", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    await markSnapshotFileStored({
      snapshotId,
      path: "src/utils.ts",
      contentHash: "a".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 200,
    });

    const result = await finalizeSnapshot(snapshotId);

    expect(result.status).toBe("COMPLETED");
    expect(result.completeness).toBe("COMPLETE");
    expect(result.summary.storedFiles).toBe(2);
    expect(result.summary.totalBytes).toBe(BigInt(300));
  });

  it("finalises a usable but incomplete snapshot as PARTIAL", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    await markSnapshotFileFailed({
      snapshotId,
      path: "src/utils.ts",
      failureCode: "BLOB_RETRIEVAL_FAILED",
    });

    const result = await finalizeSnapshot(snapshotId);

    expect(result.status).toBe("COMPLETED");
    expect(result.completeness).toBe("PARTIAL");
    expect(result.summary.storedFiles).toBe(1);
    expect(result.summary.failedFiles).toBe(1);
  });

  it("does not mark a snapshot complete while eligible files remain unprocessed", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    // src/utils.ts remains ELIGIBLE and has not been processed.

    const result = await finalizeSnapshot(snapshotId);

    expect(result.status).toBe("COMPLETED");
    expect(result.completeness).toBe("PARTIAL");
    expect(result.summary.storedFiles).toBe(1);
    expect(result.summary.eligibleFiles).toBe(2);

    const remainingFile = await prisma.snapshotFile.findUniqueOrThrow({
      where: {
        snapshotId_path: {
          snapshotId,
          path: "src/utils.ts",
        },
      },
    });

    expect(remainingFile.status).toBe("ELIGIBLE");
  });

  it("fails a snapshot with no successfully stored source files", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileFailed({
      snapshotId,
      path: "src/index.ts",
      failureCode: "BLOB_RETRIEVAL_FAILED",
    });

    await markSnapshotFileFailed({
      snapshotId,
      path: "src/utils.ts",
      failureCode: "BLOB_RETRIEVAL_FAILED",
    });

    const result = await finalizeSnapshot(snapshotId);

    expect(result.status).toBe("FAILED");
    expect(result.completeness).toBe("FAILED");
  });

  it("does not treat ordinary policy exclusions as incomplete", async () => {
    const snapshotId = await claimNewSnapshot();

    await startSnapshotIngestion(snapshotId);

    await persistSnapshotInventory({
      snapshotId,
      files: [
        {
          path: "src/index.ts",
          name: "index.ts",
          extension: ".ts",
          status: "ELIGIBLE",
          category: "SOURCE",
          reason: null,
          gitBlobSha: "c".repeat(40),
          sizeBytes: 100,
        },
        {
          path: "node_modules/example/index.js",
          name: "index.js",
          extension: ".js",
          status: "SKIPPED",
          category: null,
          reason: "DEPENDENCY_DIRECTORY",
          gitBlobSha: "d".repeat(40),
          sizeBytes: 50,
        },
      ],
    });

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    const result = await finalizeSnapshot(snapshotId);

    expect(result.status).toBe("COMPLETED");
    expect(result.completeness).toBe("COMPLETE");
  });

  it("reclaims a failed snapshot without creating a duplicate", async () => {
    const testCommit = {
      ...commit,
      sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    };

    const firstClaim = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    expect(firstClaim.kind).toBe("CLAIMED");

    if (firstClaim.kind !== "CLAIMED") {
      throw new Error("Expected a claimed snapshot.");
    }

    const snapshotId = firstClaim.snapshotId;

    await startSnapshotIngestion(snapshotId);

    await persistSnapshotInventory({
      snapshotId,
      files: [
        {
          path: "src/index.ts",
          name: "index.ts",
          extension: ".ts",
          status: "ELIGIBLE",
          category: "SOURCE",
          reason: null,
          gitBlobSha: "c".repeat(40),
          sizeBytes: 100,
        },
      ],
    });

    const storageKey = randomUUID();

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey,
      sizeBytes: 100,
    });

    await markSnapshotFailed(snapshotId);

    const reclaimed = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    expect(reclaimed).toEqual({
      kind: "RECOVERY_REQUIRED",
      snapshotId,
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("RECOVERING");
    expect(snapshot.completeness).toBeNull();

    // Cleanup is deliberately performed by the orchestration layer,
    // not by claimSnapshotForIngestion.
    const storageKeys = await getSnapshotStorageKeys(snapshotId);

    expect(storageKeys).toContain(storageKey);

    const existingFile = await prisma.snapshotFile.findUnique({
      where: {
        snapshotId_path: {
          snapshotId,
          path: "src/index.ts",
        },
      },
    });

    expect(existingFile).not.toBeNull();
  });

  it("does not reclaim a completed snapshot", async () => {
    const testCommit = {
      ...commit,
      sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    };

    const firstClaim = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    if (firstClaim.kind !== "CLAIMED") {
      throw new Error("Expected a claimed snapshot.");
    }

    const snapshotId = firstClaim.snapshotId;

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    await markSnapshotFileStored({
      snapshotId,
      path: "src/utils.ts",
      contentHash: "a".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 200,
    });

    await finalizeSnapshot(snapshotId);

    const reclaimed = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    expect(reclaimed).toEqual({
      kind: "COMPLETED",
      snapshotId,
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("COMPLETED");
    expect(snapshot.completeness).toBe("COMPLETE");
    expect(snapshot.storedFiles).toBe(2);
  });

  it("allows only one concurrent claim for the same repository commit", async () => {
    const testCommit = {
      ...commit,
      sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    };

    const results = await Promise.allSettled([
      claimSnapshotForIngestion({
        repositoryId,
        commit: testCommit,
      }),
      claimSnapshotForIngestion({
        repositoryId,
        commit: testCommit,
      }),
    ]);

    const successful = results.filter(
      (result) => result.status === "fulfilled",
    );

    const rejected = results.filter((result) => result.status === "rejected");

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const claimed = successful[0];

    if (claimed.status !== "fulfilled" || claimed.value.kind !== "CLAIMED") {
      throw new Error("Expected exactly one successful snapshot claim.");
    }

    const snapshots = await prisma.repositorySnapshot.findMany({
      where: {
        repositoryId,
        commitSha: testCommit.sha,
      },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe(claimed.value.snapshotId);
    expect(snapshots[0].status).toBe("DISCOVERING");
  });

  it("rejects starting a snapshot that is already ingesting", async () => {
    const snapshotId = await claimNewSnapshot();

    await startSnapshotIngestion(snapshotId);

    await expect(startSnapshotIngestion(snapshotId)).rejects.toMatchObject({
      code: "SNAPSHOT_CONFLICT",
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("INGESTING");
  });

  it("rejects finalising a snapshot more than once", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    await markSnapshotFileStored({
      snapshotId,
      path: "src/utils.ts",
      contentHash: "a".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 200,
    });

    const firstResult = await finalizeSnapshot(snapshotId);

    expect(firstResult.completeness).toBe("COMPLETE");

    await expect(finalizeSnapshot(snapshotId)).rejects.toMatchObject({
      code: "SNAPSHOT_CONFLICT",
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("COMPLETED");
    expect(snapshot.storedFiles).toBe(2);
  });

  it("does not modify a completed snapshot when marked as failed", async () => {
    const snapshotId = await claimNewSnapshot();

    await createInventory(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/index.ts",
      contentHash: "f".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 100,
    });

    await markSnapshotFileStored({
      snapshotId,
      path: "src/utils.ts",
      contentHash: "a".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 200,
    });

    await finalizeSnapshot(snapshotId);

    const before = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    await markSnapshotFailed(snapshotId);

    const after = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(after.status).toBe("COMPLETED");
    expect(after.completeness).toBe("COMPLETE");
    expect(after.storedFiles).toBe(before.storedFiles);
    expect(after.completedAt).toEqual(before.completedAt);
  });
  it("rejects a second claim while snapshot recovery is underway", async () => {
    const testCommit = {
      ...commit,
      sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    };

    const first = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    if (first.kind !== "CLAIMED") {
      throw new Error("Expected a claimed snapshot.");
    }

    await markSnapshotFailed(first.snapshotId);

    const recovery = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    expect(recovery).toEqual({
      kind: "RECOVERY_REQUIRED",
      snapshotId: first.snapshotId,
    });

    await expect(
      claimSnapshotForIngestion({
        repositoryId,
        commit: testCommit,
      }),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_ALREADY_PROCESSING",
    });
  });

  it("only completes recovery after old metadata is cleared", async () => {
    const testCommit = {
      ...commit,
      sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
    };

    const first = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    if (first.kind !== "CLAIMED") {
      throw new Error("Expected a claimed snapshot.");
    }

    await startSnapshotIngestion(first.snapshotId);

    await persistSnapshotInventory({
      snapshotId: first.snapshotId,
      files: [
        {
          path: "src/index.ts",
          name: "index.ts",
          extension: ".ts",
          status: "ELIGIBLE",
          category: "SOURCE",
          reason: null,
          gitBlobSha: "c".repeat(40),
          sizeBytes: 100,
        },
      ],
    });

    await markSnapshotFailed(first.snapshotId);

    const recovery = await claimSnapshotForIngestion({
      repositoryId,
      commit: testCommit,
    });

    expect(recovery.kind).toBe("RECOVERY_REQUIRED");

    await expect(
      completeSnapshotRecovery(first.snapshotId),
    ).rejects.toMatchObject({
      code: "SNAPSHOT_CONFLICT",
    });

    await clearSnapshotFiles(first.snapshotId);
    await completeSnapshotRecovery(first.snapshotId);

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: first.snapshotId },
    });

    expect(snapshot.status).toBe("DISCOVERING");

    const files = await prisma.snapshotFile.findMany({
      where: { snapshotId: first.snapshotId },
    });

    expect(files).toHaveLength(0);
  });

  it("does not allow file metadata cleanup outside recovery", async () => {
    const snapshotId = await claimNewSnapshot();

    await expect(clearSnapshotFiles(snapshotId)).rejects.toMatchObject({
      code: "SNAPSHOT_CONFLICT",
    });

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("DISCOVERING");
  });
});
