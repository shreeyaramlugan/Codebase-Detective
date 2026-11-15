// tests/unit/worker/handlers.test.ts
//
// Pipeline handlers over fake ports: payload and ownership re-validation,
// idempotent re-runs, failure classification, and the rule that a failed
// downstream stage never marks an earlier one as failed.
import { describe, expect, it } from "vitest";

import { AnalysisError } from "../../../lib/analysis/analysis.errors";
import { FindingsError } from "../../../lib/findings/findings.errors";
import { ResearchError } from "../../../lib/research/research.errors";
import { JobFailure } from "../../../lib/jobs/job-policy";
import { createHandlers } from "../../../lib/worker/handlers";

const quiet = () => ({ debug() {}, info() {}, warn() {}, error() {}, child() { return quiet(); } }) as any;
const T0 = new Date("2026-11-10T10:00:00Z");

function makePorts(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const ports: any = {
    ingestion: {
      run: async () => ({ ok: true, snapshotId: "snap_1" }),
      attachResult: async (id: string, r: unknown) => { calls.push(`attach:${id}:${JSON.stringify(r)}`); },
    },
    analysis: {
      ownedSnapshotRepository: async () => "repo_1",
      listRunsSince: async () => [],
      failOrphans: async (ids: string[]) => { calls.push(`orphans:${ids.join(",")}`); },
      start: async () => { calls.push("analysis.start"); return { analysisId: "an_1", status: "COMPLETED", errorCode: null }; },
    },
    findings: {
      ownedAnalysisRepository: async () => "repo_1",
      listRunsSince: async () => [],
      failOrphans: async (ids: string[]) => { calls.push(`forphans:${ids.join(",")}`); },
      start: async () => { calls.push("findings.start"); return { runId: "fr_1", status: "COMPLETED", errorCode: null }; },
    },
    research: {
      ownedRunRepository: async () => "repo_1",
      discover: async () => { calls.push("discover"); return { status: "AWAITING_REVIEW" }; },
      synthesise: async () => { calls.push("synthesise"); return { status: "COMPLETED" }; },
      failDiscovery: async (_u: string, r: string, c: string) => { calls.push(`failDiscovery:${r}:${c}`); },
      reopenSynthesis: async (_u: string, r: string, c: string) => { calls.push(`reopen:${r}:${c}`); },
    },
  };
  for (const [k, v] of Object.entries(over)) ports[k] = { ...ports[k], ...v };
  return { ports, calls, handlers: createHandlers(ports) };
}

const baseJob = (over: Record<string, unknown> = {}) => ({
  id: "job_1", repositoryId: "repo_1", type: "CODE_ANALYSIS", requestedById: "user_1",
  payload: { snapshotId: "snap_1" }, createdAt: T0, attempts: 1, maxAttempts: 3, ...over,
}) as any;

async function run(handler: any, job: any) {
  try {
    return { ok: true as const, value: await handler.handle({ job, workerId: "w1", signal: new AbortController().signal, log: quiet() }) };
  } catch (error) {
    return { ok: false as const, error: error as JobFailure };
  }
}

