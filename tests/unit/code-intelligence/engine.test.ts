// tests/unit/code-intelligence/engine.test.ts
import { describe, expect, it } from "vitest";

import { ANALYSIS_LIMITS } from "@/features/code-intelligence/contracts";
import { analyzeSnapshotSources } from "@/features/code-intelligence/engine/analyze-snapshot";
import {
  analyze,
  fixtures,
  largeSource,
  sourceFile,
  toEngineInput,
} from "../../fixtures/code-intelligence/projects";

describe("analysis pipeline", () => {
  it("analyses every fixture language", () => {
    for (const project of [
      fixtures.javascript,
      fixtures.typescript,
      fixtures.jsx,
      fixtures.tsx,
    ]) {
      const { records, stats } = analyze(project);
      expect(stats.filesWithSyntaxErrors).toBe(0);
      expect(records.symbols.length).toBeGreaterThan(0);
    }
  });

  it("continues after a malformed file and records diagnostics", () => {
    const { records, stats } = analyze(fixtures.invalidSyntax);
    const broken = records.files.find((f) => f.path === "src/broken.ts")!;
    const ok = records.files.find((f) => f.path === "src/ok.ts")!;
    expect(broken.status).toBe("ANALYSED_WITH_ERRORS");
    expect(broken.syntaxErrorCount).toBeGreaterThan(0);
    expect(ok.status).toBe("ANALYSED");
    expect(records.symbols.some((s) => s.filePath === "src/ok.ts")).toBe(true);
    expect(
      records.diagnostics.some(
        (d) => d.source === "PARSER" && d.path === "src/broken.ts",
      ),
    ).toBe(true);
    expect(stats.filesWithSyntaxErrors).toBe(1);
  });

  it("handles empty files", () => {
    const { records } = analyze(fixtures.empty);
    expect(records.files.every((f) => f.status === "ANALYSED")).toBe(true);
    expect(records.symbols).toHaveLength(0);
    expect(
      records.files.find((f) => f.path === "src/empty.ts")!.lineCount,
    ).toBe(0);
  });

  it("isolates a file that crashes the parser instead of ending the run", () => {
    const pathological = `const x = ${"(".repeat(200_000)}1${")".repeat(200_000)};`;
    const { records } = analyze({
      "src/deep.ts": pathological,
      "src/ok.ts": "export const a = 1;",
    });
    expect(records.files.find((f) => f.path === "src/deep.ts")!.status).toBe(
      "FAILED",
    );
    expect(records.files.find((f) => f.path === "src/ok.ts")!.status).toBe(
      "ANALYSED",
    );
    expect(
      records.diagnostics.some((d) => d.code === "FILE_ANALYSIS_FAILED"),
    ).toBe(true);
  });

  it("skips and diagnoses oversized source", () => {
    const big = "a".repeat(ANALYSIS_LIMITS.MAX_FILE_BYTES + 1);
    const { records, stats } = analyze({
      "src/big.ts": `// ${big}`,
      "src/ok.ts": "export const a = 1;",
    });
    expect(records.files.find((f) => f.path === "src/big.ts")).toMatchObject({
      status: "SKIPPED",
    });
    expect(records.diagnostics.some((d) => d.code === "OVERSIZED_SOURCE")).toBe(
      true,
    );
    expect(stats.filesSkipped).toBe(1);
  });

  it("handles large (but allowed) files", () => {
    const { records } = analyze({ "src/large.ts": largeSource(5000) });
    expect(records.symbols).toHaveLength(5000);
  });

  it("diagnoses unsupported extensions passed to the engine", () => {
    const input = toEngineInput({});
    const { records } = analyzeSnapshotSources({
      ...input,
      sources: [sourceFile("src/a.py", "x = 1")],
    });
    expect(records.files[0]).toMatchObject({ status: "SKIPPED" });
    expect(
      records.diagnostics.some((d) => d.code === "UNSUPPORTED_EXTENSION"),
    ).toBe(true);
  });

  it("never executes malicious source", () => {
    const flag = "__cd_pipeline_executed__";
    analyze({
      "src/evil.js": `globalThis.${flag} = 1; require("child_process").execSync("touch /tmp/pwned"); process.exit(1);`,
      "src/evil.ts": `(globalThis as any).${flag} = 1; import("fs").then(f => f.rmSync("/", { recursive: true }));`,
    });
    expect((globalThis as Record<string, unknown>)[flag]).toBeUndefined();
  });

  it("is deterministic for identical inputs regardless of file order", () => {
    const entries = Object.entries({
      ...fixtures.aliases,
      ...fixtures.reexports,
      ...fixtures.commonjs,
    });
    const forward = analyze(Object.fromEntries(entries));
    const backward = analyze(Object.fromEntries([...entries].reverse()));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(backward));
  });

  it("represents partial snapshots honestly in resolution reasons", () => {
    const { records } = analyze(
      { "src/a.ts": `import { x } from "./cut";` },
      {
        completeness: "PARTIAL",
        unavailable: [{ path: "src/cut.ts", reason: "SKIPPED: too large" }],
      },
    );
    expect(records.dependencies[0].status).toBe("UNRESOLVED");
    expect(records.dependencies[0].reason).toContain("too large");
    expect(records.dependencies[0].reason).toContain("partial");
  });

  it("records file hashes and script kinds for future incremental analysis", () => {
    const { records } = analyze(fixtures.typescript);
    for (const file of records.files) {
      expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(file.fileId).toBe(`file:${file.path}`);
      expect(file.scriptKind).toBe("TS");
    }
  });

  it("records config files and keeps them out of the symbol set", () => {
    const { records } = analyze(fixtures.aliases);
    expect(records.files.find((f) => f.path === "tsconfig.json")).toMatchObject(
      { status: "CONFIG" },
    );
  });
});
