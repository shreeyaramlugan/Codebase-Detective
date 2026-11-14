// lib/worker/runtime.ts
//
// The worker execution engine: poll loop, bounded concurrency, heartbeats,
// timeouts, retry/failure recording, stale-job recovery and graceful shutdown.
//
// It depends only on a queue port and job handlers, so every reliability rule
// is unit-testable without a database. Business logic lives in the handlers,
// which call the existing Sprint 02/03/05/06/07 services.
import { JobTransitionError } from "@/lib/jobs/job-errors";
import { JobFailure } from "@/lib/jobs/job-policy";
import type { ClaimedJob, RecoveryOutcome } from "@/lib/jobs/job-queue";
import type { JobType } from "@/lib/jobs/job-types";

import type { WorkerConfig } from "./config";
import { newCorrelationId, type Logger } from "./logger";

export interface WorkerQueuePort {
  promoteDueRetries(now: Date): Promise<number>;
  claimNext(workerId: string, types: readonly JobType[], now: Date): Promise<ClaimedJob | null>;
  heartbeat(jobId: string, workerId: string, now: Date): Promise<boolean>;
  complete(job: ClaimedJob, workerId: string, result: unknown): Promise<void>;
  fail(
    job: ClaimedJob,
    workerId: string,
    failure: { code: string; message: string; retryable: boolean; retryAfterMs?: number | null },
  ): Promise<void>;
  release(job: ClaimedJob, workerId: string): Promise<boolean>;
  recoverStale(now: Date, staleAfterMs: number): Promise<RecoveryOutcome>;
  register(info: { id: string; concurrency: number; startedAt: Date }): Promise<void>;
  workerHeartbeat(
    id: string,
    state: { status: "RUNNING" | "DRAINING"; activeJobs: number; now: Date },
  ): Promise<void>;
  markStopped(id: string, now: Date): Promise<void>;
  checkDatabase(): Promise<void>;
}

export interface HandlerContext {
  job: ClaimedJob;
  workerId: string;
  signal: AbortSignal;
  log: Logger;
}

export interface HandlerResult {
  /** Small id references stored on the job (snapshotId, analysisId, ...). */
  result?: Record<string, unknown>;
  /** The service already recorded the final job state itself. */
  selfManaged?: boolean;
}

export interface JobHandler {
  handle(ctx: HandlerContext): Promise<HandlerResult>;
  /** Called once when a job can no longer be retried (permanent or exhausted). */
  onFinalFailure?(job: ClaimedJob, failure: { code: string; message: string }): Promise<void>;
}

export type HandlerRegistry = Partial<Record<JobType, JobHandler>>;

export type ExecutionOutcome =
  | "COMPLETED"
  | "SELF_MANAGED"
  | "FAILED_RETRY"
  | "FAILED_FINAL"
  | "OWNERSHIP_LOST"
  | "RELEASED";

export interface ExecutionDeps {
  queue: WorkerQueuePort;
  handlers: HandlerRegistry;
  logger: Logger;
  config: Pick<WorkerConfig, "heartbeatIntervalMs" | "jobTimeoutsMs">;
  workerId: string;
  now?: () => Date;
  /** Observed by the runtime so shutdown can abort and release running jobs. */
  onController?: (jobId: string, controller: AbortController) => void;
}

/** Message shown to users; never includes internals. */
const GENERIC_FAILURE = "The job failed unexpectedly.";

function safeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | null;
} {
  if (error instanceof JobFailure) {
    return {
      code: error.code.slice(0, 100),
      message: error.message.slice(0, 500),
      retryable: error.retryable,
      retryAfterMs: error.options.retryAfterMs ?? null,
    };
  }
  return { code: "UNEXPECTED_ERROR", message: GENERIC_FAILURE, retryable: true };
}

/**
 * Execute one already-claimed job. Shared by the worker loop and by inline
 * (development) execution so both follow exactly the same rules.
 */
