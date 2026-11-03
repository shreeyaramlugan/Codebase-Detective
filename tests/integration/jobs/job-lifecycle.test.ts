import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env" });

import { prisma } from "@/lib/db/prisma";
import {
  startIndexingJob,
  completeIndexingJob,
  failIndexingJob,
  retryIndexingJob,
} from "@/lib/jobs/job-lifecycle";
import { JobTransitionError } from "@/lib/jobs/job-errors";

describe("Indexing job lifecycle integration tests", () => {
  const testRunId = randomUUID();

  let userId: string;
  let repositoryId: string;

  const jobIds: string[] = [];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing. Check your .env file.");
    }

    const user = await prisma.user.create({
      data: {
        email: `job-lifecycle-${testRunId}@example.test`,
        name: "Job Lifecycle Test User",
      },
    });

    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        ownerId: userId,
        provider: "github",
        externalId: `test-${testRunId}`,
        ownerLogin: "test-owner",
        name: "job-lifecycle-test",
        fullName: `test-owner/job-lifecycle-${testRunId}`,
        htmlUrl: "https://github.com/test-owner/job-lifecycle-test",
        visibility: "PUBLIC",
        status: "QUEUED",
      },
    });

    repositoryId = repository.id;
  });

  afterAll(async () => {
    try {
      // Deleting the test user cascades to its repositories and jobs.
      if (userId) {
        await prisma.user.deleteMany({
          where: { id: userId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  async function createJob(maxAttempts = 3) {
    const job = await prisma.indexingJob.create({
      data: {
        repositoryId,
        type: "REPOSITORY_INDEX",
        status: "PENDING",
        attempts: 0,
        maxAttempts,
      },
    });

    jobIds.push(job.id);

    return job;
  }

  async function getRepository() {
    return prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId },
    });
  }

  async function getJob(jobId: string) {
    return prisma.indexingJob.findUniqueOrThrow({
      where: { id: jobId },
    });
  }

  it("starts a pending job and increments attempts", async () => {
    const job = await createJob();

    const started = await startIndexingJob(job.id);
    const repository = await getRepository();

    expect(started.status).toBe("PROCESSING");
    expect(started.attempts).toBe(1);
    expect(started.startedAt).toBeInstanceOf(Date);
    expect(repository.status).toBe("INDEXING");
  });

  it("completes a processing job and indexes its repository", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    const completed = await completeIndexingJob(job.id);
    const repository = await getRepository();

    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(repository.status).toBe("INDEXED");
  });

  it("fails a processing job and marks its repository failed", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    const failed = await failIndexingJob(
      job.id,
      "TEST_FAILURE",
      "Simulated test failure",
    );

    const repository = await getRepository();

    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe("TEST_FAILURE");
    expect(failed.errorMessage).toBe("Simulated test failure");
    expect(repository.status).toBe("FAILED");
  });
  it("retries an eligible failed job", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    const failed = await failIndexingJob(job.id, "TEST_FAILURE", "Retry test");

    expect(failed.nextRetryAt).toBeInstanceOf(Date);

    // Simulate the retry delay having elapsed.
    await prisma.indexingJob.update({
      where: { id: job.id },
      data: {
        nextRetryAt: new Date(Date.now() - 1000),
      },
    });

    const retried = await retryIndexingJob(job.id);
    const repository = await getRepository();

    expect(retried.status).toBe("PENDING");
    expect(retried.attempts).toBe(1);
    expect(retried.startedAt).toBeNull();
    expect(retried.errorCode).toBeNull();
    expect(retried.errorMessage).toBeNull();
    expect(retried.nextRetryAt).toBeNull();
    expect(repository.status).toBe("QUEUED");
  });

  it("allows a retried job to start a second attempt", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    await failIndexingJob(job.id, "TEST_FAILURE", "First attempt");

    // Simulate the retry delay having elapsed.
    await prisma.indexingJob.update({
      where: { id: job.id },
      data: {
        nextRetryAt: new Date(Date.now() - 1000),
      },
    });

    await retryIndexingJob(job.id);

    const secondAttempt = await startIndexingJob(job.id);

    expect(secondAttempt.status).toBe("PROCESSING");
    expect(secondAttempt.attempts).toBe(2);
  });

  it("rejects starting a job that is already processing", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    await expect(startIndexingJob(job.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });

    const unchanged = await getJob(job.id);

    expect(unchanged.status).toBe("PROCESSING");
    expect(unchanged.attempts).toBe(1);
  });

  it("rejects completing a job that has not started", async () => {
    const job = await createJob();

    await expect(completeIndexingJob(job.id)).rejects.toBeInstanceOf(
      JobTransitionError,
    );

    const unchanged = await getJob(job.id);

    expect(unchanged.status).toBe("PENDING");
  });

  it("rejects retrying a job that has not failed", async () => {
    const job = await createJob();

    await expect(retryIndexingJob(job.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });
  });

  it("respects a job-specific maximum attempt limit", async () => {
    const job = await createJob(1);

    await startIndexingJob(job.id);
    await failIndexingJob(job.id, "TEST_FAILURE", "Maximum attempts test");

    await expect(retryIndexingJob(job.id)).rejects.toMatchObject({
      code: "MAX_ATTEMPTS_REACHED",
    });

    const unchanged = await getJob(job.id);

    expect(unchanged.status).toBe("FAILED");
    expect(unchanged.attempts).toBe(1);
  });

  it("rejects an unknown job ID", async () => {
    await expect(startIndexingJob("non-existent-job-id")).rejects.toMatchObject(
      {
        code: "JOB_NOT_FOUND",
      },
    );
  });

  it("rejects an expired retry window", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);
    await failIndexingJob(job.id, "TEST_FAILURE", "Retry window test");

    await prisma.indexingJob.update({
      where: { id: job.id },
      data: {
        nextRetryAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await expect(retryIndexingJob(job.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });

    const unchanged = await getJob(job.id);

    expect(unchanged.status).toBe("FAILED");
  });

  it("does not allow two concurrent callers to claim the same job", async () => {
    const job = await createJob();

    const results = await Promise.allSettled([
      startIndexingJob(job.id),
      startIndexingJob(job.id),
    ]);

    const successful = results.filter(
      (result) => result.status === "fulfilled",
    );

    const rejected = results.filter((result) => result.status === "rejected");

    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const finalJob = await getJob(job.id);

    expect(finalJob.status).toBe("PROCESSING");
    expect(finalJob.attempts).toBe(1);
  });
  it("schedules the first retry after approximately 30 seconds", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    const beforeFailure = Date.now();

    const failed = await failIndexingJob(
      job.id,
      "TEST_FAILURE",
      "First failure",
    );

    const afterFailure = Date.now();

    expect(failed.nextRetryAt).toBeInstanceOf(Date);

    const delay = failed.nextRetryAt!.getTime() - beforeFailure;

    expect(delay).toBeGreaterThanOrEqual(30_000);
    expect(delay).toBeLessThanOrEqual(afterFailure - beforeFailure + 30_000);
  });

  it("does not allow a retry before nextRetryAt", async () => {
    const job = await createJob();

    await startIndexingJob(job.id);

    const failed = await failIndexingJob(
      job.id,
      "TEST_FAILURE",
      "Retry timing test",
    );

    expect(failed.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());

    await expect(retryIndexingJob(job.id)).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });

    const unchanged = await getJob(job.id);

    expect(unchanged.status).toBe("FAILED");
  });

  it("does not schedule another retry after maximum attempts", async () => {
    const job = await createJob(1);

    await startIndexingJob(job.id);

    const failed = await failIndexingJob(
      job.id,
      "TEST_FAILURE",
      "Final attempt failed",
    );

    expect(failed.status).toBe("FAILED");
    expect(failed.attempts).toBe(1);
    expect(failed.maxAttempts).toBe(1);
    expect(failed.nextRetryAt).toBeNull();

    await expect(retryIndexingJob(job.id)).rejects.toMatchObject({
      code: "MAX_ATTEMPTS_REACHED",
    });
  });
});
