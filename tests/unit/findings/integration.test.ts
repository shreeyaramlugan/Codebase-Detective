// tests/unit/findings/integration.test.ts
//
// Sprint 03 analysis -> source facts -> rules -> comparison, over every
// fixture project, checking the invariants the spec requires of the whole
// pipeline rather than of one rule.
import { describe, expect, it } from "vitest";

import { fixtures } from "@/tests/fixtures/code-intelligence/projects";
import { isFindingFingerprint } from "@/features/findings/identity";
import { RULE_CATALOGUE } from "@/features/findings/rules";
import { runPipeline } from "@/tests/fixtures/findings/pipeline";

const projects = Object.entries(fixtures) as Array<
  [string, Record<string, string>]
>;

describe("pipeline invariants over all Sprint 03 fixtures", () => {
  for (const [name, project] of projects) {
    it(`${name}: findings are valid, traceable and deterministic`, () => {
      const a = runPipeline(project);
      const b = runPipeline(project);
      expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result));
      expect(a.result.ruleRuns.every((r) => r.status !== "FAILED")).toBe(true);
      expect(a.result.ruleRuns).toHaveLength(RULE_CATALOGUE.length);

      const files = new Set(a.records.files.map((f) => f.path));
      const symbols = new Set(a.records.symbols.map((s) => s.key));
      const seen = new Set<string>();

      for (const f of a.result.findings) {
        expect(isFindingFingerprint(f.fingerprint)).toBe(true);
        expect(seen.has(f.fingerprint)).toBe(false);
        seen.add(f.fingerprint);

        const rule = RULE_CATALOGUE.find((r) => r.id === f.ruleId)!;
        expect(rule).toBeDefined();
        expect(f.ruleVersion).toBe(rule.version);
        expect(rule.severities.includes(f.severity)).toBe(true);
        expect(rule.certainties.includes(f.certainty)).toBe(true);
        expect(files.has(f.subjectPath)).toBe(true);
        if (f.symbolKey) expect(symbols.has(f.symbolKey)).toBe(true);
        expect(f.evidence.length).toBeGreaterThan(0);

        f.evidence.forEach((e, i) => {
          expect(e.ordinal).toBe(i);
          expect(files.has(e.filePath)).toBe(true);
          if (e.symbolKey) expect(symbols.has(e.symbolKey)).toBe(true);
          if (e.location) {
            expect(e.location.startLine >= 1).toBe(true);
            expect(e.location.endLine >= e.location.startLine).toBe(true);
          }
        });
      }
    });
  }

  it("findings are isolated between runs: the same project gives the same identities", () => {
    const a = runPipeline(fixtures.circular);
    const b = runPipeline(fixtures.circular);
    expect(a.result.findings.map((f) => f.fingerprint)).toEqual(
      b.result.findings.map((f) => f.fingerprint),
    );
  });
});

describe("edge cases from the spec", () => {
  it("does not classify an external package as an unresolved internal import", () => {
    const r = runPipeline({
      "src/a.ts": `import x from "left-pad";\nexport const a = x;\n`,
    });
    expect(r.result.findings.filter((f) => f.ruleId === "DEP001")).toHaveLength(
      0,
    );
  });

  it("does not invent a target for an ambiguous import", () => {
    const r = runPipeline({
      "src/a.ts": `import { x } from "./dup";\nexport const a = x;\n`,
      "src/dup.ts": `export const x = 1;\n`,
      "src/dup.tsx": `export const x = 2;\n`,
    });
    for (const f of r.result.findings.filter((x) => x.ruleId === "DEP002")) {
      expect(f.certainty).toBe("CONFIRMED");
      expect(f.evidence[0].kind).toBe("DEPENDENCY");
    }
  });

  it("handles empty and syntactically broken files without failing any rule", () => {
    const r = runPipeline({ ...fixtures.empty, ...fixtures.invalidSyntax });
    expect(r.result.ruleRuns.every((x) => x.status !== "FAILED")).toBe(true);
  });

  it("a partial snapshot analyses what it can and discloses the limits", () => {
    const r = runPipeline(fixtures.circular, { completeness: "PARTIAL" });
    expect(r.result.outcome).toBe("PARTIAL");
    expect(r.result.limitations.length).toBeGreaterThan(0);
    expect(r.result.findings.filter((f) => f.ruleId === "DEP003")).toHaveLength(
      0,
    );
  });

  it("a tampered evidence reference is rejected, not stored", () => {
    const rule = {
      ...RULE_CATALOGUE.find((x) => x.id === "SEC001")!,
      evaluate: () => ({
        kind: "findings" as const,
        findings: [
          {
            title: "t",
            description: "d",
            severity: "LOW" as const,
            certainty: "INDICATOR" as const,
            subjectPath: "src/e.ts",
            subjectKey: "k",
            symbolKey: "sym_forged",
            primaryLine: 1,
            measurements: null,
            evidence: [
              {
                kind: "PATTERN_MATCH" as const,
                filePath: "other-snapshot/file.ts",
                symbolKey: null,
                location: null,
                excerpt: null,
                message: "m",
              },
            ],
          },
        ],
      }),
    };
    const r = runPipeline({ "src/e.ts": `eval(x);\n` }, { rules: [rule] });
    expect(r.result.findings).toHaveLength(0);
    expect(r.result.ruleRuns[0].rejectedCount).toBe(1);
  });

  it("a rule version bump is recorded on the run and on each finding", () => {
    const base = RULE_CATALOGUE.find((x) => x.id === "SEC001")!;
    const bumped = { ...base, version: "1.1.0" };
    const r = runPipeline({ "src/e.ts": `eval(x);\n` }, { rules: [bumped] });
    expect(r.result.ruleRuns[0].ruleVersion).toBe("1.1.0");
    expect(r.result.findings[0].ruleVersion).toBe("1.1.0");
  });

  it("does not expose repository content outside redacted excerpts", () => {
    const r = runPipeline({
      "src/s.ts": `const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n`,
    });
    expect(JSON.stringify(r.result)).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
  });

  it("a very large module is measured, not skipped", () => {
    const r = runPipeline({
      "src/big.ts": "export const a = 1;\n".repeat(1500),
    });
    expect(
      r.result.findings.some(
        (f) => f.ruleId === "CPX005" && f.severity === "MEDIUM",
      ),
    ).toBe(true);
  });
});
