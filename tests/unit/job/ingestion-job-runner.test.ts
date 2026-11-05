// tests/unit/jobs/ingestion-job-runner.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { JobTransitionError } from "@/lib/jobs/job-errors";
import { SnapshotIngestionError } from "@/lib/ingestion/snapshot/snapshot.errors";

const mocks = vi.hoisted(() => ({
  startJob: vi.fn(),
  failJob: vi.fn(),
  ingest: vi.fn(),
  findRepository: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { repository: { findUnique: mocks.findRepository } },
}));

vi.mock("@/lib/jobs/job-lifecycle", () => ({
  startIndexingJob: mocks.startJob,
  failIndexingJob: mocks.failJob,
}));

vi.mock("@/lib/ingestion/snapshot/snapshot-ingestion.service", () => ({
  ingestRepositorySnapshot: mocks.ingest,
}));

import {
  processIndexingJob,
  validateRepositoryMetadata,
} from "@/lib/jobs/ingestion-job-runner";

const SHA = "a".repeat(40);

const repository = {
  id: "repo-1",
  ownerLogin: "octo",
  name: "hello",
  fullName: "octo/hello",
  htmlUrl: "https://github.com/octo/hello",
  defaultBranch: "main",
};

const ingestionResult = {
  snapshotId: "snapshot-1",
  commit: { sha: SHA },
  status: "COMPLETED",
  completeness: "COMPLETE",
  summary: {},
};

describe("processIndexingJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mocks.startJob.mockResolvedValue({
      id: "job-1",
      repositoryId: "repo-1",
      targetCommitSha: SHA,
    });
    mocks.findRepository.mockResolvedValue(repository);
    mocks.ingest.mockResolvedValue(ingestionResult);
    mocks.failJob.mockResolvedValue({});
  });

  it("claims the existing job and ingests the exact target commit", async () => {
    const outcome = await processIndexingJob("job-1");

    expect(mocks.startJob).toHaveBeenCalledWith("job-1");
    expect(mocks.ingest).toHaveBeenCalledWith({
      repositoryId: "repo-1",
      jobId: "job-1",
      owner: "octo",
      repositoryName: "hello",
      revision: SHA,
    });
    expect(outcome).toEqual({
      kind: "INGESTED",
      jobId: "job-1",
      result: ingestionResult,
    });
  });

  it("falls back to the default branch only when no target commit was recorded", async () => {
    mocks.startJob.mockResolvedValue({
      id: "job-1",
      repositoryId: "repo-1",
      targetCommitSha: null,
    });

    await processIndexingJob("job-1");

    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ revision: "main" }),
    );
  });

  it("fails the job when repository metadata is invalid", async () => {
    mocks.findRepository.mockResolvedValue({
      ...repository,
      htmlUrl: "https://evil.example/octo/hello",
    });

    const outcome = await processIndexingJob("job-1");

    expect(outcome).toMatchObject({
      kind: "FAILED",
      code: "INVALID_REPOSITORY_METADATA",
    });
    expect(mocks.failJob).toHaveBeenCalledWith(
      "job-1",
      "INVALID_REPOSITORY_METADATA",
      expect.any(String),
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("fails the job when the repository no longer exists", async () => {
    mocks.findRepository.mockResolvedValue(null);

    const outcome = await processIndexingJob("job-1");

    expect(outcome).toMatchObject({ kind: "FAILED" });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("returns the safe error code when ingestion fails", async () => {
    mocks.ingest.mockRejectedValue(
      new SnapshotIngestionError("No usable files", "NO_USABLE_SOURCE_FILES"),
    );

    const outcome = await processIndexingJob("job-1");

    expect(outcome).toEqual({
      kind: "FAILED",
      jobId: "job-1",
      code: "NO_USABLE_SOURCE_FILES",
    });
    // The ingestion service records the job failure itself.
    expect(mocks.failJob).not.toHaveBeenCalled();
  });

  it("does not leak unexpected error details", async () => {
    mocks.ingest.mockRejectedValue(new Error("secret token ghp_123 leaked"));

    const outcome = await processIndexingJob("job-1");

    expect(outcome).toEqual({
      kind: "FAILED",
      jobId: "job-1",
      code: "FILE_INGESTION_FAILED",
    });
  });

  it.each([
    ["INVALID_TRANSITION", "CLAIMED_ELSEWHERE"],
    ["JOB_ALREADY_CLAIMED", "CLAIMED_ELSEWHERE"],
    ["MAX_ATTEMPTS_REACHED", "MAX_ATTEMPTS_REACHED"],
    ["JOB_NOT_FOUND", "NOT_FOUND"],
  ] as const)(
    "skips a job that cannot be claimed (%s)",
    async (code, reason) => {
      mocks.startJob.mockRejectedValue(new JobTransitionError("x", code));

      const outcome = await processIndexingJob("job-1");

      expect(outcome).toEqual({ kind: "SKIPPED", jobId: "job-1", reason });
      expect(mocks.ingest).not.toHaveBeenCalled();
    },
  );

  it("rethrows unexpected claim errors", async () => {
    mocks.startJob.mockRejectedValue(new Error("database offline"));

    await expect(processIndexingJob("job-1")).rejects.toThrow(
      "database offline",
    );
  });
});

describe("validateRepositoryMetadata", () => {
  it("accepts well-formed GitHub metadata", () => {
    expect(validateRepositoryMetadata(repository)).toBe(true);
  });

  it("rejects non-GitHub hosts, mismatched names and blanks", () => {
    expect(
      validateRepositoryMetadata({ ...repository, fullName: "other/name" }),
    ).toBe(false);
    expect(validateRepositoryMetadata({ ...repository, name: " " })).toBe(
      false,
    );
    expect(
      validateRepositoryMetadata({
        ...repository,
        htmlUrl: "http://github.com/octo/hello",
      }),
    ).toBe(false);
  });
});
