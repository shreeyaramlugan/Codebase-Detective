// tests/unit/findings/rules.test.ts
//
// Rules are exercised through the real Sprint 03 -> facts -> engine pipeline.
import { describe, expect, it } from "vitest";

import { fixtures } from "@/tests/fixtures/code-intelligence/projects";
import { ids, runPipeline } from "@/tests/fixtures/findings/pipeline";

const find = (r: ReturnType<typeof runPipeline>, id: string) =>
  r.result.findings.filter((f) => f.ruleId === id);

describe("dependency rules", () => {
  it("DEP003 reports a cycle once with edge evidence", () => {
    const r = runPipeline(fixtures.circular);
    const cycles = find(r, "DEP003");
    expect(cycles).toHaveLength(1);
    expect(cycles[0].certainty).toBe("CONFIRMED");
    expect(cycles[0].severity).toBe("MEDIUM");
    expect(cycles[0].subjectPath).toBe("src/x.ts");
    expect(cycles[0].evidence.length).toBe(2);
    expect(cycles[0].evidence.every((e) => e.kind === "CYCLE_EDGE")).toBe(true);
  });

  it("DEP003 ignores type-only and dynamic imports and acyclic graphs", () => {
    const r = runPipeline({
      "src/a.ts": `import type { B } from "./b";\nexport const a = 1;\n`,
      "src/b.ts": `import { a } from "./a";\nexport type B = typeof a;\n`,
      "src/c.ts": `export const load = () => import("./d");\n`,
      "src/d.ts": `import { load } from "./c";\nexport const d = load;\n`,
    });
    expect(find(r, "DEP003")).toHaveLength(0);
  });

  it("DEP003 reports a self import and is High for large cycles", () => {
    const self = runPipeline({
      "src/s.ts": `import { s } from "./s";\nexport const s = 1;\n`,
    });
    expect(find(self, "DEP003")).toHaveLength(1);

    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      files[`src/n${i}.ts`] =
        `import { v } from "./n${(i + 1) % 5}";\nexport const v${i} = 1;\n`;
    }
    const big = runPipeline(files);
    expect(find(big, "DEP003")[0].severity).toBe("HIGH");
  });

  it("DEP003 keeps its fingerprint when the cycle grows", () => {
    const a = runPipeline(fixtures.circular);
    const b = runPipeline({
      ...fixtures.circular,
      "src/y.ts": `import { z } from "./z";\nimport { x } from "./x";\nexport const y = () => x();\n`,
      "src/z.ts": `import { y } from "./y";\nexport const z = 1;\n`,
    });
    expect(find(b, "DEP003")[0].fingerprint).toBe(
      find(a, "DEP003")[0].fingerprint,
    );
  });

  it("DEP001 reports unresolved relative imports with the dependency as evidence", () => {
    const r = runPipeline({
      "src/a.ts": `import { x } from "./missing";\nexport const a = x;\n`,
    });
    const found = find(r, "DEP001");
    expect(found).toHaveLength(1);
    expect(found[0].evidence[0].kind).toBe("DEPENDENCY");
    expect(found[0].evidence[0].location?.startLine).toBe(1);
  });

  it("DEP001 does not report external packages and is not run on partial analyses", () => {
    const ext = runPipeline({
      "src/a.ts": `import React from "react";\nexport const a = React;\n`,
    });
    expect(find(ext, "DEP001")).toHaveLength(0);

    const partial = runPipeline(
      { "src/a.ts": `import { x } from "./missing";\nexport const a = x;\n` },
      { completeness: "PARTIAL" },
    );
    expect(find(partial, "DEP001")).toHaveLength(0);
    expect(
      partial.result.ruleRuns.find((x) => x.ruleId === "DEP001")?.status,
    ).toBe("SKIPPED");
  });

  it("gives repeated identical imports distinct, stable subject keys", () => {
    const r = runPipeline({
      "src/a.ts": `import "./gone";\nimport "./gone";\n`,
    });
    const keys = find(r, "DEP001").map((f) => f.subjectKey);
    expect(new Set(keys).size).toBe(2);
  });
});

function fnWith(branches: number, name = "f") {
  return `export function ${name}(a: number) {\n${"  if (a > 1) { a--; }\n".repeat(branches)}  return a;\n}\n`;
}

