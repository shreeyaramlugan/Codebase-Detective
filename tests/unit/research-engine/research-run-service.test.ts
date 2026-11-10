// tests/unit/research-engine/research-run-service.test.ts
import { describe, expect, it } from "vitest";

import { AIProviderError } from "../../../features/ai/providers/ai-provider";
import { ResearchError } from "../../../lib/research/research.errors";
import {
  deleteRun,
  getResearchUsage,
  getRun,
  listRuns,
  reviewSources,
  startRun,
  synthesiseRun,
  updateRecommendation,
  updateRun,
} from "../../../lib/research/research.service";
import {
  FINDING,
  FakeProvider,
  FakeResearchStore,
  ScriptedProvider,
  jsonReply,
  makeRecord,
  makeResearchDeps,
} from "../../fixtures/research/fakes";

const USER = "u1";
const OTHER = "u2";

const reply = (over: Record<string, unknown> = {}) =>
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
    ...over,
  });

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ResearchError ? error.code : `other:${String(error)}`;
  }
  return "none";
}

describe("starting a run", () => {
  it("discovers sources but never calls the AI provider", async () => {
    const provider = new ScriptedProvider(() => reply());
    const deps = makeResearchDeps({ provider });
    const out = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    expect(out.run.status).toBe("AWAITING_REVIEW");
    expect(out.run.ruleId).toBe("DEP003");
    expect(out.run.findingFingerprint).toBe(FINDING.fingerprint);
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.recommendations).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("records the snapshot, analysis and commit the research belongs to", async () => {
    const out = await startRun(makeResearchDeps(), USER, "repo1", { question: "How do we avoid circular imports?" });
    expect(out.run.snapshotId).toBe("snap1");
    expect(out.run.analysisId).toBe("an1");
    expect(out.run.commitSha).toBe("aaaaaaa1111111");
    expect(out.run.trigger).toBe("QUESTION");
  });

  it("requires exactly one of findingId or question", async () => {
    const deps = makeResearchDeps();
    expect(await code(startRun(deps, USER, "repo1", {}))).toBe("INVALID_INPUT");
    expect(await code(startRun(deps, USER, "repo1", { findingId: "fnd1", question: "How do we avoid cycles?" }))).toBe("INVALID_INPUT");
  });

  it("rejects unsupported findings and unusable questions", async () => {
    const deps = makeResearchDeps();
    deps.store.findings = [{ ...FINDING, ruleId: "DEP004" }];
    expect(await code(startRun(deps, USER, "repo1", { findingId: "fnd1" }))).toBe("UNSUPPORTED");
    expect(await code(startRun(deps, USER, "repo1", { question: "hi" }))).toBe("INVALID_INPUT");
  });

  it("is owner scoped: another user cannot research or read this repository's runs", async () => {
    const deps = makeResearchDeps();
    expect(await code(startRun(deps, OTHER, "repo1", { findingId: "fnd1" }))).toBe("NOT_FOUND");
    const out = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    expect(await code(getRun(deps, OTHER, out.run.id))).toBe("NOT_FOUND");
    expect(await code(updateRun(deps, OTHER, out.run.id, { title: "x" }))).toBe("NOT_FOUND");
    expect(await code(deleteRun(deps, OTHER, out.run.id))).toBe("NOT_FOUND");
    expect(await code(synthesiseRun(deps, OTHER, out.run.id))).toBe("NOT_FOUND");
    expect(await code(listRuns(deps, OTHER, "repo1"))).toBe("NOT_FOUND");
  });

  it("refuses a finding from a different repository", async () => {
    const deps = makeResearchDeps();
    deps.store.owners.set("repo2", USER);
    expect(await code(startRun(deps, USER, "repo2", { findingId: "fnd1" }))).toBe("NOT_FOUND");
  });

  it("reports a missing analysis as unavailable context", async () => {
    const deps = makeResearchDeps();
    deps.store.scope = null;
    expect(await code(startRun(deps, USER, "repo1", { question: "How do we avoid cycles?" }))).toBe("CONTEXT_UNAVAILABLE");
  });

  it("enforces the daily run limit", async () => {
    const deps = makeResearchDeps({}, { dailyRunLimit: 1 });
    await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    expect(await code(startRun(deps, USER, "repo1", { findingId: "fnd1" }))).toBe("LIMIT_EXCEEDED");
  });

  it("stops contacting providers when the daily provider-request cap is reached", async () => {
    const p = new FakeProvider("official-docs", [makeRecord()]);
    const deps = makeResearchDeps({ providers: [p] }, { dailyProviderRequestLimit: 0 });
    const out = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    expect(out.sources).toHaveLength(0);
  });

  it("keeps the run usable (partial) when a provider is down", async () => {
    const deps = makeResearchDeps({ providers: [new FakeProvider("official-docs", [makeRecord()]), new FakeProvider("crossref", [], true)] });
    const out = await startRun(deps, USER, "repo1", { question: "How do we avoid circular imports?" });
    expect(out.run.partial).toBe(true);
    expect(out.sources.length).toBeGreaterThan(0);
  });
});

describe("source reuse and immutability", () => {
  it("reuses fresh cached sources without refetching, and past runs keep their own snapshot of the source", async () => {
    const store = new FakeResearchStore();
    let fetched = 0;
    const recA = makeRecord();
    const provider = {
      name: "official-docs" as const,
      async discover(query: Parameters<FakeProvider["discover"]>[0], ctx: Parameters<FakeProvider["discover"]>[1]) {
        const cached = await ctx.findCached(recA.canonicalUrl);
        if (cached) {
          return { sources: [{ record: cached, sections: [{ heading: "c", text: cached.excerpt }], reused: true }], diagnostic: { provider: "official-docs" as const, queryOrdinal: query.ordinal, status: "OK" as const, returned: 1, durationMs: 0, note: null } };
        }
        fetched += 1;
        return { sources: [{ record: recA, sections: [{ heading: "c", text: recA.excerpt }], reused: false }], diagnostic: { provider: "official-docs" as const, queryOrdinal: query.ordinal, status: "OK" as const, returned: 1, durationMs: 0, note: null } };
      },
    };
    const deps = makeResearchDeps({ store, providers: [provider] });
    const first = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    const afterFirst = fetched;
    expect(afterFirst).toBeGreaterThan(0);
    const second = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    expect(fetched).toBe(afterFirst); // the second run reused the cache
    expect(second.sources.every((s) => s.reused)).toBe(true);

    // Mutating the cache afterwards must not alter what run one recorded.
    for (const e of store.cache.values()) e.record = { ...e.record, title: "CHANGED" };
    const reread = await getRun(deps, USER, first.run.id);
    expect(reread.sources[0].title).not.toBe("CHANGED");
  });

  it("never serves another user's cached sources", async () => {
    const store = new FakeResearchStore();
    await store.cacheSources(OTHER, [{ record: makeRecord(), expiresAt: new Date("2027-01-01") }]);
    expect(await store.findCachedSource(USER, makeRecord().canonicalUrl, new Date("2026-11-09"))).toBeNull();
  });

  it("does not use an expired cache entry", async () => {
    const store = new FakeResearchStore();
    await store.cacheSources(USER, [{ record: makeRecord(), expiresAt: new Date("2026-01-01") }]);
    expect(await store.findCachedSource(USER, makeRecord().canonicalUrl, new Date("2026-11-09"))).toBeNull();
  });
});

describe("source review gates synthesis", () => {
  async function setup(sources = [makeRecord(), makeRecord({ sourceKey: "src_b", canonicalUrl: "https://nodejs.org/api/modules.html", title: "Node modules" })]) {
    const provider = new ScriptedProvider(() => reply());
    const deps = makeResearchDeps({ provider, providers: [new FakeProvider("official-docs", sources)] });
    const run = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    return { deps, provider, run };
  }

  it("synthesises only from included sources", async () => {
    const { deps, provider, run } = await setup();
    await reviewSources(deps, USER, run.run.id, { included: { src_a: false } });
    await synthesiseRun(deps, USER, run.run.id);
    const prompt = provider.calls[0].userPrompt;
    expect(prompt).toContain("Node modules");
    expect(prompt).not.toContain("Circular dependencies in modules");
  });

  it("makes no provider call when every source was excluded", async () => {
    const { deps, provider, run } = await setup();
    await reviewSources(deps, USER, run.run.id, { included: { src_a: false, src_b: false } });
    const out = await synthesiseRun(deps, USER, run.run.id);
    expect(provider.calls).toHaveLength(0);
    expect(out.run.synthesis?.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("rejects unknown source keys and wrong value types", async () => {
    const { deps, run } = await setup();
    expect(await code(reviewSources(deps, USER, run.run.id, { included: { nope: true } }))).toBe("INVALID_INPUT");
    expect(await code(reviewSources(deps, USER, run.run.id, { included: { src_a: "yes" } }))).toBe("INVALID_INPUT");
  });

  it("freezes the review once synthesised, and synthesis cannot be repeated", async () => {
    const { deps, run } = await setup();
    const done = await synthesiseRun(deps, USER, run.run.id);
    expect(done.run.status).toBe("COMPLETED");
    expect(done.recommendations).toHaveLength(1);
    expect(await code(reviewSources(deps, USER, run.run.id, { included: { src_a: false } }))).toBe("INVALID_STATE");
    expect(await code(synthesiseRun(deps, USER, run.run.id))).toBe("INVALID_STATE");
  });

  it("keeps results unchanged when the run is renamed or archived", async () => {
    const { deps, run } = await setup();
    const done = await synthesiseRun(deps, USER, run.run.id);
    const renamed = await updateRun(deps, USER, run.run.id, { title: "Cycle research", archived: true });
    expect(renamed.run.title).toBe("Cycle research");
    expect(renamed.run.archived).toBe(true);
    const again = await getRun(deps, USER, run.run.id);
    expect(again.recommendations[0].detail).toBe(done.recommendations[0].detail);
    expect((await listRuns(deps, USER, "repo1")).runs).toHaveLength(0);
    expect((await listRuns(deps, USER, "repo1", { archived: true })).runs).toHaveLength(1);
  });

  it("allows only one concurrent synthesis", async () => {
    const { deps, run } = await setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new ScriptedProvider(async () => { await gate; return reply(); });
    const slowDeps = { ...deps, provider: () => slow };
    const first = synthesiseRun(slowDeps, USER, run.run.id);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(await code(synthesiseRun(slowDeps, USER, run.run.id))).toBe("BUSY");
    release();
    await first;
    expect(slow.calls).toHaveLength(1);
  });

  it("enforces the daily synthesis limit before contacting the provider", async () => {
    const provider = new ScriptedProvider(() => reply());
    const deps = makeResearchDeps({ provider }, { dailySynthesisLimit: 1 });
    const a = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    const b = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    await synthesiseRun(deps, USER, a.run.id);
    expect(await code(synthesiseRun(deps, USER, b.run.id))).toBe("LIMIT_EXCEEDED");
    expect(provider.calls).toHaveLength(1);
    const usage = await getResearchUsage(deps, USER);
    expect(usage.syntheses.used).toBe(1);
    expect(usage.tokens.used).toBeGreaterThan(0);
  });

  it("maps provider failures to safe errors and leaves the run reviewable", async () => {
    const failing = new ScriptedProvider(() => { throw new AIProviderError("Provider busy.", "RATE_LIMITED", { retryable: true, detail: "secret-key-123" }); });
    const deps = makeResearchDeps({ provider: failing });
    const run = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    let message = "";
    try { await synthesiseRun(deps, USER, run.run.id); } catch (e) { message = (e as Error).message; }
    expect(message).toBe("Provider busy.");
    expect(message).not.toMatch(/secret/);
    expect((await getRun(deps, USER, run.run.id)).run.status).toBe("AWAITING_REVIEW");
  });
});

describe("recommendation lifecycle", () => {
  async function completed() {
    const deps = makeResearchDeps({ provider: new ScriptedProvider(() => reply()) });
    const run = await startRun(deps, USER, "repo1", { findingId: "fnd1" });
    const done = await synthesiseRun(deps, USER, run.run.id);
    return { deps, id: done.recommendations[0].id, runId: run.run.id };
  }

  it("starts proposed and moves only through allowed transitions", async () => {
    const { deps, id } = await completed();
    expect(await code(updateRecommendation(deps, USER, id, { status: "IMPLEMENTED" }))).toBe("INVALID_STATE");
    const accepted = await updateRecommendation(deps, USER, id, { status: "ACCEPTED", note: "Plan for next sprint" });
    expect(accepted.recommendation.status).toBe("ACCEPTED");
    expect(accepted.recommendation.note).toBe("Plan for next sprint");
    expect((await updateRecommendation(deps, USER, id, { status: "IMPLEMENTED" })).recommendation.status).toBe("IMPLEMENTED");
  });

  it("rejects invalid status values, oversized notes and other users", async () => {
    const { deps, id } = await completed();
    expect(await code(updateRecommendation(deps, USER, id, { status: "DONE" }))).toBe("INVALID_INPUT");
    expect(await code(updateRecommendation(deps, USER, id, { note: "x".repeat(2000) }))).toBe("INVALID_INPUT");
    expect(await code(updateRecommendation(deps, OTHER, id, { status: "ACCEPTED" }))).toBe("NOT_FOUND");
  });

  it("does not change the recommendation's evidence when the status changes", async () => {
    const { deps, id, runId } = await completed();
    const before = (await getRun(deps, USER, runId)).recommendations[0];
    await updateRecommendation(deps, USER, id, { status: "REJECTED" });
    const after = (await getRun(deps, USER, runId)).recommendations[0];
    expect(after.sourceCitations).toEqual(before.sourceCitations);
    expect(after.detail).toBe(before.detail);
  });
});
