// tests/unit/code-intelligence/parser.test.ts
import { describe, expect, it } from "vitest";

import {
  getDeclaredModuleSyntax,
  getScriptKindName,
  isSupportedSourcePath,
} from "@/features/code-intelligence/parser/script-kind";
import {
  PARSER_VERSION,
  UnsupportedSourceError,
  parseSource,
} from "@/features/code-intelligence/parser/source-parser";

describe("script kind selection", () => {
  it("recognises every supported extension", () => {
    expect(getScriptKindName("a.js")).toBe("JS");
    expect(getScriptKindName("a.jsx")).toBe("JSX");
    expect(getScriptKindName("a.ts")).toBe("TS");
    expect(getScriptKindName("a.tsx")).toBe("TSX");
    expect(getScriptKindName("a.mjs")).toBe("JS");
    expect(getScriptKindName("a.cjs")).toBe("JS");
  });

  it("rejects unsupported extensions", () => {
    expect(getScriptKindName("a.json")).toBeNull();
    expect(getScriptKindName("Makefile")).toBeNull();
    expect(isSupportedSourcePath("a.py")).toBe(false);
  });

  it("treats .mjs as ESM and .cjs as CommonJS", () => {
    expect(getDeclaredModuleSyntax("a.mjs")).toBe("ESM");
    expect(getDeclaredModuleSyntax("a.cjs")).toBe("COMMONJS");
    expect(getDeclaredModuleSyntax("a.ts")).toBe("UNKNOWN");
  });
});

describe("parseSource", () => {
  it("parses valid files without diagnostics", () => {
    const parsed = parseSource("a.ts", "export const a: number = 1;\n");
    expect(parsed.syntaxDiagnostics).toHaveLength(0);
    expect(parsed.scriptKind).toBe("TS");
    expect(parsed.sourceFile.statements.length).toBe(1);
  });

  it("parses JSX and TSX", () => {
    expect(
      parseSource("a.jsx", "const a = <div/>;").syntaxDiagnostics,
    ).toHaveLength(0);
    expect(
      parseSource("a.tsx", "const a = <div/>;").syntaxDiagnostics,
    ).toHaveLength(0);
  });

  it("does not parse JSX as valid plain TypeScript", () => {
    expect(
      parseSource("a.ts", "const a = <div/>;").syntaxDiagnostics.length,
    ).toBeGreaterThan(0);
  });

  it("returns structured diagnostics with 1-based positions", () => {
    const parsed = parseSource("bad.ts", "const a = 1;\nfunction ( {\n");
    expect(parsed.syntaxDiagnostics.length).toBeGreaterThan(0);
    const first = parsed.syntaxDiagnostics[0];
    expect(first.severity).toBe("ERROR");
    expect(first.source).toBe("PARSER");
    expect(first.path).toBe("bad.ts");
    expect(first.line).toBe(2);
    expect(first.code).toMatch(/^TS\d+$/);
  });

  it("handles empty files safely", () => {
    const parsed = parseSource("empty.ts", "");
    expect(parsed.syntaxDiagnostics).toHaveLength(0);
    expect(parsed.lineCount).toBe(0);
  });

  it("strips a byte order mark so positions are not shifted", () => {
    const parsed = parseSource("a.ts", "﻿const a = 1;");
    expect(parsed.sourceFile.text.startsWith("const")).toBe(true);
  });

  it("throws for unsupported extensions", () => {
    expect(() => parseSource("a.py", "x = 1")).toThrow(UnsupportedSourceError);
  });

  it("never executes repository code", () => {
    const flag = "__cd_executed__";
    const malicious = `globalThis.${flag} = true; throw new Error("boom"); process.exit(1);`;
    parseSource("evil.js", malicious);
    parseSource("evil.ts", `(globalThis as any).${flag} = true;`);
    expect((globalThis as Record<string, unknown>)[flag]).toBeUndefined();
  });

  it("records the parser version", () => {
    expect(PARSER_VERSION).toMatch(/^typescript@/);
  });
});