describe("complexity rules", () => {
  it("CPX001 applies the documented severity bands at the boundary", () => {
    const at = (n: number) => runPipeline({ "src/f.ts": fnWith(n - 1) });
    expect(find(at(14), "CPX001")).toHaveLength(0);
    expect(find(at(15), "CPX001")[0].severity).toBe("MEDIUM");
    expect(find(at(29), "CPX001")[0].severity).toBe("MEDIUM");
    expect(find(at(30), "CPX001")[0].severity).toBe("HIGH");
  });

  it("CPX001 records measurement, threshold and links the symbol", () => {
    const r = runPipeline({ "src/f.ts": fnWith(20) });
    const f = find(r, "CPX001")[0];
    expect(f.certainty).toBe("MEASURED");
    expect(f.measurements).toMatchObject({ value: 21, threshold: 15 });
    expect(f.symbolKey).not.toBeNull();
    expect(f.subjectKey).toBe("FUNCTION:f#0");
    expect(f.evidence[0].kind).toBe("METRIC");
  });

  it("CPX002/CPX004/CPX003 fire on length, parameters and nesting", () => {
    const long = `export function g() {\n${"  const x = 1;\n".repeat(120)}}\n`;
    const params = `export function p(${Array.from({ length: 8 }, (_, i) => `a${i}`).join(", ")}) {}\n`;
    const nest = `export function n(a){ ${"if(a){".repeat(7)} a++; ${"}".repeat(7)} }\n`;
    const r = runPipeline({
      "src/l.ts": long,
      "src/p.ts": params,
      "src/n.ts": nest,
    });
    for (const id of ["CPX002", "CPX003", "CPX004"])
      expect(ids(r.result).includes(id)).toBe(true);
  });

  it("CPX005 flags large modules by file record", () => {
    const r = runPipeline({
      "src/big.ts": "export const a = 1;\n".repeat(600),
    });
    expect(find(r, "CPX005")[0].severity).toBe("LOW");
    const huge = runPipeline({
      "src/big.ts": "export const a = 1;\n".repeat(1100),
    });
    expect(find(huge, "CPX005")[0].severity).toBe("MEDIUM");
  });

  it("does not run complexity rules for files with unverifiable source", () => {
    const r = runPipeline(
      { "src/f.ts": fnWith(20) },
      { withhold: ["src/f.ts"] },
    );
    expect(find(r, "CPX001")).toHaveLength(0);
    expect(r.result.outcome).toBe("PARTIAL");
    expect(r.result.ruleRuns.find((x) => x.ruleId === "CPX001")?.status).toBe(
      "SKIPPED",
    );
    expect(r.result.limitations.join(" ")).toMatch(
      /Source facts were unavailable/,
    );
  });

  it("rejects source whose hash does not match the analysis", () => {
    const r = runPipeline(
      { "src/f.ts": fnWith(20) },
      { override: { "src/f.ts": "export const x = 1;\n" } },
    );
    // override changes the content but the hash is recomputed from it, so the
    // mismatch is against the analysis record.
    expect(r.facts.missing.get("src/f.ts")).toMatch(/hash/);
    expect(find(r, "CPX001")).toHaveLength(0);
  });
});

describe("structure rules", () => {
  const body = (n: string) =>
    `export function ${n}(a: number[], b: string) {\n  const out: string[] = [];\n  for (const item of a) {\n    if (item > 1 && b.length > 0) { out.push(b + String(item)); } else { out.push(b); }\n  }\n  const joined = out.join(",");\n  return joined.length > 3 ? joined : b;\n}\n`;

  it("STR001 groups identical structures as an indicator", () => {
    const r = runPipeline(
      {
        "src/a.ts": body("one"),
        "src/b.ts": body("two"),
        "src/c.ts": body("three"),
      },
      { thresholds: { duplicateMinNodes: 20 } },
    );
    const g = find(r, "STR001");
    expect(g).toHaveLength(1);
    expect(g[0].certainty).toBe("INDICATOR");
    expect(g[0].evidence).toHaveLength(3);
  });

  it("STR001 needs the minimum group size", () => {
    const r = runPipeline(
      { "src/a.ts": body("one"), "src/b.ts": body("two") },
      { thresholds: { duplicateMinNodes: 20 } },
    );
    expect(find(r, "STR001")).toHaveLength(0);
  });

  it("STR002 reports empty modules but not broken ones", () => {
    const r = runPipeline({ ...fixtures.empty, ...fixtures.invalidSyntax });
    const paths = find(r, "STR002").map((f) => f.subjectPath);
    expect(paths).toContain("src/empty.ts");
    expect(paths).not.toContain("src/broken.ts");
  });
});