export async function executeClaimedJob(
  deps: ExecutionDeps,
  job: ClaimedJob,
): Promise<ExecutionOutcome> {
  const now = deps.now ?? (() => new Date());
  const correlationId = newCorrelationId();
  const log = deps.logger.child({
    jobId: job.id,
    jobType: job.type,
    attempt: job.attempts,
    correlationId,
  });
  const handler = deps.handlers[job.type as JobType];
  const controller = new AbortController();
  deps.onController?.(job.id, controller);

  let lostOwnership = false;
  let timedOut = false;
  const startedAt = Date.now();

  const heartbeat = setInterval(() => {
    deps.queue
      .heartbeat(job.id, deps.workerId, now())
      .then((owned) => {
        if (!owned && !lostOwnership) {
          lostOwnership = true;
          log.warn("job ownership lost; aborting", { event: "ownership_lost" });
          controller.abort(new Error("OWNERSHIP_LOST"));
        }
      })
      .catch((error) => log.warn("heartbeat failed", { event: "heartbeat_failed", error }));
  }, deps.config.heartbeatIntervalMs);

  const timeoutMs = deps.config.jobTimeoutsMs[job.type as JobType];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("TIMEOUT"));
      reject(new JobFailure("The job took too long and was stopped.", "JOB_TIMEOUT", { retryable: true }));
    }, timeoutMs);
  });
  timeout.catch(() => undefined); // never an unhandled rejection

  log.info("job started", { event: "job_started", timeoutMs });

  try {
    if (!handler) {
      throw new JobFailure("This job type is not supported by this worker.", "UNSUPPORTED_JOB_TYPE", {
        retryable: false,
      });
    }

    const outcome = await Promise.race([
      handler.handle({ job, workerId: deps.workerId, signal: controller.signal, log }),
      timeout,
    ]);

    if (lostOwnership) {
      log.warn("job finished after ownership was lost; result discarded", { event: "result_discarded" });
      return "OWNERSHIP_LOST";
    }

    if (outcome.selfManaged) {
      log.info("job finished", { event: "job_finished", durationMs: Date.now() - startedAt, selfManaged: true });
      return "SELF_MANAGED";
    }

    await deps.queue.complete(job, deps.workerId, outcome.result ?? null);
    log.info("job completed", { event: "job_completed", durationMs: Date.now() - startedAt });
    return "COMPLETED";
  } catch (error) {
    if (lostOwnership) return "OWNERSHIP_LOST";
    if (controller.signal.aborted && !timedOut && String(controller.signal.reason?.message) === "SHUTDOWN") {
      return "RELEASED";
    }

    const failure = timedOut
      ? { code: "JOB_TIMEOUT", message: "The job took too long and was stopped.", retryable: true, retryAfterMs: null }
      : safeFailure(error);

    const final = !failure.retryable || job.attempts >= job.maxAttempts;
    log[final ? "error" : "warn"]("job failed", {
      event: "job_failed",
      code: failure.code,
      retryable: failure.retryable,
      final,
      durationMs: Date.now() - startedAt,
      // The raw error is sanitised by the logger; it is never stored on the job.
      error: error instanceof JobFailure ? undefined : error,
    });

    try {
      await deps.queue.fail(job, deps.workerId, failure);
    } catch (recordError) {
      if (recordError instanceof JobTransitionError) {
        log.warn("could not record failure: job state changed", { event: "fail_not_recorded", code: recordError.code });
        return "OWNERSHIP_LOST";
      }
      throw recordError;
    }

    if (final && handler?.onFinalFailure) {
      try {
        await handler.onFinalFailure(job, { code: failure.code, message: failure.message });
      } catch (hookError) {
        log.error("final-failure cleanup failed", { event: "final_failure_hook_failed", error: hookError });
      }
    }
    return final ? "FAILED_FINAL" : "FAILED_RETRY";
  } finally {
    clearInterval(heartbeat);
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ runtime */

export interface HealthStatus {
  workerId: string;
  state: "starting" | "running" | "draining" | "stopped";
  live: boolean;
  ready: boolean;
  activeJobs: number;
  concurrency: number;
  paused: boolean;
  consecutivePollFailures: number;
  lastPollAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  uptimeMs: number;
}

export interface RuntimeOptions {
  config: WorkerConfig;
  queue: WorkerQueuePort;
  handlers: HandlerRegistry;
  logger: Logger;
  now?: () => Date;
  /** Injectable for tests. */
  sleep?: (ms: number, wake: Promise<void>) => Promise<void>;
  rssMb?: () => number;
}

const defaultSleep = (ms: number, wake: Promise<void>) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    wake.then(() => {
      clearTimeout(t);
      resolve();
    });
  });

