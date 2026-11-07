// tests/unit/explorer/file-tree.test.ts
import { describe, expect, it } from "vitest";

import {
  ancestorPaths,
  buildFileTree,
  describeAvailability,
  fileTypeBadge,
  filterEntries,
  flattenVisible,
  type TreeFileEntry,
} from "@/features/explorer/tree/file-tree";
import { scrollTopForIndex, visibleWindow } from "@/features/explorer/virtual";

function entry(path: string, over: Partial<TreeFileEntry> = {}): TreeFileEntry {
  return {
    path,
    name: path.split("/").pop()!,
    extension: path.includes(".") ? path.slice(path.lastIndexOf(".")) : null,
    snapshotStatus: "STORED",
    skipReason: null,
    failureCode: null,
    analysisFileId: `af-${path}`,
    analysisStatus: "ANALYSED",
    sizeBytes: 10,
    lineCount: 1,
    symbolCount: 0,
    syntaxErrorCount: 0,
    ...over,
  };
}

const entries = [
  entry("src/index.ts"),
  entry("src/lib/util.ts"),
  entry("src/lib/deep/more.ts"),
  entry("README.md", { analysisFileId: null, analysisStatus: null }),
  entry("assets/big.bin", {
    snapshotStatus: "SKIPPED",
    skipReason: "Too large",
    analysisFileId: null,
    analysisStatus: null,
  }),
  entry("src/broken.ts", {
    snapshotStatus: "FAILED",
    failureCode: "BLOB_FETCH_FAILED",
    analysisFileId: null,
    analysisStatus: null,
  }),
];

describe("buildFileTree", () => {
  it("represents the hierarchy with directories before files", () => {
    const root = buildFileTree(entries);
    expect(root.children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      "dir:assets",
      "dir:src",
      "file:README.md",
    ]);

    const src = root.children[1];
    if (src.kind !== "dir") throw new Error("expected dir");
    expect(src.children.map((c) => c.name)).toEqual([
      "lib",
      "broken.ts",
      "index.ts",
    ]);
    expect(src.fileCount).toBe(4);
  });

  it("handles an empty repository", () => {
    const root = buildFileTree([]);
    expect(root.children).toHaveLength(0);
    expect(flattenVisible(root, new Set())).toHaveLength(0);
  });

  it("ignores empty path segments instead of creating phantom folders", () => {
    const root = buildFileTree([entry("a//b.ts")]);
    expect(root.children[0].name).toBe("a");
    const a = root.children[0];
    if (a.kind !== "dir") throw new Error("expected dir");
    expect(a.children[0].path).toBe("a/b.ts");
  });
});

describe("flattenVisible", () => {
  it("shows only the top level while folders are collapsed", () => {
    const rows = flattenVisible(buildFileTree(entries), new Set());
    expect(rows.map((r) => r.node.path)).toEqual([
      "assets",
      "src",
      "README.md",
    ]);
  });

  it("expands and collapses folders", () => {
    const root = buildFileTree(entries);
    const open = flattenVisible(root, new Set(["src"]));
    expect(open.map((r) => r.node.path)).toEqual([
      "assets",
      "src",
      "src/lib",
      "src/broken.ts",
      "src/index.ts",
      "README.md",
    ]);
    expect(open.find((r) => r.node.path === "src/lib")?.depth).toBe(1);

    const closed = flattenVisible(root, new Set());
    expect(closed.length).toBeLessThan(open.length);
  });

  it("expands everything on request", () => {
    const rows = flattenVisible(buildFileTree(entries), new Set(), true);
    expect(rows.some((r) => r.node.path === "src/lib/deep/more.ts")).toBe(true);
  });

  it("survives a very deep tree without recursion limits", () => {
    const deep = Array.from({ length: 4000 }, (_, i) => `d${i}`).join("/");
    const root = buildFileTree([entry(`${deep}/leaf.ts`)]);
    const rows = flattenVisible(root, new Set(), true);
    expect(rows).toHaveLength(4001);
  });
});

describe("filterEntries", () => {
  it("filters by path text, case-insensitively", () => {
    expect(
      filterEntries(entries, { query: "UTIL" }).map((e) => e.path),
    ).toEqual(["src/lib/util.ts"]);
  });

  it("filters by availability and combines with text", () => {
    expect(
      filterEntries(entries, { availability: ["skipped", "failed"] }).map(
        (e) => e.path,
      ),
    ).toEqual(["assets/big.bin", "src/broken.ts"]);

    expect(
      filterEntries(entries, { query: "src", availability: ["failed"] }),
    ).toHaveLength(1);
  });

  it("returns everything for an empty filter", () => {
    expect(filterEntries(entries, {})).toHaveLength(entries.length);
  });
});

describe("describeAvailability", () => {
  it("distinguishes skipped, failed, stored-but-unanalysed and analysed", () => {
    const by = (p: string) =>
      describeAvailability(entries.find((e) => e.path === p)!);

    expect(by("assets/big.bin")).toMatchObject({
      availability: "skipped",
      viewable: false,
      detail: "Too large",
    });
    expect(by("src/broken.ts")).toMatchObject({
      availability: "failed",
      viewable: false,
    });
    expect(by("README.md")).toMatchObject({
      availability: "stored",
      viewable: true,
    });
    expect(by("src/index.ts")).toMatchObject({
      availability: "analysed",
      viewable: true,
    });
  });

  it("flags syntax errors and failed analysis of stored files", () => {
    expect(
      describeAvailability(
        entry("a.ts", { analysisStatus: "ANALYSED_WITH_ERRORS" }),
      ).availability,
    ).toBe("analysed_with_errors");
    expect(
      describeAvailability(entry("a.ts", { analysisStatus: "FAILED" })),
    ).toMatchObject({ availability: "failed", viewable: true });
  });
});

describe("helpers", () => {
  it("lists ancestors for revealing a file", () => {
    expect(ancestorPaths("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestorPaths("c.ts")).toEqual([]);
  });

  it("badges file types", () => {
    expect(fileTypeBadge(".tsx", "a.tsx")).toBe("TSX");
    expect(fileTypeBadge(null, ".env.example")).toBe("CFG");
    expect(fileTypeBadge(null, "Makefile")).toBe("TXT");
  });
});

describe("virtual windowing", () => {
  it("renders only a window of a large list", () => {
    const w = visibleWindow(100_000, 28_000, 400, 28, 5);
    expect(w.start).toBe(995);
    expect(w.end - w.start).toBeLessThan(40);
    expect(w.totalHeight).toBe(2_800_000);
    expect(w.offsetTop).toBe(995 * 28);
  });

  it("clamps at both ends and handles empty lists", () => {
    expect(visibleWindow(0, 0, 400, 28)).toMatchObject({ start: 0, end: 0 });
    const w = visibleWindow(10, 99_999, 400, 28);
    expect(w.end).toBe(10);
    expect(w.start).toBeLessThan(11);
  });

  it("computes a scroll position for a target index", () => {
    expect(scrollTopForIndex(0, 100, 300, 20)).toBe(0);
    expect(scrollTopForIndex(50, 100, 300, 20)).toBe(900);
    expect(scrollTopForIndex(99999, 100, 300, 20)).toBe(1700);
  });
});
