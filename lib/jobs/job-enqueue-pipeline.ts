// lib/jobs/job-enqueue-pipeline.ts
//
// Enqueue functions for the background pipeline stages (analysis, findings,
// research discovery, research synthesis). Each one:
//   1. checks that the caller owns the target (ownership is part of the query,
//      so another user's entity is indistinguishable from a missing one),
//   2. validates the payload (ids and small validated options only),
//   3. creates the job inside a serializable transaction together with a
//      dedupe key, so a double submit returns the existing active job instead
//      of creating a second one.
//
// Nothing here runs the work. The worker (or inline dev dispatch) does.
import { Prisma } from "@prisma/client";

import { resolveThresholds, ThresholdError } from "@/features/findings/config";
import { prisma } from "@/lib/db/prisma";

import {
  JobPayloadError,
  validatePayload,
  type JobPayload,
  type JobType,
} from "./job-types";

export type PipelineEnqueueCode =
  | "NOT_FOUND"
  | "INVALID_PAYLOAD"
  | "SNAPSHOT_NOT_READY"
  | "ANALYSIS_NOT_READY"
  | "BUSY";

export class PipelineEnqueueError extends Error {
  constructor(
    message: string,
    public readonly code: PipelineEnqueueCode,
  ) {
    super(message);
    this.name = "PipelineEnqueueError";
  }
}

export interface EnqueueResult {
  job: Awaited<ReturnType<typeof prisma.indexingJob.create>>;
  /** True when an equivalent active job already existed and was returned. */
  deduplicated: boolean;
}

/** A job still counts as active while queued, running, or waiting for a retry. */
function activeJobWhere(dedupeKey: string): Prisma.IndexingJobWhereInput {
  return {
    dedupeKey,
    OR: [
      { status: { in: ["PENDING", "PROCESSING"] } },
      { status: "FAILED", nextRetryAt: { not: null } },
    ],
  };
}

export function buildDedupeKey(type: JobType, userId: string, payload: JobPayload): string {
  const body = payload ? JSON.stringify(payload) : "";
  return `${type}:${userId}:${body}`.slice(0, 300);
}

async function createUniqueJob(input: {
  type: JobType;
  userId: string;
  repositoryId: string;
  payload: JobPayload;
}): Promise<EnqueueResult> {
  const dedupeKey = buildDedupeKey(input.type, input.userId, input.payload);
  try {
    return await prisma.$transaction(
      async (tx) => {
        const existing = await tx.indexingJob.findFirst({ where: activeJobWhere(dedupeKey) });
        if (existing) return { job: existing, deduplicated: true };
        const job = await tx.indexingJob.create({
          data: {
            repositoryId: input.repositoryId,
            type: input.type,
            status: "PENDING",
            requestedById: input.userId,
            payload: (input.payload ?? undefined) as Prisma.InputJsonValue | undefined,
            dedupeKey,
          },
        });
        return { job, deduplicated: false };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2002")
    ) {
      // A concurrent request won the race; return its job.
      const existing = await prisma.indexingJob.findFirst({ where: activeJobWhere(dedupeKey) });
      if (existing) return { job: existing, deduplicated: true };
      throw new PipelineEnqueueError("Another request is already being processed.", "BUSY");
    }
    throw error;
  }
}

function payloadOrThrow(type: JobType, raw: unknown): JobPayload {
  try {
    return validatePayload(type, raw);
  } catch (error) {
    if (error instanceof JobPayloadError) {
      throw new PipelineEnqueueError(error.message, "INVALID_PAYLOAD");
    }
    throw error;
  }
}

export async function enqueueAnalysisJob(userId: string, snapshotId: string): Promise<EnqueueResult> {
  const payload = payloadOrThrow("CODE_ANALYSIS", { snapshotId });
  const snapshot = await prisma.repositorySnapshot.findFirst({
    where: { id: (payload as { snapshotId: string }).snapshotId, repository: { ownerId: userId } },
    select: { id: true, repositoryId: true, status: true },
  });
  if (!snapshot) throw new PipelineEnqueueError("Snapshot not found.", "NOT_FOUND");
  if (snapshot.status !== "COMPLETED") {
    throw new PipelineEnqueueError("The snapshot is not ready for analysis.", "SNAPSHOT_NOT_READY");
  }
  return createUniqueJob({ type: "CODE_ANALYSIS", userId, repositoryId: snapshot.repositoryId, payload });
}

export async function enqueueFindingsJob(
  userId: string,
  analysisId: string,
  thresholds?: unknown,
): Promise<EnqueueResult> {
  // Validate the options now so a bad request fails fast instead of in the worker.
  let clean: Record<string, number> | undefined;
  try {
    const raw = thresholds ?? {};
    resolveThresholds(raw);
    if (raw && typeof raw === "object" && Object.keys(raw as object).length > 0) {
      clean = raw as Record<string, number>;
    }
  } catch (error) {
    if (error instanceof ThresholdError) throw new PipelineEnqueueError(error.message, "INVALID_PAYLOAD");
    throw error;
  }
  const payload = payloadOrThrow("FINDINGS_GENERATION", {
    analysisId,
    ...(clean ? { thresholds: clean } : {}),
  });
  const analysis = await prisma.codeAnalysis.findFirst({
    where: { id: (payload as { analysisId: string }).analysisId, repository: { ownerId: userId } },
    select: { id: true, repositoryId: true, status: true },
  });
  if (!analysis) throw new PipelineEnqueueError("Analysis not found.", "NOT_FOUND");
  if (analysis.status !== "COMPLETED" && analysis.status !== "PARTIAL") {
    throw new PipelineEnqueueError("This analysis has not finished.", "ANALYSIS_NOT_READY");
  }
  return createUniqueJob({ type: "FINDINGS_GENERATION", userId, repositoryId: analysis.repositoryId, payload });
}

async function enqueueResearchJob(
  type: "RESEARCH_DISCOVERY" | "RESEARCH_SYNTHESIS",
  userId: string,
  runId: string,
): Promise<EnqueueResult> {
  const payload = payloadOrThrow(type, { runId });
  const run = await prisma.researchRun.findFirst({
    where: { id: (payload as { runId: string }).runId, userId },
    select: { id: true, repositoryId: true },
  });
  if (!run) throw new PipelineEnqueueError("Research run not found.", "NOT_FOUND");
  return createUniqueJob({ type, userId, repositoryId: run.repositoryId, payload });
}

export const enqueueResearchDiscoveryJob = (userId: string, runId: string) =>
  enqueueResearchJob("RESEARCH_DISCOVERY", userId, runId);
export const enqueueResearchSynthesisJob = (userId: string, runId: string) =>
  enqueueResearchJob("RESEARCH_SYNTHESIS", userId, runId);
