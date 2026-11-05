// tests/unit/ingestion/source-content/source-content.service.test.ts
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repositoryFindFirst: vi.fn(),
  snapshotFindFirst: vi.fn(),
  snapshotFindMany: vi.fn(),
  fileFindUnique: vi.fn(),
  fileFindMany: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.repositoryFindFirst },
    repositorySnapshot: {
      findFirst: mocks.snapshotFindFirst,
      findMany: mocks.snapshotFindMany,
    },
    snapshotFile: {
      findUnique: mocks.fileFindUnique,
      findMany: mocks.fileFindMany,
    },
  },
}));

import { LocalStorageAdapter } from "@/lib/ingestion/storage/local-storage.adapter";
import {
  SourceContentError,
  listRepositorySnapshots,
  listSnapshotFiles,
  readSnapshotFileContent,
} from "@/lib/ingestion/source-content/source-content.service";

const input = {
  userId: "user-1",
  repositoryId: "repo-1",
  snapshotId: "snap-1",
  path: "src/index.ts",
};

describe("source content service", () => {
  let root: string;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(path.join(tmpdir(), "cd-source-content-"));
    storage = new LocalStorageAdapter(root);

    mocks.repositoryFindFirst.mockResolvedValue({ id: "repo-1" });
    mocks.snapshotFindFirst.mockResolvedValue({
      id: "snap-1",
      status: "COMPLETED",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function storeFile(content: string) {
    const stored = await storage.put(Buffer.from(content));

    mocks.fileFindUnique.mockResolvedValue({
      path: "src/index.ts",
      status: "STORED",
      storageKey: stored.storageKey,
      contentHash: stored.contentHash,
      sizeBytes: BigInt(stored.sizeBytes),
    });

    return stored;
  }

  it("returns verified content for the owner", async () => {
    const stored = await storeFile("export const answer = 42;\n");

    const result = await readSnapshotFileContent(input, storage);

    expect(result.content.toString()).toBe("export const answer = 42;\n");
    expect(result.contentHash).toBe(stored.contentHash);
    expect(result.path).toBe("src/index.ts");
  });

  it("scopes the snapshot lookup to the owner", async () => {
    await storeFile("x");

    await readSnapshotFileContent(input, storage);

    expect(mocks.snapshotFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "snap-1",
          repositoryId: "repo-1",
          repository: { ownerId: "user-1" },
        },
      }),
    );
  });

  it("treats another user's snapshot as not found and never reads storage", async () => {
    mocks.snapshotFindFirst.mockResolvedValue(null);
    const getSpy = vi.spyOn(storage, "get");

    await expect(
      readSnapshotFileContent({ ...input, userId: "intruder" }, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.fileFindUnique).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it.each([
    "../../etc/passwd",
    "/etc/passwd",
    "src/../../secret",
    "src\\..\\secret",
    "C:\\Windows\\system32",
    "",
    "src//index.ts",
    "src/\u0000index.ts",
  ])(
    "rejects unsafe path %j before any database or storage access",
    async (unsafe) => {
      await expect(
        readSnapshotFileContent({ ...input, path: unsafe }, storage),
      ).rejects.toMatchObject({ code: "INVALID_PATH" });

      expect(mocks.snapshotFindFirst).not.toHaveBeenCalled();
      expect(mocks.fileFindUnique).not.toHaveBeenCalled();
    },
  );

  it.each(["PENDING", "DISCOVERING", "INGESTING", "FAILED", "RECOVERING"])(
    "does not serve content from a %s snapshot",
    async (status) => {
      mocks.snapshotFindFirst.mockResolvedValue({ id: "snap-1", status });

      await expect(
        readSnapshotFileContent(input, storage),
      ).rejects.toMatchObject({ code: "SNAPSHOT_NOT_READY" });
    },
  );

  it.each(["SKIPPED", "FAILED", "ELIGIBLE", "DISCOVERED"])(
    "does not serve a file whose status is %s",
    async (status) => {
      mocks.fileFindUnique.mockResolvedValue({
        path: "src/index.ts",
        status,
        storageKey: null,
        contentHash: null,
        sizeBytes: null,
      });

      await expect(
        readSnapshotFileContent(input, storage),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    },
  );

  it("returns not found for an unknown path", async () => {
    mocks.fileFindUnique.mockResolvedValue(null);

    await expect(readSnapshotFileContent(input, storage)).rejects.toMatchObject(
      { code: "NOT_FOUND" },
    );
  });

  it("reports incomplete stored metadata as unavailable", async () => {
    mocks.fileFindUnique.mockResolvedValue({
      path: "src/index.ts",
      status: "STORED",
      storageKey: null,
      contentHash: null,
      sizeBytes: BigInt(1),
    });

    await expect(readSnapshotFileContent(input, storage)).rejects.toMatchObject(
      { code: "CONTENT_UNAVAILABLE" },
    );
  });

  it("reports a missing storage object as unavailable", async () => {
    const stored = await storeFile("content");

    await unlink(path.join(root, "objects", stored.storageKey));

    await expect(readSnapshotFileContent(input, storage)).rejects.toMatchObject(
      { code: "CONTENT_UNAVAILABLE" },
    );
  });

  it("detects a hash mismatch from tampered storage and returns no content", async () => {
    const stored = await storeFile("original content");

    await writeFile(
      path.join(root, "objects", stored.storageKey),
      "tampered content",
    );

    const error = await readSnapshotFileContent(input, storage).catch(
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(SourceContentError);
    expect(error.code).toBe("INTEGRITY_FAILURE");
    expect(error.message).not.toContain("tampered");
  });

  it("detects a database hash that does not match the stored object", async () => {
    const stored = await storeFile("content");

    mocks.fileFindUnique.mockResolvedValue({
      path: "src/index.ts",
      status: "STORED",
      storageKey: stored.storageKey,
      contentHash: "0".repeat(64),
      sizeBytes: BigInt(stored.sizeBytes),
    });

    await expect(readSnapshotFileContent(input, storage)).rejects.toMatchObject(
      { code: "INTEGRITY_FAILURE" },
    );
  });

  it("never exposes storage keys in file listings", async () => {
    mocks.fileFindMany.mockResolvedValue([
      {
        path: "src/index.ts",
        name: "index.ts",
        extension: ".ts",
        category: "SOURCE",
        status: "STORED",
        sizeBytes: BigInt(25),
        skipReason: null,
        failureCode: null,
      },
    ]);

    const files = await listSnapshotFiles("user-1", "repo-1", "snap-1");

    expect(files).toEqual([
      expect.objectContaining({ path: "src/index.ts", sizeBytes: "25" }),
    ]);
    expect(JSON.stringify(files)).not.toContain("storageKey");

    const select = mocks.fileFindMany.mock.calls[0][0].select;

    expect(select.storageKey).toBeUndefined();
    expect(select.contentHash).toBeUndefined();
  });

  it("refuses to list files of a snapshot the user does not own", async () => {
    mocks.snapshotFindFirst.mockResolvedValue(null);

    await expect(
      listSnapshotFiles("intruder", "repo-1", "snap-1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(mocks.fileFindMany).not.toHaveBeenCalled();
  });

  it("returns snapshot history with counts for the owner only", async () => {
    mocks.snapshotFindMany.mockResolvedValue([
      {
        id: "snap-1",
        commitSha: "a".repeat(40),
        commitMessage: "msg",
        status: "COMPLETED",
        completeness: "PARTIAL",
        totalFiles: 10,
        eligibleFiles: 8,
        storedFiles: 7,
        skippedFiles: 2,
        failedFiles: 1,
        totalBytes: BigInt(2048),
        startedAt: new Date("2026-11-05T10:00:00Z"),
        completedAt: new Date("2026-11-05T10:01:00Z"),
        createdAt: new Date("2026-11-05T10:00:00Z"),
      },
    ]);

    const history = await listRepositorySnapshots("user-1", "repo-1");

    expect(history[0]).toMatchObject({
      completeness: "PARTIAL",
      storedFiles: 7,
      failedFiles: 1,
      totalBytes: "2048",
    });
    expect(mocks.snapshotFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: "repo-1", repository: { ownerId: "user-1" } },
      }),
    );

    mocks.repositoryFindFirst.mockResolvedValue(null);

    await expect(
      listRepositorySnapshots("intruder", "repo-1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("leaves the storage directory free of temporary files after reads", async () => {
    await storeFile("content");
    await readSnapshotFileContent(input, storage);

    const entries = await readdir(root);

    expect(entries).toEqual(["objects"]);
  });
});