describe("analysis handler", () => {
  it("runs the analysis service and returns the analysis id", async () => {
    const { handlers, calls } = makePorts();
    const r = await run(handlers.CODE_ANALYSIS, baseJob());
    expect(r.ok && r.value.result).toEqual({ analysisId: "an_1", status: "COMPLETED" });
    expect(calls).toContain("analysis.start");
  });

  it("reuses a finished run created since the job was queued (no duplicate analysis)", async () => {
    const { handlers, calls } = makePorts({ analysis: { listRunsSince: async () => [{ id: "an_done", status: "COMPLETED" }] } });
    const r = await run(handlers.CODE_ANALYSIS, baseJob());
    expect(r.ok && r.value.result).toEqual({ analysisId: "an_done", status: "COMPLETED" });
    expect(calls).not.toContain("analysis.start");
  });

  it("marks only in-flight runs of a crashed attempt as interrupted, then starts a new run", async () => {
    const { handlers, calls } = makePorts({
      analysis: { listRunsSince: async () => [{ id: "a_proc", status: "PROCESSING" }, { id: "a_failed", status: "FAILED" }] },
    });
    await run(handlers.CODE_ANALYSIS, baseJob());
    expect(calls).toContain("orphans:a_proc");
    expect(calls).toContain("analysis.start");
  });

  it("fails permanently when the snapshot is not the requester's", async () => {
    const { handlers, calls } = makePorts({ analysis: { ownedSnapshotRepository: async () => null } });
    const r = await run(handlers.CODE_ANALYSIS, baseJob());
    expect(!r.ok && r.error.code).toBe("NOT_FOUND");
    expect(!r.ok && r.error.retryable).toBe(false);
    expect(calls).not.toContain("analysis.start");
  });

  it("fails permanently when the target belongs to a different repository than the job", async () => {
    const { handlers } = makePorts({ analysis: { ownedSnapshotRepository: async () => "repo_other" } });
    const r = await run(handlers.CODE_ANALYSIS, baseJob());
    expect(!r.ok && r.error.code).toBe("OWNERSHIP_VIOLATION");
    expect(!r.ok && r.error.retryable).toBe(false);
  });

  it("fails permanently when the job has no requester", async () => {
    const { handlers } = makePorts();
    const r = await run(handlers.CODE_ANALYSIS, baseJob({ requestedById: null }));
    expect(!r.ok && r.error.code).toBe("OWNERSHIP_VIOLATION");
  });

  it("rejects a tampered payload before touching any service", async () => {
    const { handlers, calls } = makePorts();
    const r = await run(handlers.CODE_ANALYSIS, baseJob({ payload: { snapshotId: "../../x" } }));
    expect(!r.ok && r.error.code).toBe("INVALID_PAYLOAD");
    expect(!r.ok && r.error.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("classifies an engine failure by code: validation is permanent, others retry", async () => {
    const permanent = makePorts({ analysis: { start: async () => ({ analysisId: "a", status: "FAILED", errorCode: "GRAPH_VALIDATION_FAILED" }) } });
    const p = await run(permanent.handlers.CODE_ANALYSIS, baseJob());
    expect(!p.ok && p.error.retryable).toBe(false);
    const transient = makePorts({ analysis: { start: async () => ({ analysisId: "a", status: "FAILED", errorCode: "ANALYSIS_FAILED" }) } });
    const t = await run(transient.handlers.CODE_ANALYSIS, baseJob());
    expect(!t.ok && t.error.retryable).toBe(true);
  });

  it("maps service errors to safe job failures", async () => {
    const { handlers } = makePorts({ analysis: { start: async () => { throw new AnalysisError("not ready", "SNAPSHOT_NOT_READY"); } } });
    const r = await run(handlers.CODE_ANALYSIS, baseJob());
    expect(!r.ok && r.error.code).toBe("SNAPSHOT_NOT_READY");
    expect(!r.ok && r.error.retryable).toBe(false);
  });

  it("lets unexpected errors through untouched for the runtime to classify", async () => {
    const { handlers } = makePorts({ analysis: { start: async () => { throw new Error("ECONNRESET"); } } });
    const r = await run(handlers.CODE_ANALYSIS, baseJob());
    expect(!r.ok && r.error instanceof JobFailure).toBe(false);
  });
});

describe("findings handler", () => {
  const job = (over: Record<string, unknown> = {}) =>
    baseJob({ type: "FINDINGS_GENERATION", payload: { analysisId: "an_1" }, ...over });

  it("produces a findings run and returns its id", async () => {
    const { handlers } = makePorts();
    const r = await run(handlers.FINDINGS_GENERATION, job());
    expect(r.ok && r.value.result).toEqual({ findingsRunId: "fr_1", analysisId: "an_1", status: "COMPLETED" });
  });

  it("is idempotent for a completed run", async () => {
    const { handlers, calls } = makePorts({ findings: { listRunsSince: async () => [{ id: "fr_done", status: "PARTIAL" }] } });
    const r = await run(handlers.FINDINGS_GENERATION, job());
    expect(r.ok && (r.value.result as any).findingsRunId).toBe("fr_done");
    expect(calls).not.toContain("findings.start");
  });

  it("a failed findings run does not touch the analysis it was built from", async () => {
    const { handlers, calls } = makePorts({ findings: { start: async () => { throw new FindingsError("not ready", "ANALYSIS_NOT_READY"); } } });
    const r = await run(handlers.FINDINGS_GENERATION, job());
    expect(!r.ok && r.error.code).toBe("ANALYSIS_NOT_READY");
    // The only mutations the handler can perform are on findings runs.
    expect(calls.filter((c) => c.startsWith("analysis") || c.startsWith("orphans"))).toHaveLength(0);
  });

  it("revalidates ownership", async () => {
    const { handlers } = makePorts({ findings: { ownedAnalysisRepository: async () => null } });
    const r = await run(handlers.FINDINGS_GENERATION, job());
    expect(!r.ok && r.error.code).toBe("NOT_FOUND");
  });

  it("passes validated thresholds through", async () => {
    let seen: unknown;
    const { handlers } = makePorts({ findings: { start: async (_u: string, _a: string, t: unknown) => { seen = t; return { runId: "fr", status: "COMPLETED", errorCode: null }; } } });
    await run(handlers.FINDINGS_GENERATION, job({ payload: { analysisId: "an_1", thresholds: { cyclomaticMedium: 20 } } }));
    expect(seen).toEqual({ cyclomaticMedium: 20 });
  });
});

describe("ingestion handler", () => {
  const job = () => baseJob({ type: "REPOSITORY_INDEX", payload: null, targetCommitSha: null });

  it("is self-managed and attaches the snapshot reference", async () => {
    const { handlers, calls } = makePorts();
    const r = await run(handlers.REPOSITORY_INDEX, job());
    expect(r.ok && r.value.selfManaged).toBe(true);
    expect(calls.some((c) => c.includes('"snapshotId":"snap_1"'))).toBe(true);
  });

  it("does not attach anything when ingestion failed (the service recorded the failure)", async () => {
    const { handlers, calls } = makePorts({ ingestion: { run: async () => ({ ok: false, code: "GITHUB_RATE_LIMITED" }) } });
    const r = await run(handlers.REPOSITORY_INDEX, job());
    expect(r.ok && r.value.selfManaged).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("research handlers", () => {
  const disc = (over: Record<string, unknown> = {}) => baseJob({ type: "RESEARCH_DISCOVERY", payload: { runId: "run_1" }, ...over });
  const synth = (over: Record<string, unknown> = {}) => baseJob({ type: "RESEARCH_SYNTHESIS", payload: { runId: "run_1" }, ...over });

  it("runs discovery without failing the run itself on error (the queue decides)", async () => {
    const { handlers, calls } = makePorts({ research: { discover: async () => { throw new ResearchError("down", "PROVIDER_ERROR"); } } });
    const r = await run(handlers.RESEARCH_DISCOVERY, disc());
    expect(!r.ok && r.error.code).toBe("PROVIDER_ERROR");
    expect(!r.ok && r.error.retryable).toBe(true);
    expect(calls.some((c) => c.startsWith("failDiscovery"))).toBe(false);
  });

  it("treats quota and configuration errors as permanent", async () => {
    for (const code of ["LIMIT_EXCEEDED", "NOT_CONFIGURED", "INVALID_STATE", "CONTEXT_UNAVAILABLE"] as const) {
      const { handlers } = makePorts({ research: { synthesise: async () => { throw new ResearchError("x", code); } } });
      const r = await run(handlers.RESEARCH_SYNTHESIS, synth());
      expect(!r.ok && r.error.retryable).toBe(false);
    }
  });

  it("final discovery failure marks the run FAILED; final synthesis failure reopens review", async () => {
    const { handlers, calls } = makePorts();
    await handlers.RESEARCH_DISCOVERY!.onFinalFailure!(disc(), { code: "PROVIDER_ERROR", message: "x" });
    await handlers.RESEARCH_SYNTHESIS!.onFinalFailure!(synth(), { code: "AI_UNAVAILABLE", message: "x" });
    expect(calls).toContain("failDiscovery:run_1:DISCOVERY_FAILED");
    expect(calls).toContain("reopen:run_1:AI_UNAVAILABLE");
  });

  it("revalidates ownership of the run", async () => {
    const { handlers, calls } = makePorts({ research: { ownedRunRepository: async () => null } });
    const r = await run(handlers.RESEARCH_SYNTHESIS, synth());
    expect(!r.ok && r.error.code).toBe("NOT_FOUND");
    expect(calls).not.toContain("synthesise");
  });
});
