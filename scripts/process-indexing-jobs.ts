// scripts/process-indexing-jobs.ts
import "dotenv/config";

import { prisma } from "../lib/db/prisma";
import { processIndexingJob } from "../lib/jobs/ingestion-job-runner";

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

async function processPendingJobs(): Promise<void> {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL === "1") {
    throw new Error(
      "The development job processor cannot run in production or on Vercel.",
    );
  }

  const batchSize = getBatchSize();

  console.log("Codebase Detective — Development Job Processor");
  console.log(`Batch size: ${batchSize}`);
  console.log("Mode: snapshot ingestion (GitHub Git Blobs API)");
  console.log("-----------------------------------------------");

  const pendingJobs = await prisma.indexingJob.findMany({
    where: {
      status: "PENDING",
      type: "REPOSITORY_INDEX",
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true },
  });

  if (pendingJobs.length === 0) {
    console.log("No eligible pending jobs found.");
    return;
  }

  console.log(`Found ${pendingJobs.length} pending job(s).`);

  let ingested = 0;
  let partial = 0;
  let failed = 0;
  let skipped = 0;

  for (const candidate of pendingJobs) {
    console.log(`\nProcessing job: ${candidate.id}`);

    try {
      // Claiming is atomic, so concurrent processors cannot run the same job.
      const outcome = await processIndexingJob(candidate.id);

      if (outcome.kind === "SKIPPED") {
        skipped++;
        console.log(`Result: skipped — ${outcome.reason}.`);
        continue;
      }

      if (outcome.kind === "FAILED") {
        failed++;
        console.log(`Result: failed — ${outcome.code}.`);
        continue;
      }

      const { result } = outcome;
      const { summary } = result;

      if (result.completeness === "PARTIAL") {
        partial++;
      } else {
        ingested++;
      }

      console.log(
        `Result: ${result.completeness} snapshot at ${result.commit.sha.slice(0, 7)}`,
      );
      console.log(
        `Files — total ${summary.totalFiles}, stored ${summary.storedFiles}, ` +
          `skipped ${summary.skippedFiles}, failed ${summary.failedFiles}, ` +
          `bytes ${summary.totalBytes}`,
      );
    } catch (error) {
      // Never print raw exceptions that could contain sensitive details.
      failed++;
      console.error(
        "Job processing stopped unexpectedly:",
        error instanceof Error ? error.name : "Unknown error",
      );
    }
  }

  console.log("\n-----------------------------------------------");
  console.log("Processing summary");
  console.log(`Complete: ${ingested}`);
  console.log(`Partial:  ${partial}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Skipped:  ${skipped}`);
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
