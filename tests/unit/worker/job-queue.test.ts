// tests/unit/worker/job-queue.test.ts
//
// Queue + lifecycle behaviour against an in-memory database: atomic claiming,
// concurrent workers, retries and back-off, permanent failures, stale
// recovery, graceful release and ownership guards.
import { describe, expect, it } from "vitest";

import { installFakeDb, seedJob, seedRepository } from "../../fixtures/worker/fake-db";

async function setup() {
  const db = installFakeDb();
  const repo = seedRepository(db);
  const queue = await import("../../../lib/jobs/job-queue");
  const lifecycle = await import("../../../lib/jobs/job-lifecycle");
  return { db, repo, queue, lifecycle };
}

const T0 = new Date("2026-11-10T10:00:00Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);
const ALL = ["REPOSITORY_INDEX", "CODE_ANALYSIS", "FINDINGS_GENERATION", "RESEARCH_DISCOVERY", "RESEARCH_SYNTHESIS"] as any;

describe("claiming", () => {
  it("claims the oldest pending job and records ownership", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "newer", repositoryId: repo.id, createdAt: plus(1000) });
    seedJob(db, { id: "older", repositoryId: repo.id, createdAt: plus(0) });
    const job = await queue.claimNextJob("w1", ALL, T0);
    expect(job?.id).toBe("older");
    expect(job?.status).toBe("PROCESSING");
    expect(job?.lockedBy).toBe("w1");
    expect(job?.attempts).toBe(1);
    expect(job?.heartbeatAt?.getTime()).toBe(T0.getTime());
  });

  it("returns null when nothing is eligible", async () => {
    const { queue } = await setup();
    expect(await queue.claimNextJob("w1", ALL, T0)).toBeNull();
  });

  it("only claims enabled job types", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "a", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    expect(await queue.claimNextJob("w1", ["RESEARCH_SYNTHESIS"] as any, T0)).toBeNull();
    expect((await queue.claimNextJob("w1", ["CODE_ANALYSIS"] as any, T0))?.id).toBe("a");
  });

  it("two workers racing for one job: exactly one wins", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "only", repositoryId: repo.id });
    const results = await Promise.all([
      queue.claimNextJob("w1", ALL, T0),
      queue.claimNextJob("w2", ALL, T0),
      queue.claimNextJob("w3", ALL, T0),
    ]);
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(db.indexingJob.rows[0].attempts).toBe(1);
  });

  it("many workers and many jobs: every job is claimed exactly once", async () => {
    const { db, repo, queue } = await setup();
    for (let i = 0; i < 6; i++) seedJob(db, { id: `j${i}`, repositoryId: repo.id, createdAt: plus(i) });
    const claimedBy: Record<string, string[]> = {};
    await Promise.all(
      ["a", "b", "c"].map(async (w) => {
        for (;;) {
          const job = await queue.claimNextJob(w, ALL, T0);
          if (!job) return;
          (claimedBy[job.id] ??= []).push(w);
        }
      }),
    );
    expect(Object.keys(claimedBy)).toHaveLength(6);
    for (const owners of Object.values(claimedBy)) expect(owners).toHaveLength(1);
    expect(db.indexingJob.rows.every((r: any) => r.attempts === 1)).toBe(true);
  });

  it("does not claim a job whose retry time has not arrived", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "later", repositoryId: repo.id, nextRetryAt: plus(60_000) });
    expect(await queue.claimNextJob("w1", ALL, T0)).toBeNull();
    expect((await queue.claimNextJob("w1", ALL, plus(61_000)))?.id).toBe("later");
  });

  it("marks the repository INDEXING only for ingestion jobs", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "an", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    await queue.claimNextJob("w1", ALL, T0);
    expect(db.repository.rows[0].status).toBe("QUEUED");
  });
});

describe("completion and failure", () => {
  it("completes with a result and clears the lock", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    await queue.completeJobForWorker(job, "w1", { analysisId: "an_1" });
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("COMPLETED");
    expect(row.lockedBy).toBeNull();
    expect(row.result).toEqual({ analysisId: "an_1" });
  });

  it("a worker that does not own the job cannot complete it", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    let threw = false;
    try {
      await queue.completeJobForWorker(job, "intruder", { x: 1 });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(db.indexingJob.rows[0].status).toBe("PROCESSING");
  });

  it("a retryable failure schedules a retry with exponential back-off", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    const first = (await queue.claimNextJob("w1", ALL, T0))!;
    const before = Date.now();
    await queue.failJobForWorker(first, "w1", { code: "PROVIDER_ERROR", message: "x", retryable: true });
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("FAILED");
    expect(row.nextRetryAt).toBeTruthy();
    const delay = row.nextRetryAt.getTime() - before;
    expect(delay).toBeGreaterThanOrEqual(29_000);
    expect(delay).toBeLessThan(35_000);
  });

  it("a permanent failure is not retried", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    await queue.failJobForWorker(job, "w1", { code: "INVALID_PAYLOAD", message: "bad", retryable: false });
    expect(db.indexingJob.rows[0].nextRetryAt).toBeNull();
    expect(await queue.promoteDueRetries(plus(10 * 60_000))).toBe(0);
  });

  it("a provider Retry-After longer than the back-off is honoured, but capped", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS", maxAttempts: 5 });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    const before = Date.now();
    await queue.failJobForWorker(job, "w1", { code: "RATE_LIMITED", message: "x", retryable: true, retryAfterMs: 10 * 24 * 3_600_000 });
    const delay = db.indexingJob.rows[0].nextRetryAt.getTime() - before;
    expect(delay).toBeLessThan(15 * 60_000 + 2000);
    expect(delay).toBeGreaterThan(14 * 60_000);
  });

  it("stops retrying after the last attempt", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS", maxAttempts: 1 });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    await queue.failJobForWorker(job, "w1", { code: "PROVIDER_ERROR", message: "x", retryable: true });
    expect(db.indexingJob.rows[0].nextRetryAt).toBeNull();
  });

  it("a due retry is promoted to pending and claimed again with a higher attempt count", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    await queue.failJobForWorker(job, "w1", { code: "PROVIDER_ERROR", message: "x", retryable: true });
    expect(await queue.promoteDueRetries(plus(1000))).toBe(0);
    const later = new Date(Date.now() + 120_000);
    expect(await queue.promoteDueRetries(later)).toBe(1);
    const again = (await queue.claimNextJob("w2", ALL, later))!;
    expect(again.attempts).toBe(2);
    expect(again.lockedBy).toBe("w2");
  });
});

