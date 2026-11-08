// tests/unit/findings/engine.test.ts
import { describe, expect, it } from "vitest";

import { resolveThresholds, ThresholdError } from "@/features/findings/config";
import type { RuleDefinition } from "@/features/findings/contracts";
import { assertValidCatalogue } from "@/features/findings/engine/run-rules";
import { createFindingFingerprint } from "@/features/findings/identity";
import { RULE_CATALOGUE } from "@/features/findings/rules";
import { fixtures } from "@/tests/fixtures/code-intelligence/projects";
import { ids, runPipeline } from "@/tests/fixtures/findings/pipeline";

function rule(overrides: Partial<RuleDefinition> = {}): RuleDefinition {
  return {
    id: "TST001",
    name: "Test",
    version: "1.0.0",
    category: "STRUCTURE",
    severities: ["LOW"],
    severityPolicy: "",
    certainties: ["CONFIRMED"],
    scope: "FILE",
    requiresCompleteAnalysis: false,
    usesSourceFacts: false,
    thresholdKeys: [],
    description: "",
    evaluation: "",
    evidenceRequirement: "",
    recommendation: "Fix it.",
    evaluate: () => ({ kind: "findings", findings: [] }),
    ...overrides,
  };
}

const good = {
  title: "t",
  description: "d",
  severity: "LOW" as const,
  certainty: "CONFIRMED" as const,
  subjectPath: "src/b.ts",
  subjectKey: "K",
  symbolKey: null,
  primaryLine: 1,
  measurements: null,
  evidence: [
    {
      kind: "SOURCE_LOCATION" as const,
      filePath: "src/b.ts",
      symbolKey: null,
      location: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
      excerpt: null,
      message: "why",
    },
  ],
};

const project = fixtures.relativeImports;

describe("catalogue", () => {
  it("has unique, well-formed ids and versions", () => {
    expect(() => assertValidCatalogue(RULE_CATALOGUE)).not.toThrow();
    expect(new Set(RULE_CATALOGUE.map((r) => r.id)).size).toBe(
      RULE_CATALOGUE.length,
    );
  });

  it("rejects duplicate ids and bad versions", () => {
    expect(() => assertValidCatalogue([rule(), rule()])).toThrow(/Duplicate/);
    expect(() => assertValidCatalogue([rule({ version: "1" })])).toThrow(
      /version/,
    );
  });

  it("never allows CRITICAL and never labels security rules as confirmed", () => {
    for (const r of RULE_CATALOGUE) {
      expect(r.severities.includes("CRITICAL")).toBe(false);
      if (r.category === "SECURITY") {
        expect(r.certainties).toEqual(["INDICATOR"]);
        expect(r.name.startsWith("Possible")).toBe(true);
      }
    }
  });
});

describe("runRules", () => {
  it("is deterministic", () => {
    const a = runPipeline(fixtures.circular);
    const b = runPipeline(fixtures.circular);
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
  });

  it("accepts a valid finding and assigns a stable fingerprint", () => {
    const { result } = runPipeline(project, {
      rules: [
        rule({ evaluate: () => ({ kind: "findings", findings: [good] }) }),
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].fingerprint).toBe(
      createFindingFingerprint({
        ruleId: "TST001",
        subjectPath: "src/b.ts",
        subjectKey: "K",
      }),
    );
  });

  it("rejects findings with unknown files, no evidence or disallowed severity", () => {
    const bad = [
      { ...good, subjectPath: "nope.ts" },
      { ...good, evidence: [] },
      { ...good, severity: "HIGH" as const },
      { ...good, certainty: "INDICATOR" as const },
      {
        ...good,
        evidence: [{ ...good.evidence[0], filePath: "nope.ts" }],
      },
      {
        ...good,
        evidence: [
          {
            ...good.evidence[0],
            location: {
              startLine: 999,
              startColumn: 1,
              endLine: 999,
              endColumn: 2,
            },
          },
        ],
      },
    ];
    const { result } = runPipeline(project, {
      rules: [rule({ evaluate: () => ({ kind: "findings", findings: bad }) })],
    });
    expect(result.findings).toHaveLength(0);
    expect(result.ruleRuns[0].rejectedCount).toBe(bad.length);
  });

  it("drops duplicate fingerprints", () => {
    const { result } = runPipeline(project, {
      rules: [
        rule({
          evaluate: () => ({ kind: "findings", findings: [good, good] }),
        }),
      ],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.ruleRuns[0].duplicateCount).toBe(1);
  });

  it("isolates a failing rule and marks the run partial", () => {
    const { result } = runPipeline(project, {
      rules: [
        rule({
          id: "TST001",
          evaluate: () => {
            throw new Error("secret detail");
          },
        }),
        rule({
          id: "TST002",
          evaluate: () => ({ kind: "findings", findings: [good] }),
        }),
      ],
    });
    expect(result.ruleRuns.find((r) => r.ruleId === "TST001")?.status).toBe(
      "FAILED",
    );
    expect(result.findings).toHaveLength(1);
    expect(result.outcome).toBe("PARTIAL");
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("skips complete-analysis rules on a partial analysis", () => {
    const { result } = runPipeline(fixtures.circular, {
      completeness: "PARTIAL",
    });
    const dep3 = result.ruleRuns.find((r) => r.ruleId === "DEP003");
    expect(dep3?.status).toBe("SKIPPED");
    expect(dep3?.reason).toMatch(/Insufficient evidence/);
    expect(ids(result)).not.toContain("DEP003");
    expect(result.outcome).toBe("PARTIAL");
  });

  it("reports an empty complete analysis as COMPLETED with no findings", () => {
    const { result } = runPipeline({ "src/a.ts": "export const a = 1;\n" });
    expect(result.findings).toEqual([]);
    expect(result.outcome).toBe("COMPLETED");
  });
});

describe("thresholds", () => {
  it("rejects unknown, non-integer, out-of-range and misordered values", () => {
    expect(() => resolveThresholds({ nope: 1 })).toThrow(ThresholdError);
    expect(() => resolveThresholds({ cyclomaticMedium: 1.5 })).toThrow(
      ThresholdError,
    );
    expect(() => resolveThresholds({ cyclomaticMedium: 1 })).toThrow(
      ThresholdError,
    );
    expect(() =>
      resolveThresholds({ cyclomaticMedium: 40, cyclomaticHigh: 30 }),
    ).toThrow(ThresholdError);
    expect(() => resolveThresholds("x")).toThrow(ThresholdError);
  });

  it("changes behaviour and the rule config hash", () => {
    const code = `export function f(a){ ${"if(a){a++}".repeat(6)} }\n`;
    const low = runPipeline(
      { "src/f.ts": code },
      { thresholds: { cyclomaticMedium: 5, cyclomaticHigh: 50 } },
    );
    const high = runPipeline({ "src/f.ts": code });
    expect(ids(low.result)).toContain("CPX001");
    expect(ids(high.result)).not.toContain("CPX001");
    const hash = (r: typeof low) =>
      r.result.ruleRuns.find((x) => x.ruleId === "CPX001")?.configHash;
    expect(hash(low)).not.toBe(hash(high));
  });
});