export class WorkerRuntime {
  private state: HealthStatus["state"] = "starting";
  private readonly active = new Map<string, { job: ClaimedJob; promise: Promise<unknown>; controller: AbortController }>();
  private stopRequested = false;
  private wake: () => void = () => undefined;
  private wakePromise: Promise<void>;
  private lastRecovery = 0;
  private lastWorkerHeartbeat = 0;
  private consecutiveFailures = 0;
  private lastPollAt: Date | null = null;
  private lastError: string | null = null;
  private paused = false;
  private startedAt: Date | null = null;
  private loop: Promise<void> | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? (() => new Date());
    this.wakePromise = new Promise((resolve) => (this.wake = resolve));
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Resolves once every currently running job has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    }
  }

  /** One poll cycle. Exposed so tests (and `start`) drive the same code. */
  async pollOnce(): Promise<{ claimed: number }> {
    const { config, queue, logger } = this.options;
    const now = this.now();
    let claimed = 0;

    try {
      if (now.getTime() - this.lastRecovery >= config.recoveryIntervalMs) {
        this.lastRecovery = now.getTime();
        const recovery = await queue.recoverStale(now, config.staleAfterMs);
        if (recovery.recovered > 0) {
          logger.warn("recovered stale jobs", { event: "stale_recovered", recovered: recovery.recovered });
        }
        for (const job of recovery.exhausted) {
          const handler = this.options.handlers[job.type as JobType];
          await handler?.onFinalFailure?.(job, {
            code: "WORKER_LOST",
            message: "The worker stopped responding while processing this job.",
          }).catch((error) => logger.error("final-failure cleanup failed", { event: "final_failure_hook_failed", error }));
        }
      }

      await queue.promoteDueRetries(now);

      if (this.stopRequested) return { claimed: 0 };

      const rss = this.options.rssMb ?? (() => process.memoryUsage().rss / 1_048_576);
      this.paused = config.maxRssMb > 0 && rss() > config.maxRssMb;
      if (this.paused) {
        logger.warn("memory limit reached; not claiming new jobs", { event: "paused_memory", maxRssMb: config.maxRssMb });
      }

      const types = config.enabledTypes.filter((t) => this.options.handlers[t]);
      while (!this.paused && !this.stopRequested && this.active.size < config.concurrency) {
        const job = await queue.claimNext(config.workerId, types, this.now());
        if (!job) break;
        claimed += 1;
        this.launch(job);
      }

      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastPollAt = this.now();
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.name : "UnknownError";
      logger.error("poll failed", { event: "poll_failed", error, consecutiveFailures: this.consecutiveFailures });
      throw error;
    }
    return { claimed };
  }

  private launch(job: ClaimedJob): void {
    const { config, queue, handlers, logger } = this.options;
    const controllerRef: { current?: AbortController } = {};
    const promise = executeClaimedJob(
      {
        queue,
        handlers,
        logger,
        config,
        workerId: config.workerId,
        now: this.now,
        onController: (_id, c) => {
          controllerRef.current = c;
          const entry = this.active.get(job.id);
          if (entry) entry.controller = c;
        },
      },
      job,
    )
      .catch((error) => logger.error("job execution crashed", { event: "execution_crashed", jobId: job.id, error }))
      .finally(() => {
        this.active.delete(job.id);
        this.wake();
        this.wakePromise = new Promise((resolve) => (this.wake = resolve));
      });
    this.active.set(job.id, { job, promise, controller: controllerRef.current ?? new AbortController() });
  }

  async start(): Promise<void> {
    const { config, queue, logger } = this.options;
    this.startedAt = this.now();
    await queue.checkDatabase();
    await queue.register({ id: config.workerId, concurrency: config.concurrency, startedAt: this.startedAt });
    this.state = "running";
    logger.info("worker started", {
      event: "worker_started",
      workerId: config.workerId,
      concurrency: config.concurrency,
      jobTypes: config.enabledTypes,
    });

    this.loop = this.run();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { config, queue, logger } = this.options;
    const sleep = this.options.sleep ?? defaultSleep;
    let backoff = config.pollIntervalMs;

    while (!this.stopRequested) {
      try {
        await this.pollOnce();
        backoff = config.pollIntervalMs;
      } catch {
        backoff = Math.min(30_000, backoff * 2);
      }

      const now = this.now();
      if (now.getTime() - this.lastWorkerHeartbeat >= config.heartbeatIntervalMs) {
        this.lastWorkerHeartbeat = now.getTime();
        await queue
          .workerHeartbeat(config.workerId, { status: "RUNNING", activeJobs: this.active.size, now })
          .catch((error) => logger.warn("worker heartbeat failed", { event: "worker_heartbeat_failed", error }));
      }

      if (this.stopRequested) break;
      // A finished job wakes the loop early so freed slots are filled quickly.
      await sleep(backoff, this.wakePromise);
    }
  }

  /** Stop claiming, let running jobs finish within the grace period, release the rest. */
  async stop(reason = "shutdown"): Promise<void> {
    if (this.state === "stopped" || this.state === "draining") return;
    const { config, queue, logger } = this.options;
    this.stopRequested = true;
    this.state = "draining";
    this.wake();
    logger.info("worker draining", { event: "worker_draining", reason, activeJobs: this.active.size });

    await queue
      .workerHeartbeat(config.workerId, { status: "DRAINING", activeJobs: this.active.size, now: this.now() })
      .catch(() => undefined);

    if (this.active.size > 0) {
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const grace = new Promise<"grace">((resolve) => {
        graceTimer = setTimeout(() => resolve("grace"), config.shutdownGraceMs);
      });
      const result = await Promise.race([this.idle().then(() => "idle" as const), grace]);
      if (graceTimer) clearTimeout(graceTimer);

      if (result === "grace") {
        for (const [jobId, entry] of [...this.active.entries()]) {
          entry.controller.abort(new Error("SHUTDOWN"));
          const released = await queue.release(entry.job, config.workerId).catch(() => false);
          logger.warn("released unfinished job on shutdown", { event: "job_released", jobId, released });
        }
      }
    }

    await this.loop?.catch(() => undefined);
    await queue.markStopped(config.workerId, this.now()).catch(() => undefined);
    this.state = "stopped";
    logger.info("worker stopped", { event: "worker_stopped" });
  }

  health(): HealthStatus {
    const { config } = this.options;
    const now = this.now();
    const sinceLastPoll = this.lastPollAt ? now.getTime() - this.lastPollAt.getTime() : null;
    const loopFresh =
      sinceLastPoll !== null && sinceLastPoll <= Math.max(config.pollIntervalMs * 4, 30_000 + config.pollIntervalMs);
    const live = this.state === "running" || this.state === "draining" ? loopFresh || this.state === "draining" : false;
    return {
      workerId: config.workerId,
      state: this.state,
      live,
      ready: this.state === "running" && this.consecutiveFailures === 0 && loopFresh,
      activeJobs: this.active.size,
      concurrency: config.concurrency,
      paused: this.paused,
      consecutivePollFailures: this.consecutiveFailures,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastError: this.lastError,
      startedAt: this.startedAt?.toISOString() ?? null,
      uptimeMs: this.startedAt ? now.getTime() - this.startedAt.getTime() : 0,
    };
  }
}
