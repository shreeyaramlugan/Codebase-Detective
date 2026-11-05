// tests/integration/jobs/active-job-guard.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env" });

import { prisma } from "@/lib/db/prisma";
import { retryIndexingJob } from "@/lib/jobs/job-lifecycle";

describe("Active job guard integration tests", () => {
  const testRunId = randomUUID();

  let userId: string;
  let repositoryId: string;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is missing. Check your .env file.");
    }

    const user = await prisma.user.create({
      data: {
        email: `active-job-${testRunId}@example.test`,
        name: "Active Job Test User",
      },
    });

    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        ownerId: userId,
        provider: "github",
        externalId: `active-job-${testRunId}`,
        ownerLogin: "test-owner",
        name: "active-job-test",
        fullName: `test-owner/active-job-${testRunId}`,
        htmlUrl: "https://github.com/test-owner/active-job-test",
        visibility: "PUBLIC",
        status: "FAILED",
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

  it("refuses to retry a failed job while another job is active", async () => {
    const failedJob = await prisma.indexingJob.create({
      data: {
        repositoryId,
        status: "FAILED",
        attempts: 1,
        errorCode: "TREE_RETRIEVAL_FAILED",
        errorMessage: "GitHub unavailable",
      },
    });

    const activeJob = await prisma.indexingJob.create({
      data: { repositoryId, status: "PENDING" },
    });

    await expect(retryIndexingJob(failedJob.id)).rejects.toMatchObject({
      code: "JOB_ALREADY_CLAIMED",
    });

    const unchanged = await prisma.indexingJob.findUniqueOrThrow({
      where: { id: failedJob.id },
    });

    expect(unchanged.status).toBe("FAILED");

    await prisma.indexingJob.update({
      where: { id: activeJob.id },
      data: { status: "COMPLETED" },
    });

    const retried = await retryIndexingJob(failedJob.id);

    expect(retried.status).toBe("PENDING");
  });
});
