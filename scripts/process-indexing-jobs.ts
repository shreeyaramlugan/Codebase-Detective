import "dotenv/config";

import { prisma } from "../lib/db/prisma";
import {
  startIndexingJob,
  completeIndexingJob,
  failIndexingJob,
} from "../lib/jobs/job-lifecycle";
import { JobTransitionError } from "../lib/jobs/job-errors";

const DEFAULT_BATCH_SIZE = 5;
const MAX_BATCH_SIZE = 10;

function getBatchSize(): number {
  const argument = process.argv[2];

  if (!argument) {
    return DEFAULT_BATCH_SIZE;
  }

  const value = Number(argument);

  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_SIZE) {
    throw new Error(
      `Batch size must be a whole number between 1 and ${MAX_BATCH_SIZE}.`,
    );
  }

  return value;
}

function validateRepositoryMetadata(repository: {
  ownerLogin: string;
  name: string;
  fullName: string;
  htmlUrl: string;
}): boolean {
  if (
    !repository.ownerLogin.trim() ||
    !repository.name.trim() ||
    !repository.fullName.trim() ||
    !repository.htmlUrl.trim()
  ) {
    return false;
  }

  try {
    const url = new URL(repository.htmlUrl);

    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      repository.fullName.toLowerCase() ===
        `${repository.ownerLogin}/${repository.name}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function processPendingJobs(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
    throw new Error(
      "The development job processor cannot run in production or on Vercel.",
    );
  }

  const batchSize = getBatchSize();

  console.log("Codebase Detective — Development Job Processor");
  console.log(`Batch size: ${batchSize}`);
  console.log("Mode: metadata simulation only");
  console.log("-----------------------------------------------");

  const pendingJobs = await prisma.indexingJob.findMany({
    where: {
      status: "PENDING",
      type: "REPOSITORY_INDEX",
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    orderBy: {
      createdAt: "asc",
    },
    take: batchSize,
    select: {
      id: true,
      repositoryId: true,
    },
  });

  if (pendingJobs.length === 0) {
    console.log("No eligible pending jobs found.");
    return;
  }

  console.log(`Found ${pendingJobs.length} pending job(s).`);

  let completed = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of pendingJobs) {
    let claimed = false;

    console.log(`\nProcessing job: ${candidate.id}`);

    try {
      // Atomic claim: only one processor can start this job.
      const job = await startIndexingJob(candidate.id);
      claimed = true;

      const repository = await prisma.repository.findUnique({
        where: {
          id: job.repositoryId,
        },
        select: {
          id: true,
          ownerLogin: true,
          name: true,
          fullName: true,
          htmlUrl: true,
          visibility: true,
          defaultBranch: true,
        },
      });

      if (!repository || !validateRepositoryMetadata(repository)) {
        await failIndexingJob(
          job.id,
          "INVALID_REPOSITORY_METADATA",
          "Repository metadata is missing or invalid.",
        );

        failed++;
        console.log("Result: failed — invalid repository metadata.");
        continue;
      }

      // Sprint 01.6.4 simulation:
      // We validate stored metadata only.
      // No GitHub clone, source download or code execution occurs.
      console.log(`Repository: ${repository.fullName}`);
      console.log(`Visibility: ${repository.visibility}`);
      console.log(
        `Default branch: ${repository.defaultBranch ?? "Not provided"}`,
      );

      await completeIndexingJob(job.id);

      completed++;
      console.log("Result: completed — metadata simulation passed.");
    } catch (error) {
      if (!claimed) {
        if (
          error instanceof JobTransitionError &&
          error.code === "INVALID_TRANSITION"
        ) {
          skipped++;
          console.log(
            "Result: skipped — job was claimed elsewhere or is unavailable.",
          );
          continue;
        }

        if (
          error instanceof JobTransitionError &&
          error.code === "MAX_ATTEMPTS_REACHED"
        ) {
          skipped++;
          console.log("Result: skipped — maximum attempts reached.");
          continue;
        }

        if (
          error instanceof JobTransitionError &&
          error.code === "JOB_NOT_FOUND"
        ) {
          skipped++;
          console.log("Result: skipped — job no longer exists.");
          continue;
        }

        console.error("Could not claim job:", candidate.id);
        console.error(error instanceof Error ? error.message : "Unknown error");
        skipped++;
        continue;
      }

      // Do not store raw exceptions, stack traces or secrets in the database.
      try {
        await failIndexingJob(
          candidate.id,
          "PROCESSING_ERROR",
          "The development indexing simulation could not be completed.",
        );

        failed++;
        console.log("Result: failed — processing error recorded.");
      } catch (failureError) {
        console.error("Could not record the job failure:", candidate.id);
        console.error(
          failureError instanceof Error
            ? failureError.message
            : "Unknown error",
        );
      }
    }
  }

  console.log("\n-----------------------------------------------");
  console.log("Processing summary");
  console.log(`Completed: ${completed}`);
  console.log(`Failed:    ${failed}`);
  console.log(`Skipped:   ${skipped}`);
  console.log("-----------------------------------------------");
}

processPendingJobs()
  .catch((error) => {
    console.error(
      "Development processor stopped:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
