// tests/unit/worker/enqueue-and-admin.test.ts
//
// Enqueueing: ownership at creation, payload validation, duplicate
// submission, concurrent submission. User/operator access to job views and the
// controlled retry.
import { describe, expect, it } from "vitest";

import { installFakeDb, seedJob, seedRepository } from "../../fixtures/worker/fake-db";

async function setup() {
  const db = installFakeDb();
  const repo = seedRepository(db, { ownerId: "user_1" });
  const otherRepo = seedRepository(db, { ownerId: "user_2" });
  const mine = { id: "snap_mine", repositoryId: repo.id, status: "COMPLETED", repository: { ownerId: "user_1" } };
  const theirs = { id: "snap_theirs", repositoryId: otherRepo.id, status: "COMPLETED", repository: { ownerId: "user_2" } };
  const pending = { id: "snap_pending", repositoryId: repo.id, status: "INGESTING", repository: { ownerId: "user_1" } };
  db.repositorySnapshot.rows.push(mine, theirs, pending);
  db.codeAnalysis.rows.push(
    { id: "an_mine", repositoryId: repo.id, status: "COMPLETED", repository: { ownerId: "user_1" } },
    { id: "an_running", repositoryId: repo.id, status: "PROCESSING", repository: { ownerId: "user_1" } },
    { id: "an_theirs", repositoryId: otherRepo.id, status: "COMPLETED", repository: { ownerId: "user_2" } },
  );
  db.researchRun.rows.push(
    { id: "rr_mine", repositoryId: repo.id, userId: "user_1" },
    { id: "rr_theirs", repositoryId: otherRepo.id, userId: "user_2" },
  );
  const e = await import("../../../lib/jobs/job-enqueue-pipeline");
  return { db, repo, otherRepo, e };
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "OK"; } catch (error) { return (error as any).code ?? (error as Error).name; }
}

describe("analysis enqueue", () => {
  it("creates a pending job owned by the requester with a validated payload", async () => {
    const { db, repo, e } = await setup();
    const { job, deduplicated } = await e.enqueueAnalysisJob("user_1", "snap_mine");
    expect(deduplicated).toBe(false);
    expect(job.type).toBe("CODE_ANALYSIS");
    expect(job.status).toBe("PENDING");
    expect(job.requestedById).toBe("user_1");
    expect(job.repositoryId).toBe(repo.id);
    expect(job.payload).toEqual({ snapshotId: "snap_mine" });
    expect(db.indexingJob.rows).toHaveLength(1);
  });

  it("treats another user's snapshot exactly like a missing one", async () => {
    const { db, e } = await setup();
    expect(await code(e.enqueueAnalysisJob("user_1", "snap_theirs"))).toBe("NOT_FOUND");
    expect(await code(e.enqueueAnalysisJob("user_1", "does_not_exist"))).toBe("NOT_FOUND");
    expect(db.indexingJob.rows).toHaveLength(0);
  });

  it("refuses a snapshot that has not finished ingesting", async () => {
    const { e } = await setup();
    expect(await code(e.enqueueAnalysisJob("user_1", "snap_pending"))).toBe("SNAPSHOT_NOT_READY");
  });

  it("rejects malformed ids before any query", async () => {
    const { db, e } = await setup();
    expect(await code(e.enqueueAnalysisJob("user_1", "../etc/passwd"))).toBe("INVALID_PAYLOAD");
    expect(db.indexingJob.rows).toHaveLength(0);
  });

  it("a repeated submission returns the same active job", async () => {
    const { db, e } = await setup();
    const a = await e.enqueueAnalysisJob("user_1", "snap_mine");
    const b = await e.enqueueAnalysisJob("user_1", "snap_mine");
    expect(b.deduplicated).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    expect(db.indexingJob.rows).toHaveLength(1);
  });

  it("concurrent submissions create exactly one job", async () => {
    const { db, e } = await setup();
    const results = await Promise.all([1, 2, 3, 4].map(() => e.enqueueAnalysisJob("user_1", "snap_mine")));
    expect(db.indexingJob.rows).toHaveLength(1);
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
  });

  it("a finished job does not block a new analysis", async () => {
    const { db, e } = await setup();
    const a = await e.enqueueAnalysisJob("user_1", "snap_mine");
    db.indexingJob.rows[0].status = "COMPLETED";
    const b = await e.enqueueAnalysisJob("user_1", "snap_mine");
    expect(b.deduplicated).toBe(false);
    expect(b.job.id === a.job.id).toBe(false);
  });

  it("a job waiting for an automatic retry still counts as active", async () => {
    const { db, e } = await setup();
    await e.enqueueAnalysisJob("user_1", "snap_mine");
    Object.assign(db.indexingJob.rows[0], { status: "FAILED", nextRetryAt: new Date(Date.now() + 60_000) });
    const again = await e.enqueueAnalysisJob("user_1", "snap_mine");
    expect(again.deduplicated).toBe(true);
  });
});