describe("security indicator rules", () => {
  const run = (code: string) =>
    runPipeline({ "src/s.ts": code }).result.findings.filter(
      (f) => f.category === "SECURITY",
    );

  it("never emits a confirmed certainty or CRITICAL severity", () => {
    const all = run(`
      const k = "AKIAABCDEFGHIJKLMNOP";
      eval(input); new Function(x);
      require("child_process").exec(cmd);
      el.innerHTML = html;
      const agent = { rejectUnauthorized: false };
      crypto.createHash("md5");
    `);
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const f of all) {
      expect(f.certainty).toBe("INDICATOR");
      expect(f.severity).not.toBe("CRITICAL");
      expect(f.title.startsWith("Possible")).toBe(true);
      expect(f.description).toMatch(/not a confirmed vulnerability/);
    }
  });

  it("distinguishes dynamic from static evaluation", () => {
    expect(run(`eval("1+1");`)[0].severity).toBe("LOW");
    expect(run(`eval(userInput);`)[0].severity).toBe("MEDIUM");
  });

  it("does not flag safe look-alikes", () => {
    expect(
      run(
        `const a = { eval: 1 }; obj.exec(cmd); el.textContent = x; crypto.createHash("sha256");`,
      ),
    ).toHaveLength(0);
  });

  it("never stores a credential value", () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const pw = "hunter2-very-secret-value";
    const r = runPipeline({
      "src/c.ts": `const key = "${secret}";\nconst password = "${pw}";\n`,
    });
    const json = JSON.stringify(r.result);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(pw);
    expect(r.result.findings.filter((f) => f.ruleId === "SEC004").length).toBe(
      2,
    );
  });

  it("ignores placeholders and env lookups for credentials", () => {
    expect(
      run(
        `const password = process.env.PASSWORD;\nconst token = "";\nconst apiKey = "your-api-key";`,
      ),
    ).toHaveLength(0);
  });

  it("keeps the subject key stable when code moves within a file", () => {
    const a = run(`eval(x);`);
    const b = run(`\n\n\n// moved\neval(x);`);
    expect(b[0].fingerprint).toBe(a[0].fingerprint);
    expect(b[0].primaryLine).not.toBe(a[0].primaryLine);
  });
});

describe("DEP004 possibly unused export", () => {
  const lib = `export function used() { return 1; }\nexport function spare() { return 2; }\nexport default function def() {}\n`;

  it("reports unreferenced named exports as INFO indicators", () => {
    const r = runPipeline({
      "src/lib.ts": lib,
      "src/a.ts": `import { used } from "./lib";\nexport const a = used();\n`,
    });
    const f = find(r, "DEP004");
    expect(f.map((x) => x.title).sort()).toEqual([
      'Export "def" is not imported anywhere',
      'Export "spare" is not imported anywhere',
    ]);
    expect(
      f.every((x) => x.severity === "INFO" && x.certainty === "INDICATOR"),
    ).toBe(true);
  });

  it("counts default and named re-use and does not judge opaque importers", () => {
    const withDefault = runPipeline({
      "src/lib.ts": lib,
      "src/a.ts": `import def, { used, spare } from "./lib";\nexport const a = [def, used, spare];\n`,
    });
    expect(find(withDefault, "DEP004")).toHaveLength(0);

    for (const importer of [
      `import * as lib from "./lib";\nexport const a = lib;\n`,
      `export * from "./lib";\n`,
      `export const load = () => import("./lib");\n`,
      `const lib = require("./lib");\nexport const a = lib;\n`,
      `import "./lib";\n`,
    ]) {
      const r = runPipeline({ "src/lib.ts": lib, "src/a.ts": importer });
      expect(find(r, "DEP004")).toHaveLength(0);
    }
  });

  it("ignores modules nobody imports (possible entry points) and partial analyses", () => {
    expect(find(runPipeline({ "src/lib.ts": lib }), "DEP004")).toHaveLength(0);
    const partial = runPipeline(
      {
        "src/lib.ts": lib,
        "src/a.ts": `import { used } from "./lib";\nexport const a = used();\n`,
      },
      { completeness: "PARTIAL" },
    );
    expect(find(partial, "DEP004")).toHaveLength(0);
    expect(
      partial.result.ruleRuns.find((x) => x.ruleId === "DEP004")?.status,
    ).toBe("SKIPPED");
  });

  it("treats re-exported names as used", () => {
    const r = runPipeline({
      "src/lib.ts": lib,
      "src/mid.ts": `export { used, spare } from "./lib";\n`,
      "src/a.ts": `import def from "./lib";\nexport const a = def;\n`,
    });
    expect(find(r, "DEP004")).toHaveLength(0);
  });
});
