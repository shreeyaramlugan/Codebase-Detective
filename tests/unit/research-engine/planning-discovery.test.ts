// tests/unit/research-engine/planning-discovery.test.ts
import { describe, expect, it } from "vitest";

import { DEFAULT_RESEARCH_LIMITS } from "../../../features/research/engine/config";
import { runDiscovery } from "../../../features/research/engine/discovery";
import { evaluateSource, freshnessOf } from "../../../features/research/engine/evaluate";
import {
  FINDING_RESEARCH,
  ManualQuestionError,
  isResearchSupported,
  planFindingQueries,
  planManualQueries,
  validateManualQuestion,
} from "../../../features/research/engine/queries";
import { canTransition } from "../../../features/research/engine/lifecycle";
import { FakeProvider, makeRecord } from "../../fixtures/research/fakes";

const NOW = new Date("2026-11-09T12:00:00.000Z");
const limits = DEFAULT_RESEARCH_LIMITS;

describe("query planning", () => {
  it("is deterministic and bounded for supported rules", () => {
    const f = { ruleId: "DEP003", title: "Circular dependency", subjectPath: "src/a.ts" };
    const a = planFindingQueries(f, limits);
    expect(a).toEqual(planFindingQueries(f, limits));
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(limits.maxQueriesPerRun);
    expect(planFindingQueries(f, { maxQueriesPerRun: 1 })).toHaveLength(1);
  });

  it("does not put repository paths or identifiers into outbound queries", () => {
    for (const [rule, t] of Object.entries(FINDING_RESEARCH)) {
      for (const q of t.queries) expect(q.text).not.toMatch(/src\/|\.ts\b|acme/);
      expect(isResearchSupported(rule)).toBe(true);
    }
  });

  it("reports unsupported rules as unsupported", () => {
    expect(isResearchSupported("DEP004")).toBe(false);
    expect(planFindingQueries({ ruleId: "DEP004", title: "x", subjectPath: "a" }, limits)).toEqual([]);
  });

  it("validates manual questions", () => {
    expect(validateManualQuestion("  How   do we break   cycles? ")).toBe("How do we break cycles?");
    expect(() => validateManualQuestion("short")).toThrow(ManualQuestionError);
    expect(() => validateManualQuestion("x".repeat(600))).toThrow(ManualQuestionError);
    expect(() => validateManualQuestion("bad \u0000 control chars here")).toThrow(ManualQuestionError);
    expect(() => validateManualQuestion(42)).toThrow(ManualQuestionError);
    expect(planManualQueries("How do we break import cycles?", limits)[0].targets).toContain("CROSSREF");
  });
});

describe("evaluation", () => {
  it("labels freshness from the source's own dates", () => {
    expect(freshnessOf(makeRecord({ updatedAt: "2026-01-01" }), NOW, 5)).toBe("CURRENT");
    expect(freshnessOf(makeRecord({ updatedAt: "2015-01-01" }), NOW, 5)).toBe("DATED");
    expect(freshnessOf(makeRecord({ updatedAt: null, publishedAt: null }), NOW, 5)).toBe("UNKNOWN");
  });

  it("never upgrades a preprint or an abstract through scoring", () => {
    const preprint = makeRecord({ kind: "SCHOLARLY", sourceClass: "PREPRINT", contentLevel: "ABSTRACT", availability: "UNVERIFIED" });
    const e = evaluateSource(preprint, "circular dependencies modules", NOW, limits);
    expect(e.notes.join(" ")).toMatch(/not peer reviewed/);
    expect(e.notes.join(" ")).toMatch(/full text was not reviewed/);
    const official = evaluateSource(makeRecord(), "circular dependencies modules", NOW, limits);
    expect(official.authority).toBeGreaterThan(e.authority);
  });

  it("down-weights unavailable pages and flags them", () => {
    const e = evaluateSource(makeRecord({ availability: "UNAVAILABLE", excerpt: "" }), "circular dependencies", NOW, limits);
    expect(e.notes.join(" ")).toMatch(/could not be retrieved/);
    expect(e.score).toBeLessThan(0.3);
  });
});

