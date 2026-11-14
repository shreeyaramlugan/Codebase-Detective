// lib/worker/handlers.ts
//
// One handler per job type. Handlers are deliberately short: they re-validate
// the payload and the requester's ownership, then call the existing service
// through the PipelinePorts. Any failure is mapped to a JobFailure with a safe
// code and an explicit retryable/permanent decision.
//
// Idempotency (so a retry or a recovered job never duplicates work):
//  - ingestion: the snapshot service itself claims/reuses the commit snapshot.
//  - analysis/findings: a COMPLETED/PARTIAL run created since the job was
//    queued is reused; runs left PENDING/PROCESSING by a crashed attempt are
//    marked FAILED (WORKER_INTERRUPTED) before a new immutable run is started.
//    Completed runs are never modified.
//  - research: discovery/synthesis are no-ops for a run already past that stage.
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import { FindingsError } from "@/lib/findings/findings.errors";
import { isRetryableCode, JobFailure } from "@/lib/jobs/job-policy";
import { JobPayloadError, validatePayload } from "@/lib/jobs/job-types";
import type { FindingsPayload, JobType } from "@/lib/jobs/job-types";
import { ResearchError } from "@/lib/research/research.errors";

import type { PipelinePorts } from "./pipeline-ports";
import type { HandlerContext, HandlerRegistry, HandlerResult, JobHandler } from "./runtime";

type Job = HandlerContext["job"];

function payloadFor<T>(type: JobType, job: Job): T {
  try {
    return validatePayload(type, job.payload ?? null) as T;
  } catch (error) {
    if (error instanceof JobPayloadError) {
      throw new JobFailure(error.message, "INVALID_PAYLOAD", { retryable: false });
    }
    throw error;
  }
}

function requester(job: Job): string {
  if (!job.requestedById) {
    throw new JobFailure("The job has no requester.", "OWNERSHIP_VIOLATION", { retryable: false });
  }
  return job.requestedById;
}

/** Ownership is revalidated at execution time, not trusted from creation. */
function assertSameRepository(job: Job, ownedRepositoryId: string | null) {
  if (!ownedRepositoryId) {
    throw new JobFailure("The target no longer exists or is not accessible.", "NOT_FOUND", { retryable: false });
  }
  if (ownedRepositoryId !== job.repositoryId) {
    throw new JobFailure("The target does not belong to the job's repository.", "OWNERSHIP_VIOLATION", {
      retryable: false,
    });
  }
}

const PERMANENT_RESEARCH_CODES = new Set([
  "NOT_FOUND",
  "INVALID_INPUT",
  "UNSUPPORTED",
  "CONTEXT_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "INVALID_STATE",
  "NOT_CONFIGURED",
]);

/** Convert a service error into a JobFailure. Unknown errors stay generic and retryable. */
export function mapServiceError(error: unknown): unknown {
  if (error instanceof JobFailure) return error;
  if (error instanceof AnalysisError || error instanceof FindingsError) {
    return new JobFailure(error.message, error.code, { retryable: isRetryableCode(error.code) });
  }
  if (error instanceof ResearchError) {
    const retryable = error.options.retryable ?? !PERMANENT_RESEARCH_CODES.has(error.code);
    return new JobFailure(error.message, error.code, { retryable: PERMANENT_RESEARCH_CODES.has(error.code) ? false : retryable });
  }
  return error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapServiceError(error);
  }
}

const REUSABLE = new Set(["COMPLETED", "PARTIAL"]);
const IN_FLIGHT = new Set(["PENDING", "PROCESSING"]);

