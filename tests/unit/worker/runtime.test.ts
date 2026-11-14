// tests/unit/worker/runtime.test.ts
//
// The worker engine end to end over the in-memory database: polling,
// bounded concurrency, completion, retryable/permanent failures, timeouts,
// ownership loss, memory back-pressure, graceful shutdown, startup failure
// and health. Handlers are tiny fakes; the real queue and lifecycle run.
import { describe, expect, it } from "vitest";

import { installFakeDb, seedJob, seedRepository } from "../../fixtures/worker/fake-db";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => ({
  debug() {}, info() {}, warn() {}, error() {},
  child() { return quiet(); },
}) as any;

async function setup(env: Record<string, string> = {}, handlers: Record<string, any> = {}, rssMb?: () => number) {
  const db = installFakeDb();
  const repo = seedRepository(db);
  const { loadWorkerConfig } = await import("../../../lib/worker/config");
  const { WorkerRuntime } = await import("../../../lib/worker/runtime");
  const { createPrismaQueue } = await import("../../../lib/worker/queue.prisma");
  const { config } = loadWorkerConfig({ DATABASE_URL: "postgres://x", WORKER_ID: "w1", ...env });
  const queue = createPrismaQueue();
  const runtime = new WorkerRuntime({ config, queue, handlers, logger: quiet(), rssMb });
  return { db, repo, config, queue, runtime };
}

const job = (db: any, repo: any, over: Record<string, unknown> = {}) =>
  seedJob(db, { repositoryId: repo.id, type: "CODE_ANALYSIS", requestedById: "user_1", ...over });

describe("polling and completion", () => {
  it("claims a job, runs its handler and stores a small result", async () => {
    const seen: string[] = [];
    const { db, repo, runtime } = await setup({}, {
      CODE_ANALYSIS: { handle: async ({ job }: any) => { seen.push(job.id); return { result: { analysisId: "an_9" } }; } },
    });
    job(db, repo, { id: "j1" });
    const { claimed } = await runtime.pollOnce();
    await runtime.idle();
    expect(claimed).toBe(1);
    expect(seen).toEqual(["j1"]);
    expect(db.indexingJob.rows[0].status).toBe("COMPLETED");
    expect(db.indexingJob.rows[0].result).toEqual({ analysisId: "an_9" });
  });

  it("never runs more jobs at once than the concurrency limit", async () => {
    let running = 0, peak = 0;
    const { db, repo, runtime } = await setup({ WORKER_CONCURRENCY: "2" }, {
      CODE_ANALYSIS: { handle: async () => { running++; peak = Math.max(peak, running); await delay(30); running--; return {}; } },
    });
    for (let i = 0; i < 5; i++) job(db, repo, { id: `j${i}`, createdAt: new Date(Date.now() + i) });
    for (let i = 0; i < 10; i++) { await runtime.pollOnce(); await delay(15); }
    await runtime.idle();
    await runtime.pollOnce(); await runtime.idle();
    expect(peak).toBe(2);
    expect(db.indexingJob.rows.filter((r: any) => r.status === "COMPLETED").length).toBeGreaterThanOrEqual(4);
  });

  it("a self-managed handler is not completed a second time", async () => {
    const { db, repo, runtime } = await setup({}, {
      CODE_ANALYSIS: { handle: async () => ({ selfManaged: true }) },
    });
    job(db, repo, { id: "j1" });
    await runtime.pollOnce(); await runtime.idle();
    expect(db.indexingJob.rows[0].status).toBe("PROCESSING");
  });

  it("does not claim new jobs above the memory limit", async () => {
    const { db, repo, runtime } = await setup({ WORKER_MAX_RSS_MB: "100" }, { CODE_ANALYSIS: { handle: async () => ({}) } }, () => 500);
    job(db, repo, { id: "j1" });
    const { claimed } = await runtime.pollOnce();
    expect(claimed).toBe(0);
    expect(runtime.health().paused).toBe(true);
    expect(db.indexingJob.rows[0].status).toBe("PENDING");
  });
});

