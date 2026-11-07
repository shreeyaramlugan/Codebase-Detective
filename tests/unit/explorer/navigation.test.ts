// tests/unit/explorer/navigation.test.ts
import { describe, expect, it } from "vitest";

import {
  explorerHref,
  isSafeRepositoryPath,
  parseExplorerState,
} from "@/features/explorer/navigation/explorer-url";
import { deriveOverviewState } from "@/features/explorer/overview-state";
import {
  navigationForResult,
  type SearchSelection,
} from "@/features/explorer/search/search-model";

describe("explorer URL state", () => {
  it("round-trips a full state", () => {
    const href = explorerHref("repo_1", {
      view: "files",
      analysis: "ana_1",
      file: "src/a b.ts",
      line: 12,
      symbol: "sym_1",
      q: "hello world",
    });
    const query = new URL(href, "http://x").searchParams;
    expect(parseExplorerState(query)).toEqual({
      view: "files",
      analysis: "ana_1",
      file: "src/a b.ts",
      line: 12,
      symbol: "sym_1",
      q: "hello world",
    });
  });

  it("omits defaults from the URL", () => {
    expect(explorerHref("r1", {})).toBe("/dashboard/repositories/r1");
  });

  it("rejects unsafe or malformed values", () => {
    const state = parseExplorerState(
      new URLSearchParams({
        view: "admin",
        analysis: "../../etc",
        file: "../secret",
        line: "-4",
        symbol: "a b",
        q: "x".repeat(500),
      }),
    );
    expect(state).toMatchObject({
      view: "overview",
      analysis: null,
      file: null,
      line: null,
      symbol: null,
    });
    expect(state.q).toHaveLength(100);
  });

  it("accepts Next-style record search params", () => {
    expect(
      parseExplorerState({ view: ["graph", "files"], line: "3" }).view,
    ).toBe("graph");
  });

  it("validates repository paths", () => {
    for (const bad of [
      "",
      "/abs",
      "a/../b",
      "a//b",
      "a\\b",
      "a/./b",
      "a\0b",
      "x".repeat(1025),
    ]) {
      expect(isSafeRepositoryPath(bad)).toBe(false);
    }
    expect(isSafeRepositoryPath("src/a.ts")).toBe(true);
  });

  it("encodes the repository id in links", () => {
    expect(explorerHref("a/b", {})).toBe("/dashboard/repositories/a%2Fb");
  });
});

describe("search navigation", () => {
  const symbol = {
    id: "s1",
    name: "run",
    qualifiedName: "Runner.run",
    kind: "METHOD",
    path: "src/runner.ts",
    startLine: 40,
    startColumn: 3,
    isExported: false,
  };

  it("opens files, symbols, exports and modules in the right place", () => {
    const cases: Array<[SearchSelection, object]> = [
      [
        {
          category: "files",
          item: {
            path: "a.ts",
            name: "a.ts",
            status: "ANALYSED",
            symbolCount: 1,
          },
        },
        { view: "files", file: "a.ts", line: null },
      ],
      [
        { category: "symbols", item: symbol },
        { view: "files", file: "src/runner.ts", line: 40, symbol: "s1" },
      ],
      [
        {
          category: "exports",
          item: { ...symbol, exportNames: ["run"], isDefaultExport: false },
        },
        { view: "files", file: "src/runner.ts", line: 40, symbol: "s1" },
      ],
      [
        {
          category: "modules",
          item: {
            specifier: "./util",
            status: "RESOLVED",
            targetPath: "src/util.ts",
            externalPackage: null,
            importedBy: { path: "src/a.ts", line: 2 },
          },
        },
        { view: "files", file: "src/util.ts", line: null },
      ],
      [
        {
          category: "modules",
          item: {
            specifier: "react",
            status: "EXTERNAL",
            targetPath: null,
            externalPackage: "react",
            importedBy: { path: "src/a.ts", line: 1 },
          },
        },
        { view: "files", file: "src/a.ts", line: 1 },
      ],
    ];

    for (const [selection, expected] of cases) {
      expect(navigationForResult(selection)).toEqual(expected);
    }
  });
});

describe("deriveOverviewState", () => {
  const completeSnap = { status: "COMPLETED", completeness: "COMPLETE" };
  const analysis = (
    status: string,
    completeness: string | null = "COMPLETE",
  ) => ({
    status,
    snapshotCompleteness: completeness,
    errorMessage: status === "FAILED" ? "boom" : null,
  });

  it("covers every state", () => {
    expect(deriveOverviewState({ snapshot: null, analysis: null }).kind).toBe(
      "no_snapshot",
    );
    expect(
      deriveOverviewState({
        snapshot: { status: "PROCESSING", completeness: null },
        analysis: null,
      }),
    ).toMatchObject({ kind: "snapshot_not_ready", explorable: false });
    expect(
      deriveOverviewState({
        snapshot: { status: "FAILED", completeness: null },
        analysis: null,
      }).tone,
    ).toBe("error");
    expect(
      deriveOverviewState({ snapshot: completeSnap, analysis: null }).kind,
    ).toBe("no_analysis");
    expect(
      deriveOverviewState({
        snapshot: completeSnap,
        analysis: analysis("PROCESSING"),
      }).kind,
    ).toBe("analysis_running");
    expect(
      deriveOverviewState({
        snapshot: completeSnap,
        analysis: analysis("FAILED"),
      }),
    ).toMatchObject({
      kind: "analysis_failed",
      message: "boom",
      explorable: false,
    });
    expect(
      deriveOverviewState({
        snapshot: completeSnap,
        analysis: analysis("PARTIAL"),
      }),
    ).toMatchObject({
      kind: "ready_partial",
      explorable: true,
    });
    expect(
      deriveOverviewState({
        snapshot: completeSnap,
        analysis: analysis("COMPLETED", "PARTIAL"),
      }).kind,
    ).toBe("ready_partial");
    expect(
      deriveOverviewState({
        snapshot: completeSnap,
        analysis: analysis("COMPLETED"),
      }),
    ).toMatchObject({
      kind: "ready",
      explorable: true,
    });
  });
});