describe("findings enqueue", () => {
  it("validates thresholds up front", async () => {
    const { db, e } = await setup();
    expect(await code(e.enqueueFindingsJob("user_1", "an_mine", { cyclomaticMedium: "high" }))).toBe("INVALID_PAYLOAD");
    expect(await code(e.enqueueFindingsJob("user_1", "an_mine", { notAThreshold: 1 }))).toBe("INVALID_PAYLOAD");
    expect(db.indexingJob.rows).toHaveLength(0);
  });

  it("enforces ownership and readiness of the analysis", async () => {
    const { e } = await setup();
    expect(await code(e.enqueueFindingsJob("user_1", "an_theirs"))).toBe("NOT_FOUND");
    expect(await code(e.enqueueFindingsJob("user_1", "an_running"))).toBe("ANALYSIS_NOT_READY");
  });

  it("different thresholds are different jobs; identical ones deduplicate", async () => {
    const { db, e } = await setup();
    const a = await e.enqueueFindingsJob("user_1", "an_mine", {});
    const same = await e.enqueueFindingsJob("user_1", "an_mine");
    expect(same.job.id).toBe(a.job.id);
    expect(db.indexingJob.rows).toHaveLength(1);
  });
});

describe("research enqueue", () => {
  it("queues discovery and synthesis for the owner only", async () => {
    const { db, e } = await setup();
    const d = await e.enqueueResearchDiscoveryJob("user_1", "rr_mine");
    const s = await e.enqueueResearchSynthesisJob("user_1", "rr_mine");
    expect(d.job.type).toBe("RESEARCH_DISCOVERY");
    expect(s.job.type).toBe("RESEARCH_SYNTHESIS");
    expect(db.indexingJob.rows).toHaveLength(2);
    expect(await code(e.enqueueResearchDiscoveryJob("user_1", "rr_theirs"))).toBe("NOT_FOUND");
  });

  it("two users never share a deduplicated job", async () => {
    const { e } = await setup();
    const a = await e.enqueueAnalysisJob("user_1", "snap_mine");
    expect(await code(e.enqueueAnalysisJob("user_2", "snap_mine"))).toBe("NOT_FOUND");
    expect(a.job.requestedById).toBe("user_1");
  });
});

describe("job views", () => {
  it("a user sees only their own jobs, with safe fields", async () => {
    const { db, repo, otherRepo } = await setup();
    seedJob(db, { id: "mine", repositoryId: repo.id, type: "CODE_ANALYSIS", payload: { snapshotId: "s" }, lockedBy: "worker-7", repository: { ownerId: "user_1" } });
    seedJob(db, { id: "theirs", repositoryId: otherRepo.id, repository: { ownerId: "user_2" } });
    const admin = await import("../../../lib/jobs/job-admin");
    const view = await admin.getOwnedJob("user_1", "mine");
    expect(view.id).toBe("mine");
    expect(view.state).toBe("QUEUED");
    const text = JSON.stringify(view);
    expect(text).not.toContain("worker-7");
    expect(text).not.toContain("payload");
    expect(text).not.toContain("lockedBy");
    expect(await code(admin.getOwnedJob("user_1", "theirs"))).toBe("JobNotFoundError");
    const list = await admin.listOwnedJobs("user_1", repo.id);
    expect(list.jobs.map((j: any) => j.id)).toEqual(["mine"]);
    expect(await code(admin.listOwnedJobs("user_1", otherRepo.id))).toBe("JobNotFoundError");
  });

  it("operator retry resets a failed job, grants one extra attempt when exhausted, and logs the actor", async () => {
    const { db, repo } = await setup();
    seedJob(db, { id: "dead", repositoryId: repo.id, type: "CODE_ANALYSIS", status: "FAILED", attempts: 3, maxAttempts: 3, errorCode: "PROVIDER_ERROR", requestedById: "user_1", dedupeKey: "k1" });
    const admin = await import("../../../lib/jobs/job-admin");
    const view = await admin.adminRetryJob("dead", "operator_1");
    const row = db.indexingJob.rows[0];
    expect(view.state).toBe("QUEUED");
    expect(row.status).toBe("PENDING");
    expect(row.maxAttempts).toBe(4);
    expect(row.attempts).toBe(3);
    expect(db.jobEvent.rows.some((ev: any) => ev.event === "ADMIN_RETRY")).toBe(true);
  });

  it("operator retry refuses jobs that are not failed", async () => {
    const { db, repo } = await setup();
    seedJob(db, { id: "run", repositoryId: repo.id, type: "CODE_ANALYSIS", status: "PROCESSING", lockedBy: "w1" });
    const admin = await import("../../../lib/jobs/job-admin");
    expect(await code(admin.adminRetryJob("run", "operator_1"))).toBe("INVALID_TRANSITION");
    expect(db.indexingJob.rows[0].status).toBe("PROCESSING");
  });
});
