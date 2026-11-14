// lib/worker/pipeline-ports.ts
//
// The narrow set of operations the job handlers need from the rest of the
// application. Handlers depend on this interface (not on Prisma or the
// services directly) so the reliability rules are unit-testable offline, and
// the production wiring below reuses the existing Sprint 02-07 services
// without duplicating their logic.
import { prisma } from "@/lib/db/prisma";
import { startSnapshotAnalysis } from "@/lib/analysis/analysis.service";
import { startFindingsRun } from "@/lib/findings/findings.start";
import { enqueueAnalysisJob } from "@/lib/jobs/job-enqueue-pipeline";
import { runIngestionForClaimedJob } from "@/lib/jobs/ingestion-job-runner";
import { createResearchDeps } from "@/lib/research/research.runtime";
import { failRunFinal, reopenReview, runPreparedDiscovery, runPreparedSynthesis } from "@/lib/research/research.service";

import { attachJobResult } from "./queue.prisma";

export interface RunRef {
  id: string;
  status: string;
}

export interface PipelinePorts {
  ingestion: {
    run(job: { id: string; repositoryId: string; targetCommitSha: string | null }): Promise<{
      ok: boolean;
      snapshotId?: string;
      code?: string;
      causeCode?: string;
      detail?: string;
    }>;
    attachResult(jobId: string, result: Record<string, unknown>): Promise<void>;
    /** Queues code analysis for a freshly ingested snapshot (deduplicated). */
    enqueueAnalysis?(repositoryId: string, requestedById: string | null, snapshotId: string): Promise<void>;
  };
  analysis: {
    /** Repository id when the user owns the snapshot, else null. */
    ownedSnapshotRepository(userId: string, snapshotId: string): Promise<string | null>;
    listRunsSince(userId: string, snapshotId: string, since: Date): Promise<RunRef[]>;
    failOrphans(ids: string[], code: string): Promise<void>;
    start(userId: string, snapshotId: string): Promise<{ analysisId: string; status: string; errorCode: string | null }>;
  };
  findings: {
    ownedAnalysisRepository(userId: string, analysisId: string): Promise<string | null>;
    listRunsSince(userId: string, analysisId: string, since: Date): Promise<RunRef[]>;
    failOrphans(ids: string[], code: string): Promise<void>;
    start(
      userId: string,
      analysisId: string,
      thresholds?: unknown,
    ): Promise<{ runId: string; status: string; errorCode: string | null }>;
  };
  research: {
    /** Repository id when the user owns the run, else null. */
    ownedRunRepository(userId: string, runId: string): Promise<string | null>;
    discover(userId: string, runId: string): Promise<{ status: string }>;
    synthesise(userId: string, runId: string): Promise<{ status: string }>;
    failDiscovery(userId: string, runId: string, code: string): Promise<void>;
    reopenSynthesis(userId: string, runId: string, code: string): Promise<void>;
  };
}

export function createPrismaPorts(): PipelinePorts {
  return {
    ingestion: {
      async run(job) {
        const outcome = await runIngestionForClaimedJob(job);
        if (outcome.kind === "INGESTED") return { ok: true, snapshotId: outcome.result.snapshotId };
        return {
          ok: false,
          code: outcome.kind === "FAILED" ? outcome.code : "SKIPPED",
          causeCode: outcome.kind === "FAILED" ? outcome.causeCode : undefined,
          detail: outcome.kind === "FAILED" ? outcome.detail : undefined,
        };
      },
      attachResult: (jobId, result) => attachJobResult(jobId, result),
      async enqueueAnalysis(repositoryId, requestedById, snapshotId) {
        // Jobs created before the requester was recorded fall back to the
        // repository owner, who is the only user who could have started them.
        const userId =
          requestedById ??
          (await prisma.repository.findUnique({ where: { id: repositoryId }, select: { ownerId: true } }))?.ownerId;
        if (!userId) return;
        await enqueueAnalysisJob(userId, snapshotId);
      },
    },
    analysis: {
      async ownedSnapshotRepository(userId, snapshotId) {
        const row = await prisma.repositorySnapshot.findFirst({
          where: { id: snapshotId, repository: { ownerId: userId } },
          select: { repositoryId: true },
        });
        return row?.repositoryId ?? null;
      },
      listRunsSince: (userId, snapshotId, since) =>
        prisma.codeAnalysis.findMany({
          where: { snapshotId, requestedById: userId, createdAt: { gte: since } },
          select: { id: true, status: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      async failOrphans(ids, code) {
        if (ids.length === 0) return;
        await prisma.codeAnalysis.updateMany({
          where: { id: { in: ids }, status: { in: ["PENDING", "PROCESSING"] } },
          data: { status: "FAILED", errorCode: code, errorMessage: "The run was interrupted and will be retried." },
        });
      },
      async start(userId, snapshotId) {
        const r = await startSnapshotAnalysis(userId, snapshotId);
        return { analysisId: r.analysisId, status: r.status, errorCode: r.errorCode ?? null };
      },
    },
    findings: {
      async ownedAnalysisRepository(userId, analysisId) {
        const row = await prisma.codeAnalysis.findFirst({
          where: { id: analysisId, repository: { ownerId: userId } },
          select: { repositoryId: true },
        });
        return row?.repositoryId ?? null;
      },
      listRunsSince: (userId, analysisId, since) =>
        prisma.findingsRun.findMany({
          where: { analysisId, requestedById: userId, createdAt: { gte: since } },
          select: { id: true, status: true },
          orderBy: { createdAt: "desc" },
          take: 20,
        }),
      async failOrphans(ids, code) {
        if (ids.length === 0) return;
        await prisma.findingsRun.updateMany({
          where: { id: { in: ids }, status: { in: ["PENDING", "PROCESSING"] } },
          data: { status: "FAILED", errorCode: code, errorMessage: "The run was interrupted and will be retried." },
        });
      },
      async start(userId, analysisId, thresholds) {
        const r = await startFindingsRun(userId, analysisId, thresholds);
        return { runId: r.runId, status: r.status, errorCode: r.errorCode ?? null };
      },
    },
    research: {
      async ownedRunRepository(userId, runId) {
        const row = await prisma.researchRun.findFirst({ where: { id: runId, userId }, select: { repositoryId: true } });
        return row?.repositoryId ?? null;
      },
      async discover(userId, runId) {
        const run = await runPreparedDiscovery(createResearchDeps(userId), userId, runId, { failRunOnError: false });
        return { status: run.status };
      },
      async synthesise(userId, runId) {
        const run = await runPreparedSynthesis(createResearchDeps(userId), userId, runId);
        return { status: run.status };
      },
      failDiscovery: (userId, runId, code) => failRunFinal(createResearchDeps(userId), runId, code),
      reopenSynthesis: (userId, runId, code) => reopenReview(createResearchDeps(userId), runId, code),
    },
  };
}
