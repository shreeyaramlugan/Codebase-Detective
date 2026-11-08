// tests/unit/findings/compare.test.ts
import { describe, expect, it } from "vitest";

import {
  compareFindings,
  type ComparisonSide,
} from "@/features/findings/compare/compare-findings";
import { fixtures } from "@/tests/fixtures/code-intelligence/projects";
import { runPipeline, sha } from "@/tests/fixtures/findings/pipeline";

function side(
  project: Record<string, string>,
  options: Parameters<typeof runPipeline>[1] = {},
): ComparisonSide {
  const r = runPipeline(project, options);
  return {
    analysisId: "a",
    complete: r.analysis.complete,
    findings: r.result.findings,
    ruleRuns: r.result.ruleRuns,
    fileHashes: new Map(
      r.records.files
        .filter((f) => f.status.startsWith("ANALYSED"))
        .map((f) => [f.path, f.contentHash] as const),
    ),
    factsMissing: r.facts.missing,
    factRuleIds: new Set([
      "CPX001",
      "CPX002",
      "CPX003",
      "CPX004",
      "STR001",
      "STR002",
      "SEC001",
    ]),
  };
}

const status = (c: ReturnType<typeof compareFindings>, s: string) =>
  c.entries.filter((e) => e.status === s);

const bad = `import { x } from "./missing";\nexport const a = x;\n`;
const evalCode = `export function run(s: string) { return eval(s); }\n`;

describe("compareFindings", () => {
  it("classifies new, persistent and resolved", () => {
    const base = side({ "src/a.ts": bad, "src/e.ts": evalCode });
    const head = side({
      "src/a.ts": `export const a = 1;\n`,
      "src/e.ts": evalCode,
      "src/n.ts": `import "./nope";\n`,
    });
    const c = compareFindings(base, head);
    expect(status(c, "RESOLVED").map((e) => e.ruleId)).toEqual(["DEP001"]);
    expect(status(c, "NEW").map((e) => e.subjectPath)).toEqual(["src/n.ts"]);
    expect(status(c, "PERSISTENT").map((e) => e.ruleId)).toEqual(["SEC001"]);
    expect(c.summary).toEqual({
      new: 1,
      persistent: 1,
      resolved: 1,
      unverified: 0,
      notComparable: 0,
    });
  });

  it("does not treat a partial head analysis as resolution", () => {
    const base = side({ "src/a.ts": bad });
    const head = side(
      { "src/z.ts": "export const z = 1;\n" },
      { completeness: "PARTIAL" },
    );
    const c = compareFindings(base, head);
    expect(status(c, "RESOLVED")).toHaveLength(0);
    expect(status(c, "UNVERIFIED")).toHaveLength(1);
    expect(c.limitations.join(" ")).toMatch(/head analysis is partial/);
  });

  it("does not treat missing source facts as resolution", () => {
    const base = side({ "src/e.ts": evalCode });
    const head = side({ "src/e.ts": evalCode }, { withhold: ["src/e.ts"] });
    const c = compareFindings(base, head);
    expect(status(c, "RESOLVED")).toHaveLength(0);
    expect(status(c, "UNVERIFIED")).toHaveLength(1);
  });

  it("treats a file deleted from a complete head as resolved, with a reason", () => {
    const base = side({ "src/a.ts": bad, "src/k.ts": "export const k = 1;\n" });
    const head = side({ "src/k.ts": "export const k = 1;\n" });
    const c = compareFindings(base, head);
    const resolved = status(c, "RESOLVED");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].reason).toMatch(/no longer exists/);
  });

  it("does not call findings new when the base was partial and did not cover the file", () => {
    const base = side(
      { "src/k.ts": "export const k = 1;\n" },
      { completeness: "PARTIAL" },
    );
    const head = side({
      "src/k.ts": "export const k = 1;\n",
      "src/e.ts": evalCode,
    });
    const c = compareFindings(base, head);
    expect(status(c, "NEW")).toHaveLength(0);
    expect(status(c, "UNVERIFIED")).toHaveLength(1);
  });

  it("marks findings of a rule whose version or config changed as not comparable", () => {
    const base = side({ "src/e.ts": evalCode });
    const head = side({ "src/e.ts": evalCode });
    const changed: ComparisonSide = {
      ...head,
      ruleRuns: head.ruleRuns.map((r) =>
        r.ruleId === "SEC001" ? { ...r, ruleVersion: "1.1.0" } : r,
      ),
      findings: [],
    };
    const c = compareFindings(base, changed);
    expect(status(c, "RESOLVED")).toHaveLength(0);
    expect(status(c, "NOT_COMPARABLE")).toHaveLength(1);
    expect(c.notComparableRules[0].ruleId).toBe("SEC001");

    const cfg: ComparisonSide = {
      ...head,
      ruleRuns: head.ruleRuns.map((r) =>
        r.ruleId === "SEC001" ? { ...r, configHash: "other" } : r,
      ),
    };
    expect(compareFindings(base, cfg).notComparableRules[0].reason).toMatch(
      /thresholds/,
    );
  });

  it("detects an unambiguous file move with identical content", () => {
    const base = side({ "src/old.ts": evalCode });
    const head = side({ "lib/new.ts": evalCode });
    const c = compareFindings(base, head);
    const moved = status(c, "PERSISTENT");
    expect(moved).toHaveLength(1);
    expect(moved[0].previousPath).toBe("src/old.ts");
    expect(status(c, "NEW")).toHaveLength(0);
    expect(status(c, "RESOLVED")).toHaveLength(0);
  });

  it("does not guess a move when content changed or matches are ambiguous", () => {
    const changed = compareFindings(
      side({ "src/old.ts": evalCode }),
      side({ "lib/new.ts": evalCode + "// edit\n" }),
    );
    expect(status(changed, "PERSISTENT")).toHaveLength(0);

    const ambiguous = compareFindings(
      side({ "src/old.ts": evalCode }),
      side({ "lib/a.ts": evalCode, "lib/b.ts": evalCode }),
    );
    expect(status(ambiguous, "PERSISTENT")).toHaveLength(0);
  });

  it("reports severity changes on persistent findings", () => {
    const base = side({ "src/e.ts": `export const f = () => eval("1");\n` });
    const head = side({
      "src/e.ts": `export const f = (s: string) => eval(s);\n`,
    });
    const c = compareFindings(base, head);
    // static -> dynamic keeps the same fingerprint (same callee) but changes severity
    const p = status(c, "PERSISTENT");
    expect(p).toHaveLength(1);
    expect(p[0].previousSeverity).toBe("LOW");
    expect(p[0].severity).toBe("MEDIUM");
  });

  it("is deterministic and identical snapshots have no differences", () => {
    const a = side(fixtures.circular);
    const c1 = compareFindings(a, a);
    const c2 = compareFindings(a, a);
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
    expect(c1.summary.new + c1.summary.resolved + c1.summary.unverified).toBe(
      0,
    );
    expect(c1.summary.persistent).toBe(1);
    expect(sha("x")).toHaveLength(64);
  });
});