describe("discovery", () => {
  const base = {
    plans: [{ ordinal: 1, text: "circular dependencies modules", rationale: "r", targets: ["OFFICIAL_DOCUMENTATION" as const, "CROSSREF" as const] }],
    limits,
    now: () => NOW,
    countRequest: async () => undefined,
    findCached: async () => null,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };

  it("merges the same paper from two providers by DOI and keeps one record", async () => {
    const a = makeRecord({ sourceKey: "src_p", kind: "SCHOLARLY", sourceClass: "PEER_REVIEWED", doi: "10.1/x", doiFromProvider: true, excerpt: "Circular dependencies between modules.", contentLevel: "ABSTRACT", availability: "UNVERIFIED", title: "Circular dependencies in modules", provider: "crossref" });
    const b = { ...a, provider: "openalex", excerpt: "Circular dependencies between modules in large systems studied.", externalIds: { openalex: "W1" } };
    const out = await runDiscovery({
      ...base,
      plans: [{ ordinal: 1, text: "circular dependencies modules", rationale: "r", targets: ["CROSSREF", "OPENALEX"] }],
      providers: [new FakeProvider("crossref", [a]), new FakeProvider("openalex", [b])],
    });
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0].record.externalIds.openalex).toBe("W1");
  });

  it("keeps going when one provider fails and marks the run partial", async () => {
    const out = await runDiscovery({
      ...base,
      providers: [new FakeProvider("official-docs", [makeRecord()]), new FakeProvider("crossref", [], true)],
    });
    expect(out.sources.length).toBeGreaterThan(0);
    expect(out.partial).toBe(true);
    expect(out.diagnostics.some((d) => d.provider === "crossref" && d.status === "UNAVAILABLE")).toBe(true);
  });

  it("skips queries once the deadline has passed and does not retry", async () => {
    const provider = new FakeProvider("official-docs", [makeRecord()]);
    const out = await runDiscovery({ ...base, providers: [provider], deadlineAt: 0, clock: () => 1 });
    expect(provider.calls).toBe(0);
    expect(out.partial).toBe(true);
    expect(out.queries[0].status).toBe("SKIPPED");
  });

  it("drops low-relevance scholarly results and applies the per-run source cap", async () => {
    const off = makeRecord({ sourceKey: "src_off", kind: "SCHOLARLY", sourceClass: "PEER_REVIEWED", title: "Marine biology of coral", excerpt: "Coral reefs.", contentLevel: "ABSTRACT", availability: "UNVERIFIED", container: null });
    const out = await runDiscovery({ ...base, providers: [new FakeProvider("crossref", [off])] });
    expect(out.sources).toHaveLength(0);
    expect(out.discarded.lowRelevance).toBe(1);

    const many = Array.from({ length: 6 }, (_, i) => makeRecord({ sourceKey: `src_${i}`, canonicalUrl: `https://developer.mozilla.org/p${i}` }));
    const capped = await runDiscovery({
      ...base,
      limits: { ...limits, maxSourcesPerRun: 3 },
      providers: [new FakeProvider("official-docs", many)],
    });
    expect(capped.sources).toHaveLength(3);
    expect(capped.discarded.overLimit).toBe(3);
  });

  it("orders results deterministically", async () => {
    const recs = [makeRecord({ sourceKey: "src_b", canonicalUrl: "https://developer.mozilla.org/b" }), makeRecord({ sourceKey: "src_a", canonicalUrl: "https://developer.mozilla.org/a" })];
    const one = await runDiscovery({ ...base, providers: [new FakeProvider("official-docs", recs)] });
    const two = await runDiscovery({ ...base, providers: [new FakeProvider("official-docs", [...recs].reverse())] });
    expect(one.sources.map((s) => s.record.sourceKey)).toEqual(two.sources.map((s) => s.record.sourceKey));
  });
});

describe("recommendation lifecycle", () => {
  it("allows only defined transitions, and implemented only after accepted", () => {
    expect(canTransition("PROPOSED", "ACCEPTED")).toBe(true);
    expect(canTransition("PROPOSED", "IMPLEMENTED")).toBe(false);
    expect(canTransition("ACCEPTED", "IMPLEMENTED")).toBe(true);
    expect(canTransition("REJECTED", "IMPLEMENTED")).toBe(false);
    expect(canTransition("ARCHIVED", "ACCEPTED")).toBe(false);
    expect(canTransition("ACCEPTED", "ACCEPTED")).toBe(false);
  });
});
