// tests/unit/jobs/job-enqueue.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  repositoryFindFirst: vi.fn(),
  jobFindFirst: vi.fn(),
  transaction: vi.fn(),
  latestCommit: vi.fn(),
  txJobFindFirst: vi.fn(),
  txJobCreate: vi.fn(),
  txRepositoryUpdate: vi.fn(),
}));

vi.mock("@prisma/client", () => {
  class PrismaClientKnownRequestError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
    }
  }

  return {
    Prisma: {
      PrismaClientKnownRequestError,
      TransactionIsolationLevel: { Serializable: "Serializable" },
    },
  };
});

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    repository: { findFirst: mocks.repositoryFindFirst },
    indexingJob: { findFirst: mocks.jobFindFirst },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/github/github.client", () => ({
  getLatestCommitSha: mocks.latestCommit,
}));

import { Prisma } from "@prisma/client";

import { EnqueueError, enqueueIngestionJob } from "@/lib/jobs/job-enqueue";

const SHA = "b".repeat(40);

const repository = {
  id: "repo-1",
  ownerLogin: "octo",
  name: "hello",
  defaultBranch: "main",
  lastCommitSha: "c".repeat(40),
};

describe("enqueueIngestionJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.repositoryFindFirst.mockResolvedValue(repository);
    mocks.jobFindFirst.mockResolvedValue(null);
    mocks.latestCommit.mockResolvedValue(SHA);
    mocks.txJobFindFirst.mockResolvedValue(null);
    mocks.txJobCreate.mockResolvedValue({
      id: "job-2",
      status: "PENDING",
      targetCommitSha: SHA,
    });
    mocks.txRepositoryUpdate.mockResolvedValue({});
    mocks.transaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          indexingJob: {
            findFirst: mocks.txJobFindFirst,
            create: mocks.txJobCreate,
          },
          repository: { update: mocks.txRepositoryUpdate },
        }),
    );
  });

  it("creates a pending job pinned to the latest commit", async () => {
    const job = await enqueueIngestionJob({
      repositoryId: "repo-1",
      ownerId: "user-1",
    });

    expect(job.id).toBe("job-2");
    expect(mocks.txJobCreate).toHaveBeenCalledWith({
      data: {
        repositoryId: "repo-1",
        type: "REPOSITORY_INDEX",
        status: "PENDING",
        targetCommitSha: SHA,
      },
    });
    expect(mocks.txRepositoryUpdate).toHaveBeenCalledWith({
      where: { id: "repo-1" },
      data: { status: "QUEUED", lastCommitSha: SHA },
    });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });

  it("only looks up repositories owned by the caller", async () => {
    await enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" });

    expect(mocks.repositoryFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "repo-1", ownerId: "user-1" },
      }),
    );
  });

  it("treats another user's repository as not found", async () => {
    mocks.repositoryFindFirst.mockResolvedValue(null);

    await expect(
      enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "intruder" }),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_FOUND" });

    expect(mocks.latestCommit).not.toHaveBeenCalled();
    expect(mocks.txJobCreate).not.toHaveBeenCalled();
  });

  it("refuses to queue while a job is pending or processing", async () => {
    mocks.jobFindFirst.mockResolvedValue({ id: "job-1" });

    await expect(
      enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" }),
    ).rejects.toMatchObject({ code: "JOB_ALREADY_ACTIVE" });

    expect(mocks.txJobCreate).not.toHaveBeenCalled();
  });

  it("rejects a job that appears inside the transaction", async () => {
    mocks.txJobFindFirst.mockResolvedValue({ id: "job-9" });

    await expect(
      enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" }),
    ).rejects.toMatchObject({ code: "JOB_ALREADY_ACTIVE" });

    expect(mocks.txJobCreate).not.toHaveBeenCalled();
  });

  it.each(["P2034", "P2002"])(
    "reports a concurrent winner (%s) as already active",
    async (code) => {
      mocks.transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("conflict", code as never),
      );

      await expect(
        enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" }),
      ).rejects.toBeInstanceOf(EnqueueError);
    },
  );

  it("fails clearly when the repository has no commits", async () => {
    mocks.latestCommit.mockResolvedValue(null);

    await expect(
      enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" }),
    ).rejects.toMatchObject({ code: "NO_COMMITS" });
  });

  it("fails clearly when no default branch is known", async () => {
    mocks.repositoryFindFirst.mockResolvedValue({
      ...repository,
      defaultBranch: null,
    });

    await expect(
      enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" }),
    ).rejects.toMatchObject({ code: "NO_BRANCH" });
  });

  it("propagates unexpected database errors", async () => {
    mocks.transaction.mockRejectedValue(new Error("database offline"));

    await expect(
      enqueueIngestionJob({ repositoryId: "repo-1", ownerId: "user-1" }),
    ).rejects.toThrow("database offline");
  });
});