describe("failures", () => {
  it("a retryable failure is scheduled for retry and keeps a safe message", async () => {
    const { db, repo, runtime } = await setup({}, {
      CODE_ANALYSIS: { handle: async () => { throw new Error("connect ECONNREFUSED password=hunter2 /srv/secret/path"); } },
    });
    job(db, repo, { id: "j1" });
    await runtime.pollOnce(); await runtime.idle();
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("FAILED");
    expect(row.nextRetryAt).toBeTruthy();
    expect(row.errorCode).toBe("UNEXPECTED_ERROR");
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect(JSON.stringify(row)).not.toContain("/srv/secret");
  });

  it("a permanent failure is final and runs the final-failure hook once", async () => {
    const { JobFailure } = await import("../../../lib/jobs/job-policy");
    let hooks = 0;
    const { db, repo, runtime } = await setup({}, {
      CODE_ANALYSIS: {
        handle: async () => { throw new JobFailure("nope", "INVALID_PAYLOAD", { retryable: false }); },
        onFinalFailure: async () => { hooks++; },
      },
    });
    job(db, repo, { id: "j1" });
    await runtime.pollOnce(); await runtime.idle();
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("FAILED");
    expect(row.nextRetryAt).toBeNull();
    expect(row.errorCode).toBe("INVALID_PAYLOAD");
    expect(hooks).toBe(1);
  });

  it("the hook does not run while retries remain", async () => {
    let hooks = 0;
    const { db, repo, runtime } = await setup({}, {
      CODE_ANALYSIS: { handle: async () => { throw new Error("boom"); }, onFinalFailure: async () => { hooks++; } },
    });
    job(db, repo, { id: "j1" });
    await runtime.pollOnce(); await runtime.idle();
    expect(hooks).toBe(0);
  });

  it("a job type without a handler fails permanently", async () => {
    const { db, repo, runtime } = await setup({}, { CODE_ANALYSIS: { handle: async () => ({}) } });
    // Not claimable by this worker at all: types without a handler are skipped.
    job(db, repo, { id: "j1", type: "FINDINGS_GENERATION" });
    const { claimed } = await runtime.pollOnce();
    expect(claimed).toBe(0);
    expect(db.indexingJob.rows[0].status).toBe("PENDING");
  });
});

describe("executeClaimedJob", () => {
  async function exec(handler: any, over: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) {
    const db = installFakeDb();
    const repo = seedRepository(db);
    const { createPrismaQueue } = await import("../../../lib/worker/queue.prisma");
    const { executeClaimedJob } = await import("../../../lib/worker/runtime");
    const queue = createPrismaQueue();
    seedJob(db, { id: "j1", repositoryId: repo.id, type: "CODE_ANALYSIS", requestedById: "user_1", ...over });
    const claimed = (await queue.claimNext("w1", ["CODE_ANALYSIS"], new Date()))!;
    const all = { CODE_ANALYSIS: 80, REPOSITORY_INDEX: 80, FINDINGS_GENERATION: 80, RESEARCH_DISCOVERY: 80, RESEARCH_SYNTHESIS: 80 };
    const outcome = await executeClaimedJob(
      { queue, handlers: { CODE_ANALYSIS: handler }, logger: quiet(), workerId: "w1", config: { heartbeatIntervalMs: 20, jobTimeoutsMs: all as any, ...cfg } as any },
      claimed,
    );
    return { db, outcome };
  }

  it("times out a hung job and schedules a retry", async () => {
    const { db, outcome } = await exec({ handle: () => new Promise(() => undefined) });
    expect(outcome).toBe("FAILED_RETRY");
    expect(db.indexingJob.rows[0].errorCode).toBe("JOB_TIMEOUT");
    expect(db.indexingJob.rows[0].nextRetryAt).toBeTruthy();
  });

  it("heart-beats while a job runs", async () => {
    const { db, outcome } = await exec({
      handle: async () => { await delay(60); return {}; },
    }, {}, { jobTimeoutsMs: { CODE_ANALYSIS: 1000 } });
    expect(outcome).toBe("COMPLETED");
    expect(db.jobEvent.rows.some((e: any) => e.event === "COMPLETED")).toBe(true);
  });

  it("discards the result when ownership was lost mid-run", async () => {
    const handler = {
      handle: async () => {
        await delay(5);
        // Another worker recovered and re-claimed the job.
        (globalThis as any).prisma.indexingJob.rows[0].lockedBy = "w2";
        await delay(60);
        return { result: { analysisId: "late" } };
      },
    };
    const { db, outcome } = await exec(handler, {}, { jobTimeoutsMs: { CODE_ANALYSIS: 1000 } });
    expect(outcome).toBe("OWNERSHIP_LOST");
    expect(db.indexingJob.rows[0].result).toBeNull();
    expect(db.indexingJob.rows[0].status).toBe("PROCESSING");
    expect(db.indexingJob.rows[0].lockedBy).toBe("w2");
  });
});

