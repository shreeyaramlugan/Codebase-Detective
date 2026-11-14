// tests/unit/worker/research-async.test.ts
//
// The background split of research: prepare (no provider contact) ->
// discovery in a worker -> review -> begin synthesis (locks sources) ->
// synthesis in a worker, with the failure and idempotency rules the job
// handlers rely on. The synchronous startRun/synthesiseRun paths are covered
// by tests/unit/research-engine/research-run-service.test.ts.
import { describe, expect, it } from "vitest";

import { AIProviderError } from "../../../features/ai/providers/ai-provider";
import { ResearchError } from "../../../lib/research/research.errors";
import {
  beginSynthesis,
  failRunFinal,
  getRun,
  prepareRun,
  reopenReview,
  reviewSources,
  runPreparedDiscovery,
  runPreparedSynthesis,
  synthesiseRun,
} from "../../../lib/research/research.service";
import {
  FakeProvider,
  ScriptedProvider,
  jsonReply,
  makeRecord,
  makeResearchDeps,
} from "../../fixtures/research/fakes";

const USER = "u1";
const reply = () =>
  jsonReply({
    answerable: true,
    summary: "Cycles are discouraged.",
    recommendations: [
      {
        title: "Break the cycle",
        concise: "Extract shared code.",
        detail: "Move shared code into a third module.",
        repositoryEvidence: ["E1"],
        sources: [{ source: "S1", passage: 1 }],
      },
    ],
    conflicts: [],
    limitations: [],
  });

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (e) { return e instanceof ResearchError ? e.code : `other:${String(e)}`; }
  return "none";
}

describe("discovery in the background", () => {
  it("prepare reserves the run without contacting any provider or locking it", async () => {
    const source = new FakeProvider("official-docs", [makeRecord()]);
    const deps = makeResearchDeps({ providers: [source] });
    const run = await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    expect(run.status).toBe("DISCOVERING");
    expect(source.calls).toBe(0);
    expect(run.busyUntil ?? null).toBeNull();
    expect(run.queries.length).toBeGreaterThan(0);
  });

  it("prepare enforces the same validation and quota as the synchronous path", async () => {
    const deps = makeResearchDeps({}, { dailyRunLimit: 1 });
    expect(await code(prepareRun(deps, USER, "repo1", {}))).toBe("INVALID_INPUT");
    await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    expect(await code(prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false }))).toBe("LIMIT_EXCEEDED");
    expect(await code(prepareRun(deps, "u2", "repo1", { findingId: "fnd1" }))).toBe("NOT_FOUND");
  });

  it("the worker step discovers sources and moves the run to review", async () => {
    const deps = makeResearchDeps();
    const run = await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    const done = await runPreparedDiscovery(deps, USER, run.id, { failRunOnError: false });
    expect(done.status).toBe("AWAITING_REVIEW");
    expect((await getRun(deps, USER, run.id)).sources.length).toBeGreaterThan(0);
  });

  it("is a no-op when the run already left DISCOVERING (a retried job does not redo work)", async () => {
    const provider = new FakeProvider("official-docs", [makeRecord()]);
    const deps = makeResearchDeps({ providers: [provider] });
    const run = await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    await runPreparedDiscovery(deps, USER, run.id, { failRunOnError: false });
    const calls = provider.calls;
    const again = await runPreparedDiscovery(deps, USER, run.id, { failRunOnError: false });
    expect(again.status).toBe("AWAITING_REVIEW");
    expect(provider.calls).toBe(calls);
  });

  it("another user's run is indistinguishable from a missing one", async () => {
    const deps = makeResearchDeps();
    const run = await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    expect(await code(runPreparedDiscovery(deps, "u2", run.id, { failRunOnError: false }))).toBe("NOT_FOUND");
  });

  it("leaves the run DISCOVERING when the queue may retry, FAILED only when the job gave up", async () => {
    const deps = makeResearchDeps();
    const run = await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    const original = deps.store.saveDiscovery.bind(deps.store);
    deps.store.saveDiscovery = async () => { throw new Error("db blip"); };
    expect(await code(runPreparedDiscovery(deps, USER, run.id, { failRunOnError: false }))).toBe("PROVIDER_ERROR");
    expect((await getRun(deps, USER, run.id)).run.status).toBe("DISCOVERING");
    deps.store.saveDiscovery = original;
    // The retry succeeds from the same state.
    expect((await runPreparedDiscovery(deps, USER, run.id, { failRunOnError: false })).status).toBe("AWAITING_REVIEW");

    const second = await prepareRun(deps, USER, "repo1", { question: "How do we avoid circular imports?" }, { lock: false });
    await failRunFinal(deps, second.id, "DISCOVERY_FAILED");
    expect((await getRun(deps, USER, second.id)).run.status).toBe("FAILED");
  });
});