export function createHandlers(ports: PipelinePorts): HandlerRegistry {
  const ingestion: JobHandler = {
    async handle({ job, log }): Promise<HandlerResult> {
      const outcome = await ports.ingestion.run(job);
      if (!outcome.ok) {
        // The ingestion service already recorded the failure on the job; log
        // the safe code so an operator can see why without opening the database.
        log.warn("ingestion did not complete", {
          event: "ingestion_failed",
          code: outcome.code ?? "UNKNOWN",
          causeCode: outcome.causeCode,
          detail: outcome.detail,
        });
      }
      if (outcome.ok && outcome.snapshotId) {
        await ports.ingestion.attachResult(job.id, { snapshotId: outcome.snapshotId }).catch(() => undefined);
        // Analysis follows ingestion automatically. Best effort: a failure here
        // must never change the ingestion result, and the job is deduplicated.
        if (ports.ingestion.enqueueAnalysis) {
          await ports.ingestion
            .enqueueAnalysis(job.repositoryId, job.requestedById, outcome.snapshotId).catch((error: unknown) => {
            log.warn("could not queue analysis", {
              event: "analysis_enqueue_failed",
              code: error instanceof Error ? error.name : "UNKNOWN",
            });
          });
        }
      }
      // The ingestion service recorded the final job state itself.
      return { selfManaged: true };
    },
  };

  const analysis: JobHandler = {
    async handle({ job, log }): Promise<HandlerResult> {
      const { snapshotId } = payloadFor<{ snapshotId: string }>("CODE_ANALYSIS", job);
      const userId = requester(job);
      assertSameRepository(job, await ports.analysis.ownedSnapshotRepository(userId, snapshotId));

      const prior = await ports.analysis.listRunsSince(userId, snapshotId, job.createdAt);
      const done = prior.find((r) => REUSABLE.has(r.status));
      if (done) {
        log.info("reusing completed analysis", { event: "analysis_reused", analysisId: done.id });
        return { result: { analysisId: done.id, status: done.status } };
      }
      await ports.analysis.failOrphans(
        prior.filter((r) => IN_FLIGHT.has(r.status)).map((r) => r.id),
        "WORKER_INTERRUPTED",
      );

      const run = await guarded(() => ports.analysis.start(userId, snapshotId));
      if (run.status === "FAILED") {
        const code = run.errorCode ?? "ANALYSIS_FAILED";
        throw new JobFailure("Analysis failed.", code, { retryable: isRetryableCode(code) });
      }
      return { result: { analysisId: run.analysisId, status: run.status } };
    },
  };

  const findings: JobHandler = {
    async handle({ job, log }): Promise<HandlerResult> {
      const payload = payloadFor<FindingsPayload>("FINDINGS_GENERATION", job);
      const userId = requester(job);
      assertSameRepository(job, await ports.findings.ownedAnalysisRepository(userId, payload.analysisId));

      const prior = await ports.findings.listRunsSince(userId, payload.analysisId, job.createdAt);
      const done = prior.find((r) => REUSABLE.has(r.status));
      if (done) {
        log.info("reusing completed findings run", { event: "findings_reused", findingsRunId: done.id });
        return { result: { findingsRunId: done.id, analysisId: payload.analysisId, status: done.status } };
      }
      await ports.findings.failOrphans(
        prior.filter((r) => IN_FLIGHT.has(r.status)).map((r) => r.id),
        "WORKER_INTERRUPTED",
      );

      const run = await guarded(() => ports.findings.start(userId, payload.analysisId, payload.thresholds));
      if (run.status === "FAILED") {
        const code = run.errorCode ?? "FINDINGS_RUN_FAILED";
        throw new JobFailure("Findings generation failed.", code, { retryable: isRetryableCode(code) });
      }
      return { result: { findingsRunId: run.runId, analysisId: payload.analysisId, status: run.status } };
    },
  };

  const researchDiscovery: JobHandler = {
    async handle({ job }): Promise<HandlerResult> {
      const { runId } = payloadFor<{ runId: string }>("RESEARCH_DISCOVERY", job);
      const userId = requester(job);
      assertSameRepository(job, await ports.research.ownedRunRepository(userId, runId));
      const run = await guarded(() => ports.research.discover(userId, runId));
      return { result: { researchRunId: runId, status: run.status } };
    },
    async onFinalFailure(job) {
      if (!job.requestedById) return;
      const { runId } = payloadFor<{ runId: string }>("RESEARCH_DISCOVERY", job);
      await ports.research.failDiscovery(job.requestedById, runId, "DISCOVERY_FAILED");
    },
  };

  const researchSynthesis: JobHandler = {
    async handle({ job }): Promise<HandlerResult> {
      const { runId } = payloadFor<{ runId: string }>("RESEARCH_SYNTHESIS", job);
      const userId = requester(job);
      assertSameRepository(job, await ports.research.ownedRunRepository(userId, runId));
      const run = await guarded(() => ports.research.synthesise(userId, runId));
      return { result: { researchRunId: runId, status: run.status } };
    },
    async onFinalFailure(job, failure) {
      if (!job.requestedById) return;
      const { runId } = payloadFor<{ runId: string }>("RESEARCH_SYNTHESIS", job);
      // Back to review so the person can adjust sources and try again.
      await ports.research.reopenSynthesis(job.requestedById, runId, failure.code);
    },
  };

  return {
    REPOSITORY_INDEX: ingestion,
    CODE_ANALYSIS: analysis,
    FINDINGS_GENERATION: findings,
    RESEARCH_DISCOVERY: researchDiscovery,
    RESEARCH_SYNTHESIS: researchSynthesis,
  };
}