describe("stale recovery", () => {
  it("re-queues a job whose worker stopped heart-beating", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    await queue.claimNextJob("w1", ALL, T0);
    const out = await queue.recoverStaleJobs(plus(120_000), 90_000);
    expect(out.recovered).toBe(1);
    expect(out.exhausted).toHaveLength(0);
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("WORKER_LOST");
    expect(row.lockedBy).toBeNull();
    expect(await queue.promoteDueRetries(plus(120_001))).toBe(1);
  });

  it("leaves a job with a fresh heartbeat alone", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    const job = (await queue.claimNextJob("w1", ALL, T0))!;
    await queue.heartbeatJob(job.id, "w1", plus(100_000));
    const out = await queue.recoverStaleJobs(plus(120_000), 90_000);
    expect(out.recovered).toBe(0);
    expect(db.indexingJob.rows[0].status).toBe("PROCESSING");
  });

  it("reports a job abandoned on its final attempt as exhausted and does not retry it", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS", maxAttempts: 1 });
    await queue.claimNextJob("w1", ALL, T0);
    const out = await queue.recoverStaleJobs(plus(120_000), 90_000);
    expect(out.recovered).toBe(1);
    expect(out.exhausted).toHaveLength(1);
    expect(db.indexingJob.rows[0].nextRetryAt).toBeNull();
  });

  it("marks the repository FAILED when an ingestion job is lost", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id });
    await queue.claimNextJob("w1", ALL, T0);
    await queue.recoverStaleJobs(plus(120_000), 90_000);
    expect(db.repository.rows[0].status).toBe("FAILED");
  });

  it("a stale worker's late heartbeat is rejected once the job was reclaimed", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    await queue.claimNextJob("w1", ALL, T0);
    await queue.recoverStaleJobs(plus(120_000), 90_000);
    await queue.promoteDueRetries(plus(120_001));
    await queue.claimNextJob("w2", ALL, plus(120_002));
    expect(await queue.heartbeatJob("j", "w1", plus(130_000))).toBe(false);
    expect(await queue.heartbeatJob("j", "w2", plus(130_000))).toBe(true);
  });
});

describe("graceful release", () => {
  it("returns the job to pending without consuming an attempt", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    await queue.claimNextJob("w1", ALL, T0);
    expect(await queue.releaseJob("j", "w1")).toBe(true);
    const row = db.indexingJob.rows[0];
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.lockedBy).toBeNull();
  });

  it("refuses to release a job owned by another worker", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS" });
    await queue.claimNextJob("w1", ALL, T0);
    expect(await queue.releaseJob("j", "w2")).toBe(false);
    expect(db.indexingJob.rows[0].status).toBe("PROCESSING");
  });
});

describe("worker registry and history", () => {
  it("registers, heart-beats and stops a worker", async () => {
    const { db, queue } = await setup();
    await queue.registerWorker({ id: "w1", hostname: "h", pid: 1, version: "1", concurrency: 2, startedAt: T0 });
    await queue.workerHeartbeat("w1", { status: "RUNNING", activeJobs: 1, now: plus(5000) });
    expect(db.workerInstance.rows[0].status).toBe("RUNNING");
    await queue.markWorkerStopped("w1", plus(9000));
    expect(db.workerInstance.rows[0].status).toBe("STOPPED");
  });

  it("writes history events for claims and never stores payloads", async () => {
    const { db, repo, queue } = await setup();
    seedJob(db, { id: "j", repositoryId: repo.id, type: "CODE_ANALYSIS", payload: { snapshotId: "s" } });
    await queue.claimNextJob("w1", ALL, T0);
    const ev = db.jobEvent.rows[0];
    expect(ev.event).toBe("CLAIMED");
    expect(JSON.stringify(ev)).not.toContain("snapshotId");
  });
});