describe("synthesis in the background", () => {
  async function reviewed(provider = new ScriptedProvider(() => reply())) {
    const deps = makeResearchDeps({ provider });
    const run = await prepareRun(deps, USER, "repo1", { findingId: "fnd1" }, { lock: false });
    await runPreparedDiscovery(deps, USER, run.id, { failRunOnError: false });
    return { deps, provider, id: run.id };
  }

  it("begin locks the run so a second request is rejected and sources cannot change", async () => {
    const { deps, id } = await reviewed();
    const began = await beginSynthesis(deps, USER, id);
    expect(began.status).toBe("SYNTHESIZING");
    expect(await code(beginSynthesis(deps, USER, id))).toBe("BUSY");
    expect(await code(synthesiseRun(deps, USER, id))).toBe("INVALID_STATE");
    expect(await code(reviewSources(deps, USER, id, { included: { anything: false } }))).not.toBe("none");
  });

  it("the worker step produces recommendations and completes the run", async () => {
    const { deps, provider, id } = await reviewed();
    await beginSynthesis(deps, USER, id);
    const done = await runPreparedSynthesis(deps, USER, id);
    expect(done.status).toBe("COMPLETED");
    expect((await getRun(deps, USER, id)).recommendations).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
  });

  it("a retried job does not call the AI provider again once the run completed", async () => {
    const { deps, provider, id } = await reviewed();
    await beginSynthesis(deps, USER, id);
    await runPreparedSynthesis(deps, USER, id);
    await runPreparedSynthesis(deps, USER, id);
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses to synthesise a run that was never begun", async () => {
    const { deps, id } = await reviewed();
    expect(await code(runPreparedSynthesis(deps, USER, id))).toBe("INVALID_STATE");
  });

  it("a provider failure keeps the run SYNTHESIZING for the retry; reopening returns it to review", async () => {
    const failing = new ScriptedProvider(() => { throw new AIProviderError("Provider busy.", "RATE_LIMITED", { retryable: true, detail: "secret-key-123" }); });
    const { deps, id } = await reviewed(failing);
    await beginSynthesis(deps, USER, id);
    let message = "";
    try { await runPreparedSynthesis(deps, USER, id); } catch (e) { message = (e as Error).message; }
    expect(message).toBe("Provider busy.");
    expect(message).not.toMatch(/secret/);
    expect((await getRun(deps, USER, id)).run.status).toBe("SYNTHESIZING");

    await reopenReview(deps, id, "RATE_LIMITED");
    const after = await getRun(deps, USER, id);
    expect(after.run.status).toBe("AWAITING_REVIEW");
    // The person can try again.
    expect((await beginSynthesis(deps, USER, id)).status).toBe("SYNTHESIZING");
  });

  it("reopening only affects runs that are still SYNTHESIZING", async () => {
    const { deps, id } = await reviewed();
    await beginSynthesis(deps, USER, id);
    await runPreparedSynthesis(deps, USER, id);
    await reopenReview(deps, id, "LATE_HOOK");
    expect((await getRun(deps, USER, id)).run.status).toBe("COMPLETED");
  });
});
