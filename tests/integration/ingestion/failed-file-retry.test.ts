// tests/integration/ingestion/failed-file-retry.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env" });

import { prisma } from "@/lib/db/prisma";
import type { GitHubCommitReference } from "@/lib/github/github.type";
import {
  beginFailedFileRetry,
  claimSnapshotForIngestion,
  finalizeSnapshot,
  markSnapshotFileFailed,
  markSnapshotFileStored,
  persistSnapshotInventory,
  startSnapshotIngestion,
} from "@/lib/ingestion/snapshot/snapshot.repository";

describe("Failed-file retry integration tests", () => {
  const testRunId = randomUUID();

  let userId: string;
  let repositoryId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing. Check your .env file.");
    }

    const user = await prisma.user.create({
      data: {
        email: `file-retry-${testRunId}@example.test`,
        name: "File Retry Test User",
      },
    });

    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        ownerId: userId,
        provider: "github",
        externalId: `file-retry-${testRunId}`,
        ownerLogin: "test-owner",
        name: "file-retry-test",
        fullName: `test-owner/file-retry-${testRunId}`,
        htmlUrl: "https://github.com/test-owner/file-retry-test",
        visibility: "PUBLIC",
        status: "QUEUED",
      },
    });

    repositoryId = repository.id;
  });

  afterAll(async () => {
    try {
      if (userId) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function createPartialSnapshot() {
    const commit: GitHubCommitReference = {
      sha: randomUUID().replace(/-/g, "").padEnd(40, "0"),
      treeSha: "b".repeat(40),
      message: "Retry integration test",
      authorName: "Test Author",
      committedAt: "2026-01-01T12:00:00.000Z",
    };

    const claim = await claimSnapshotForIngestion({ repositoryId, commit });

    if (claim.kind !== "CLAIMED") {
      throw new Error("Expected a newly claimed snapshot.");
    }

    const snapshotId = claim.snapshotId;

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
      ],
    });

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

    expect(result.completeness).toBe("PARTIAL");

    return snapshotId;
  }

  it("reopens a PARTIAL snapshot and returns only the failed file", async () => {
    const snapshotId = await createPartialSnapshot();

    const files = await beginFailedFileRetry(snapshotId);

    expect(files).toEqual([
      expect.objectContaining({
        path: "src/utils.ts",
        gitBlobSha: "d".repeat(40),
        sizeBytes: 200,
      }),
    ]);

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("INGESTING");
    expect(snapshot.failedFiles).toBe(0);
    expect(snapshot.storedFiles).toBe(1);
  });

  it("leaves stored files untouched", async () => {
    const snapshotId = await createPartialSnapshot();

    const before = await prisma.snapshotFile.findUniqueOrThrow({
      where: { snapshotId_path: { snapshotId, path: "src/index.ts" } },
    });

    await beginFailedFileRetry(snapshotId);

    const after = await prisma.snapshotFile.findUniqueOrThrow({
      where: { snapshotId_path: { snapshotId, path: "src/index.ts" } },
    });

    expect(after.status).toBe("STORED");
    expect(after.storageKey).toBe(before.storageKey);
    expect(after.contentHash).toBe(before.contentHash);
  });

  it("completes the snapshot without duplicating files after a successful retry", async () => {
    const snapshotId = await createPartialSnapshot();

    await beginFailedFileRetry(snapshotId);

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
    expect(result.summary.failedFiles).toBe(0);
    expect(result.summary.totalBytes).toBe(BigInt(300));

    const fileCount = await prisma.snapshotFile.count({
      where: { snapshotId },
    });

    expect(fileCount).toBe(2);
  });

  it("returns to PARTIAL when the retried file fails again", async () => {
    const snapshotId = await createPartialSnapshot();

    await beginFailedFileRetry(snapshotId);

    await markSnapshotFileFailed({
      snapshotId,
      path: "src/utils.ts",
      failureCode: "NOT_FOUND",
    });

    const result = await finalizeSnapshot(snapshotId);

    expect(result.completeness).toBe("PARTIAL");
    expect(result.summary.failedFiles).toBe(1);
    expect(result.summary.storedFiles).toBe(1);
  });

  it("allows only one concurrent retry of the same snapshot", async () => {
    const snapshotId = await createPartialSnapshot();

    const results = await Promise.allSettled([
      beginFailedFileRetry(snapshotId),
      beginFailedFileRetry(snapshotId),
      beginFailedFileRetry(snapshotId),
    ]);

    const fulfilled = results.filter(
      (result) => result.status === "fulfilled" && result.value !== null,
    );
    const rejected = results.filter(
      (result) =>
        result.status === "rejected" &&
        (result.reason as { code?: string }).code ===
          "SNAPSHOT_ALREADY_PROCESSING",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });

  it("does not reopen a COMPLETE snapshot", async () => {
    const snapshotId = await createPartialSnapshot();

    await beginFailedFileRetry(snapshotId);

    await markSnapshotFileStored({
      snapshotId,
      path: "src/utils.ts",
      contentHash: "a".repeat(64),
      storageKey: randomUUID(),
      sizeBytes: 200,
    });

    await finalizeSnapshot(snapshotId);

    const files = await beginFailedFileRetry(snapshotId);

    expect(files).toBeNull();

    const snapshot = await prisma.repositorySnapshot.findUniqueOrThrow({
      where: { id: snapshotId },
    });

    expect(snapshot.status).toBe("COMPLETED");
    expect(snapshot.completeness).toBe("COMPLETE");
  });
});
