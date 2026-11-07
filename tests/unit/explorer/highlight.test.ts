// tests/unit/explorer/highlight.test.ts
import { describe, expect, it } from "vitest";

import {
  MAX_HIGHLIGHT_LENGTH,
  highlightSource,
  languageForPath,
  splitLines,
} from "@/features/explorer/source/highlight";

const kinds = (tokens: Array<{ kind: string; text: string }>) =>
  tokens.map((t) => `${t.kind}:${t.text}`);

describe("splitLines", () => {
  it("uses the same terminators as the TypeScript scanner", () => {
    expect(splitLines("a\r\nb\nc\rd e f")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ]);
  });

  it("keeps a trailing empty line like the analysis line count", () => {
    expect(splitLines("a\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([""]);
  });
});

describe("languageForPath", () => {
  it("detects scripts, json and plain text", () => {
    expect(languageForPath("src/a.tsx")).toBe("script");
    expect(languageForPath("a.MJS")).toBe("script");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("README.md")).toBe("plain");
    expect(languageForPath("Makefile")).toBe("plain");
  });
});

describe("highlightSource", () => {
  it("tokenizes keywords, strings, numbers and comments", () => {
    const { lines } = highlightSource(
      `const x = "hi"; // note\nreturn 42;`,
      "a.ts",
    );
    expect(kinds(lines[0])).toEqual([
      "keyword:const",
      "plain: x = ",
      'string:"hi"',
      "plain:; ",
      "comment:// note",
    ]);
    expect(kinds(lines[1])).toEqual([
      "keyword:return",
      "plain: ",
      "number:42",
      "plain:;",
    ]);
  });

  it("carries block comments and template literals across lines", () => {
    const { lines } = highlightSource(
      "/* a\n b */ let y = `one\ntwo`;\nconst z = 1;",
      "a.ts",
    );
    expect(lines).toHaveLength(4);
    expect(lines[0][0].kind).toBe("comment");
    expect(lines[1][0]).toEqual({ kind: "comment", text: " b */" });
    expect(lines[2][0].kind).toBe("string");
    expect(lines[3][0]).toEqual({ kind: "keyword", text: "const" });
  });

  it("keeps escaped quotes inside strings", () => {
    const { lines } = highlightSource(`x = "a\\"b";`, "a.ts");
    expect(lines[0].filter((t) => t.kind === "string")[0].text).toBe('"a\\"b"');
  });

  it("does not treat comments or keywords as special in JSON", () => {
    const { lines } = highlightSource(`{"type": "x", "ok": true}`, "a.json");
    expect(lines[0].some((t) => t.kind === "keyword")).toBe(false);
    expect(
      lines[0].some((t) => t.kind === "literal" && t.text === "true"),
    ).toBe(true);
  });

  it("returns one plain token per line for unknown file types", () => {
    const out = highlightSource("const a = 1\nsecond", "notes.md");
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toEqual([{ kind: "plain", text: "const a = 1" }]);
    expect(out.highlightSkipped).toBe(false);
  });

  it("preserves the original text exactly, line for line", () => {
    const source =
      "import a from 'b';\n\nexport default function f() { return `x`; }\n";
    const { lines } = highlightSource(source, "a.ts");
    const rebuilt = lines.map((l) => l.map((t) => t.text).join("")).join("\n");
    expect(rebuilt).toBe(source);
  });

  it("never turns markup into anything but text", () => {
    const hostile = `const a = "<script>alert(1)</script>"; // <img src=x onerror=alert(1)>`;
    const { lines } = highlightSource(hostile, "a.ts");
    expect(lines[0].map((t) => t.text).join("")).toBe(hostile);
  });

  it("skips highlighting, but keeps lines, for very large files", () => {
    const big = "const a = 1;\n".repeat(
      Math.ceil(MAX_HIGHLIGHT_LENGTH / 12) + 10,
    );
    const out = highlightSource(big, "big.ts");
    expect(out.highlightSkipped).toBe(true);
    expect(out.lines.length).toBeGreaterThan(40_000);
    expect(out.lines[0]).toEqual([{ kind: "plain", text: "const a = 1;" }]);
  });

  it("handles an empty file", () => {
    const out = highlightSource("", "a.ts");
    expect(out.lines).toEqual([[]]);
  });

  it("line numbers match the engine's line breaks for CRLF files", () => {
    const { lines } = highlightSource("a\r\nb\r\nc", "a.ts");
    expect(lines).toHaveLength(3);
    expect(lines[2].map((t) => t.text).join("")).toBe("c");
  });
});