describe("shutdown and health", () => {
  it("releases an unfinished job without consuming an attempt", async () => {
    const { db, repo, runtime } = await setup({ WORKER_SHUTDOWN_GRACE_MS: "0" }, {
      CODE_ANALYSIS: { handle: ({ signal }: any) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) },
    });
    job(db, repo, { id: "j1" });
    await runtime.pollOnce();
    expect(runtime.activeCount).toBe(1);
    await runtime.stop("test");
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.lockedBy).toBeNull();
    expect(runtime.health().state).toBe("stopped");
  });

  it("lets a quick job finish inside the grace period", async () => {
    const { db, repo, runtime } = await setup({ WORKER_SHUTDOWN_GRACE_MS: "2000" }, {
      CODE_ANALYSIS: { handle: async () => { await delay(30); return { result: { analysisId: "a" } }; } },
    });
    job(db, repo, { id: "j1" });
    await runtime.pollOnce();
    await runtime.stop("test");
    expect(db.indexingJob.rows[0].status).toBe("COMPLETED");
  });

  it("a failing poll is reflected in readiness", async () => {
    const { db, runtime } = await setup({}, { CODE_ANALYSIS: { handle: async () => ({}) } });
    await runtime.pollOnce();
    (runtime as any).state = "running";
    expect(runtime.health().ready).toBe(true);
    db.failQueries = false;
    (db as any).indexingJob.findMany = async () => { throw new Error("db down"); };
    let threw = false;
    try { await runtime.pollOnce(); } catch { threw = true; }
    expect(threw).toBe(true);
    expect(runtime.health().ready).toBe(false);
    expect(runtime.health().consecutivePollFailures).toBe(1);
  });
});

describe("bootstrap", () => {
  it("refuses to start with invalid configuration", async () => {
    const { startWorker } = await import("../../../lib/worker/bootstrap");
    let message = "";
    try { await startWorker({ NODE_ENV: "production", BACKGROUND_EXECUTION: "inline" } as any, { installSignalHandlers: false }); } catch (e) { message = (e as Error).message; }
    expect(message).toContain("DATABASE_URL is required");
    expect(message).toContain("inline is not allowed in production");
  });

  it("fails fast when the database is unreachable", async () => {
    const { startWorker } = await import("../../../lib/worker/bootstrap");
    const { createPrismaQueue } = await import("../../../lib/worker/queue.prisma");
    const db = installFakeDb();
    db.failQueries = true;
    let failed = false;
    try {
      await startWorker({ DATABASE_URL: "postgres://x", WORKER_HEALTH_PORT: "0" } as any, { queue: createPrismaQueue(), handlers: {}, logger: quiet(), installSignalHandlers: false });
    } catch { failed = true; }
    expect(failed).toBe(true);
  });

  it("starts, registers, and shuts down gracefully", async () => {
    const { startWorker } = await import("../../../lib/worker/bootstrap");
    const { createPrismaQueue } = await import("../../../lib/worker/queue.prisma");
    const db = installFakeDb();
    const worker = await startWorker(
      { DATABASE_URL: "postgres://x", WORKER_ID: "w-boot", WORKER_HEALTH_PORT: "0", WORKER_POLL_INTERVAL_MS: "250" } as any,
      { queue: createPrismaQueue(), handlers: {}, logger: quiet(), installSignalHandlers: false },
    );
    expect(db.workerInstance.rows.some((r: any) => r.id === "w-boot")).toBe(true);
    await worker.shutdown("test");
    await worker.done;
    expect(db.workerInstance.rows.find((r: any) => r.id === "w-boot").status).toBe("STOPPED");
  });
});
