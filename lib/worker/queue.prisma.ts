// lib/worker/queue.prisma.ts
//
// Prisma-backed implementation of the worker's queue port. A thin adapter over
// lib/jobs/job-queue.ts; all atomicity lives in those functions.
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  claimNextJob,
  completeJobForWorker,
  failJobForWorker,
  heartbeatJob,
  markWorkerStopped,
  promoteDueRetries,
  recoverStaleJobs,
  registerWorker,
  releaseJob,
  workerHeartbeat,
} from "@/lib/jobs/job-queue";
import { sanitiseResult } from "@/lib/jobs/job-types";
import { hostname } from "node:os";

import type { WorkerQueuePort } from "./runtime";

export const WORKER_VERSION = process.env.npm_package_version ?? "0.0.0";

export function createPrismaQueue(): WorkerQueuePort {
  return {
    promoteDueRetries: (now) => promoteDueRetries(now),
    claimNext: (workerId, types, now) => claimNextJob(workerId, types, now),
    heartbeat: (jobId, workerId, now) => heartbeatJob(jobId, workerId, now),
    complete: (job, workerId, result) => completeJobForWorker(job, workerId, result),
    fail: (job, workerId, failure) => failJobForWorker(job, workerId, failure),
    release: (job, workerId) => releaseJob(job.id, workerId),
    recoverStale: (now, staleAfterMs) => recoverStaleJobs(now, staleAfterMs),
    register: (info) =>
      registerWorker({
        id: info.id,
        hostname: hostname(),
        pid: process.pid,
        version: WORKER_VERSION,
        concurrency: info.concurrency,
        startedAt: info.startedAt,
      }),
    workerHeartbeat: (id, state) => workerHeartbeat(id, state),
    markStopped: (id, now) => markWorkerStopped(id, now),
    async checkDatabase() {
      await prisma.$queryRaw`SELECT 1`;
    },
  };
}

/**
 * Attach small id references (for example the snapshot an ingestion produced)
 * to an ingestion job whose lifecycle the ingestion service completed itself.
 * Only a COMPLETED job that has no result yet is touched.
 */
export async function attachJobResult(jobId: string, result: unknown): Promise<void> {
  const clean = sanitiseResult(result);
  if (!clean) return;
  await prisma.indexingJob.updateMany({
    where: { id: jobId, type: "REPOSITORY_INDEX", status: "COMPLETED", result: { equals: Prisma.DbNull } },
    data: { result: clean },
  });
}
