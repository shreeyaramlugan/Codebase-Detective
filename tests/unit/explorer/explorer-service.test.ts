// tests/unit/explorer/explorer-service.test.ts
//
// The service takes an injectable client, so these tests use a recording fake:
// they verify the QUERIES (ownership, single-analysis scoping, filters,
// limits) and the mapping of returned rows. They do not run SQL.
import { describe, expect, it } from "vitest";

import { AnalysisError } from "../../../lib/analysis/analysis.errors";
import {
  getAnalysisStats,
  getAnalysisTree,
  getExplorerSymbol,
  getRepositoryExplorerOverview,
  listExplorerSymbols,
  normaliseSearchQuery,
  searchAnalysis,
  type ExplorerDb,
} from "@/lib/explorer/explorer.service";

type Call = { op: string; args: any };
type Handler = (args: any) => unknown;

function makeDb(handlers: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const models = [
    "repository",
    "repositorySnapshot",
    "codeAnalysis",
    "analysisFile",
    "snapshotFile",
    "codeSymbol",
    "moduleDependency",
    "codeCall",
    "codeRelation",
    "analysisDiagnostic",
    "analysisGraph",
  ];
  const fallback: Record<string, unknown> = {
    findFirst: null,
    findMany: [],
    groupBy: [],
    count: 0,
  };
  const db: Record<string, unknown> = {};

  for (const model of models) {
    const api: Record<string, unknown> = {};
    for (const method of Object.keys(fallback)) {
      api[method] = async (args: any) => {
        const op = `${model}.${method}`;
        calls.push({ op, args });
        return handlers[op] ? handlers[op](args) : fallback[method];
      };
    }
    db[model] = api;
  }

  return {
    db: db as unknown as ExplorerDb,
    calls,
    of: (op: string) => calls.filter((c) => c.op === op),
  };
}

const date = new Date("2026-11-01T10:00:00Z");
const analysisRow = (over: Record<string, unknown> = {}) => ({
  id: "ana-1",
  snapshotId: "snap-1",
  repositoryId: "repo-1",
  commitSha: "abc1234",
  status: "COMPLETED",
  snapshotCompleteness: "COMPLETE",
  engineVersion: "1",
  parserVersion: "1",
  stats: null,
  errorCode: null,
  errorMessage: null,
  startedAt: date,
  completedAt: date,
  createdAt: date,
  ...over,
});

const snapshotRow = (id: string, status = "COMPLETED", over = {}) => ({
  id,
  commitSha: `sha-${id}`,
  commitMessage: "msg",
  status,
  completeness: "COMPLETE",
  totalFiles: 3,
  eligibleFiles: 3,
  storedFiles: 3,
  skippedFiles: 0,
  failedFiles: 0,
  totalBytes: BigInt(100),
  startedAt: date,
  completedAt: date,
  createdAt: date,
  branchName: "main",
  commitAuthor: "Ada",
  committedAt: date,
  ...over,
});

async function rejectsWith(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error instanceof AnalysisError).toBe(true);
  expect((error as AnalysisError).code).toBe(code);
}

describe("ownership scoping", () => {
  it("every analysis-scoped call checks the owner and 404s for non-owners", async () => {
    const { db } = makeDb(); // codeAnalysis.findFirst -> null
    await rejectsWith(getAnalysisTree("u1", "a1", db), "NOT_FOUND");
    await rejectsWith(listExplorerSymbols("u1", "a1", {}, db), "NOT_FOUND");
    await rejectsWith(getExplorerSymbol("u1", "a1", "s1", db), "NOT_FOUND");
    await rejectsWith(
      searchAnalysis("u1", "a1", { q: "abc" }, db),
      "NOT_FOUND",
    );
    await rejectsWith(
      getRepositoryExplorerOverview("u1", "r1", {}, db),
      "NOT_FOUND",
    );
  });

  it("puts the owner in the WHERE clause", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await getAnalysisTree("user-9", "ana-1", db);
    expect(of("codeAnalysis.findFirst")[0].args.where).toEqual({
      id: "ana-1",
      repository: { ownerId: "user-9" },
    });
  });

  it("scopes every data query to the single checked analysis", async () => {
    const { db, calls } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await getAnalysisTree("u", "ana-1", db);
    await listExplorerSymbols("u", "ana-1", { q: "x" }, db);
    await searchAnalysis("u", "ana-1", { q: "abc" }, db);
    await getAnalysisStats("ana-1", db);

    const data = calls.filter(
      (c) =>
        c.op !== "codeAnalysis.findFirst" && c.op !== "snapshotFile.findMany",
    );
    expect(data.length).toBeGreaterThan(8);
    for (const call of data) {
      expect(call.args.where.analysisId).toBe("ana-1");
    }
  });

  it("rejects a symbol that belongs to a different analysis", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await rejectsWith(
      getExplorerSymbol("u", "ana-1", "sym-other", db),
      "NOT_FOUND",
    );
    expect(of("codeSymbol.findFirst")[0].args.where).toEqual({
      analysisId: "ana-1",
      OR: [{ id: "sym-other" }, { stableKey: "sym-other" }],
    });
  });
});

describe("getRepositoryExplorerOverview", () => {
  const repo = {
    id: "repo-1",
    ownerLogin: "octo",
    name: "hello",
    fullName: "octo/hello",
    htmlUrl: "https://github.com/octo/hello",
    description: null,
    visibility: "PUBLIC",
    defaultBranch: "main",
    language: "TypeScript",
    stars: 1,
    forks: 0,
    status: "INDEXED",
  };

  it("selects the latest completed snapshot and its latest usable analysis", async () => {
    const { db } = makeDb({
      "repository.findFirst": () => repo,
      "repositorySnapshot.findMany": () => [
        snapshotRow("snap-new", "PROCESSING"),
        snapshotRow("snap-ok"),
      ],
      "codeAnalysis.findMany": () => [
        analysisRow({
          id: "ana-failed",
          status: "FAILED",
          snapshotId: "snap-ok",
        }),
        analysisRow({ id: "ana-good", snapshotId: "snap-ok" }),
      ],
      "analysisGraph.findFirst": () => ({
        nodeCount: 5,
        edgeCount: 4,
        schemaVersion: 1,
      }),
    });

    const result = await getRepositoryExplorerOverview("u", "repo-1", {}, db);
    expect(result.selectedSnapshotId).toBe("snap-ok");
    expect(result.selectedAnalysisId).toBe("ana-good");
    expect(result.state.kind).toBe("ready");
    expect(result.stats?.graph).toEqual({
      nodeCount: 5,
      edgeCount: 4,
      schemaVersion: 1,
    });
    expect(result.snapshots[0]).toMatchObject({
      branchName: "main",
      commitAuthor: "Ada",
    });
    expect(result.snapshots[0].totalBytes).toBe("100");
  });

  it("builds statistics from persisted rows", async () => {
    const { db } = makeDb({
      "repository.findFirst": () => repo,
      "repositorySnapshot.findMany": () => [snapshotRow("snap-1")],
      "codeAnalysis.findMany": () => [analysisRow()],
      "analysisFile.groupBy": () => [
        { status: "ANALYSED", _count: { _all: 4 } },
        { status: "SKIPPED", _count: { _all: 1 } },
      ],
      "codeSymbol.groupBy": () => [
        { kind: "FUNCTION", _count: { _all: 6 } },
        { kind: "CLASS", _count: { _all: 2 } },
      ],
      "codeSymbol.count": () => 3,
      "moduleDependency.groupBy": () => [
        { status: "RESOLVED", _count: { _all: 5 } },
        { status: "EXTERNAL", _count: { _all: 2 } },
      ],
      "codeCall.groupBy": () => [
        { resolution: "POSSIBLE", _count: { _all: 7 } },
      ],
      "codeRelation.count": () => 1,
      "analysisDiagnostic.groupBy": () => [
        { severity: "WARNING", _count: { _all: 2 } },
      ],
    });

    const { stats } = await getRepositoryExplorerOverview(
      "u",
      "repo-1",
      {},
      db,
    );
    expect(stats).toMatchObject({
      files: { total: 5, byStatus: { ANALYSED: 4, SKIPPED: 1 } },
      symbols: { total: 8, exported: 3, byKind: { FUNCTION: 6, CLASS: 2 } },
      dependencies: { total: 7, byStatus: { RESOLVED: 5, EXTERNAL: 2 } },
      calls: { total: 7, byResolution: { POSSIBLE: 7 } },
      relations: { total: 1 },
      diagnostics: { total: 2, bySeverity: { WARNING: 2 } },
      graph: null,
    });
  });

  it("does not compute statistics for failed or running analyses", async () => {
    for (const status of ["FAILED", "PROCESSING"]) {
      const { db, of } = makeDb({
        "repository.findFirst": () => repo,
        "repositorySnapshot.findMany": () => [snapshotRow("snap-1")],
        "codeAnalysis.findMany": () => [
          analysisRow({ status, errorMessage: "bad" }),
        ],
      });
      const result = await getRepositoryExplorerOverview("u", "repo-1", {}, db);
      expect(result.stats).toBeNull();
      expect(result.state.explorable).toBe(false);
      expect(of("codeSymbol.groupBy")).toHaveLength(0);
    }
  });

  it("reports partial analyses", async () => {
    const { db } = makeDb({
      "repository.findFirst": () => repo,
      "repositorySnapshot.findMany": () => [snapshotRow("snap-1")],
      "codeAnalysis.findMany": () => [analysisRow({ status: "PARTIAL" })],
    });
    const result = await getRepositoryExplorerOverview("u", "repo-1", {}, db);
    expect(result.state).toMatchObject({
      kind: "ready_partial",
      explorable: true,
    });
  });

  it("handles a repository with no snapshots", async () => {
    const { db } = makeDb({ "repository.findFirst": () => repo });
    const result = await getRepositoryExplorerOverview("u", "repo-1", {}, db);
    expect(result).toMatchObject({
      selectedSnapshotId: null,
      selectedAnalysisId: null,
      stats: null,
      analyses: [],
    });
    expect(result.state.kind).toBe("no_snapshot");
  });

  it("requires a requested analysis to belong to this repository and owner", async () => {
    const { db, of } = makeDb({
      "repository.findFirst": () => repo,
      "repositorySnapshot.findMany": () => [snapshotRow("snap-1")],
    });
    await rejectsWith(
      getRepositoryExplorerOverview(
        "u",
        "repo-1",
        { analysisId: "foreign" },
        db,
      ),
      "NOT_FOUND",
    );
    expect(of("codeAnalysis.findFirst")[0].args.where).toEqual({
      id: "foreign",
      repositoryId: "repo-1",
      repository: { ownerId: "u" },
    });
  });

  it("a requested analysis decides the snapshot", async () => {
    const { db } = makeDb({
      "repository.findFirst": () => repo,
      "repositorySnapshot.findMany": () => [
        snapshotRow("snap-new"),
        snapshotRow("snap-old"),
      ],
      "codeAnalysis.findFirst": () =>
        analysisRow({ id: "ana-old", snapshotId: "snap-old" }),
      "codeAnalysis.findMany": () => [
        analysisRow({ id: "ana-old", snapshotId: "snap-old" }),
      ],
    });
    const result = await getRepositoryExplorerOverview(
      "u",
      "repo-1",
      { analysisId: "ana-old" },
      db,
    );
    expect(result.selectedSnapshotId).toBe("snap-old");
    expect(result.selectedAnalysisId).toBe("ana-old");
  });
});

describe("getAnalysisTree", () => {
  it("merges snapshot files with analysis results and keeps skipped/failed files", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "snapshotFile.findMany": () => [
        {
          path: "a.ts",
          name: "a.ts",
          extension: ".ts",
          status: "STORED",
          skipReason: null,
          failureCode: null,
          sizeBytes: BigInt(12),
        },
        {
          path: "big.bin",
          name: "big.bin",
          extension: ".bin",
          status: "SKIPPED",
          skipReason: "Too large",
          failureCode: null,
          sizeBytes: BigInt(9999999),
        },
        {
          path: "x.ts",
          name: "x.ts",
          extension: ".ts",
          status: "FAILED",
          skipReason: null,
          failureCode: "FETCH",
          sizeBytes: null,
        },
      ],
      "analysisFile.findMany": () => [
        {
          id: "af1",
          path: "a.ts",
          extension: ".ts",
          status: "ANALYSED",
          sizeBytes: 12,
          lineCount: 3,
          symbolCount: 2,
          syntaxErrorCount: 0,
        },
      ],
    });

    const tree = await getAnalysisTree("u", "ana-1", db);
    expect(tree.truncated).toBe(false);
    expect(
      tree.entries.map((e) => [e.path, e.snapshotStatus, e.analysisStatus]),
    ).toEqual([
      ["a.ts", "STORED", "ANALYSED"],
      ["big.bin", "SKIPPED", null],
      ["x.ts", "FAILED", null],
    ]);
    expect(tree.entries[0]).toMatchObject({
      analysisFileId: "af1",
      lineCount: 3,
      symbolCount: 2,
      sizeBytes: 12,
    });
    expect(tree.entries[1].skipReason).toBe("Too large");

    // The query selects metadata only: never storage keys or hashes.
    const select = of("snapshotFile.findMany")[0].args.select;
    expect(select.storageKey).toBeUndefined();
    expect(select.contentHash).toBeUndefined();
    expect(of("snapshotFile.findMany")[0].args.where).toEqual({
      snapshotId: "snap-1",
    });
  });

  it("flags truncation instead of silently dropping files", async () => {
    const many = Array.from({ length: 25_001 }, (_, i) => ({
      path: `f${i}.ts`,
      name: `f${i}.ts`,
      extension: ".ts",
      status: "STORED",
      skipReason: null,
      failureCode: null,
      sizeBytes: BigInt(1),
    }));
    const { db } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "snapshotFile.findMany": () => many,
      "analysisFile.findMany": () => [
        {
          id: "late",
          path: "zzz.ts",
          extension: ".ts",
          status: "ANALYSED",
          sizeBytes: 1,
          lineCount: 1,
          symbolCount: 0,
          syntaxErrorCount: 0,
        },
      ],
    });
    const tree = await getAnalysisTree("u", "ana-1", db);
    expect(tree.truncated).toBe(true);
    expect(tree.entries).toHaveLength(25_001); // 25,000 + the analysed file outside the cap
    expect(tree.entries.some((e) => e.path === "zzz.ts")).toBe(true);
  });

  it("returns an empty tree for an empty snapshot", async () => {
    const { db } = makeDb({ "codeAnalysis.findFirst": () => analysisRow() });
    expect(await getAnalysisTree("u", "ana-1", db)).toMatchObject({
      entries: [],
      truncated: false,
    });
  });
});

describe("listExplorerSymbols", () => {
  const sym = (id: string, name: string, over = {}) => ({
    id,
    stableKey: `sym_${id}`,
    name,
    kind: "FUNCTION",
    qualifiedName: name,
    parentId: null,
    isExported: false,
    isDefaultExport: false,
    exportNames: [],
    startLine: 1,
    startColumn: 1,
    endLine: 2,
    endColumn: 1,
    file: { path: `src/${id}.ts` },
    ...over,
  });

  it("combines filters in one query and never mixes analyses", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "codeSymbol.findMany": () => [sym("1", "run")],
    });
    await listExplorerSymbols(
      "u",
      "ana-1",
      {
        q: "run",
        kinds: ["FUNCTION", "METHOD"],
        path: "src/1.ts",
        exported: true,
        parent: "none",
      },
      db,
    );
    const where = of("codeSymbol.findMany")[0].args.where;
    expect(where).toMatchObject({
      analysisId: "ana-1",
      kind: { in: ["FUNCTION", "METHOD"] },
      isExported: true,
      parentId: null,
      file: { path: "src/1.ts" },
    });
    expect(where.OR).toHaveLength(2);
  });

  it("paginates with a cursor and keeps duplicate names distinguishable", async () => {
    const rows = [sym("a", "dup"), sym("b", "dup"), sym("c", "dup")];
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "codeSymbol.findMany": () => rows,
    });
    const page = await listExplorerSymbols("u", "ana-1", { limit: 2 }, db);
    expect(page.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBe("b");
    expect(new Set(page.items.map((i) => i.path)).size).toBe(2);
    expect(of("codeSymbol.findMany")[0].args.take).toBe(3);

    await listExplorerSymbols("u", "ana-1", { cursor: "b", limit: 2 }, db);
    expect(of("codeSymbol.findMany")[1].args).toMatchObject({
      cursor: { id: "b" },
      skip: 1,
    });
  });

  it("returns kind facets on the first page only, ignoring the kind filter", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "codeSymbol.groupBy": () => [{ kind: "CLASS", _count: { _all: 2 } }],
    });
    const first = await listExplorerSymbols(
      "u",
      "ana-1",
      { kinds: ["FUNCTION"] },
      db,
    );
    expect(first.facets).toEqual({ CLASS: 2 });
    expect(of("codeSymbol.groupBy")[0].args.where.kind).toBeUndefined();

    const next = await listExplorerSymbols("u", "ana-1", { cursor: "x" }, db);
    expect(next.facets).toBeNull();
  });

  it("caps the page size", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await listExplorerSymbols("u", "ana-1", { limit: 99999 }, db);
    expect(of("codeSymbol.findMany")[0].args.take).toBe(201);
  });
});

describe("getExplorerSymbol", () => {
  it("returns hierarchy and relationships for one symbol", async () => {
    const brief = (id: string, name: string) => ({
      id,
      name,
      kind: "METHOD",
      qualifiedName: `C.${name}`,
      startLine: 5,
      file: { path: "src/c.ts" },
    });
    const { db } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "codeSymbol.findFirst": (args) =>
        args.where.OR?.[0]?.id === "m1"
          ? {
              id: "m1",
              stableKey: "sym_m1",
              name: "go",
              kind: "METHOD",
              qualifiedName: "C.go",
              parentId: "c1",
              isExported: false,
              isDefaultExport: false,
              exportNames: [],
              startLine: 5,
              startColumn: 3,
              endLine: 9,
              endColumn: 4,
              details: { params: [] },
              file: { path: "src/c.ts" },
            }
          : {
              id: "c1",
              name: "C",
              kind: "CLASS",
              qualifiedName: "C",
              startLine: 1,
              file: { path: "src/c.ts" },
            },
      "codeCall.findMany": (args) =>
        args.where.callerSymbolId
          ? [
              {
                calleeText: "other()",
                resolution: "CONFIRMED",
                startLine: 6,
                targetSymbol: brief("m2", "other"),
              },
            ]
          : [
              {
                resolution: "POSSIBLE",
                sourcePath: "src/x.ts",
                startLine: 3,
                callerSymbol: null,
              },
            ],
      "codeRelation.findMany": (args) =>
        args.where.sourceSymbolId
          ? [
              {
                kind: "EXTENDS",
                targetName: "B",
                status: "RESOLVED",
                targetSymbol: brief("b1", "B"),
              },
            ]
          : [],
    });

    const detail = await getExplorerSymbol("u", "ana-1", "m1", db);
    expect(detail.symbol).toMatchObject({
      id: "m1",
      path: "src/c.ts",
      location: { startLine: 5 },
    });
    expect(detail.parent).toMatchObject({ id: "c1", name: "C" });
    expect(detail.callees[0]).toMatchObject({
      calleeText: "other()",
      resolution: "CONFIRMED",
      target: { id: "m2" },
    });
    expect(detail.callers[0]).toMatchObject({
      resolution: "POSSIBLE",
      path: "src/x.ts",
      line: 3,
      caller: null,
    });
    expect(detail.extendsOrImplements[0]).toMatchObject({
      kind: "EXTENDS",
      target: { id: "b1" },
    });
  });
});

describe("searchAnalysis", () => {
  it("validates the query", () => {
    expect(() => normaliseSearchQuery("a")).toThrow();
    expect(() => normaliseSearchQuery("x".repeat(101))).toThrow();
    expect(normaliseSearchQuery("  ab  ")).toBe("ab");
  });

  it("rejects short queries before touching the database", async () => {
    const { db, calls } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await rejectsWith(
      searchAnalysis("u", "ana-1", { q: " a " }, db),
      "INVALID_QUERY",
    );
    expect(calls).toHaveLength(0);
  });

  it("searches only the requested categories", async () => {
    const { db, calls } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    const res = await searchAnalysis(
      "u",
      "ana-1",
      { q: "util", categories: ["files"] },
      db,
    );
    expect(Object.keys(res.results)).toEqual(["files"]);
    expect(
      calls.map((c) => c.op).filter((o) => o !== "codeAnalysis.findFirst"),
    ).toEqual(["analysisFile.findMany"]);
  });

  it("returns all four categories with hasMore flags", async () => {
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `src/util${i}.ts`,
      status: "ANALYSED",
      symbolCount: i,
    }));
    const { db } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "analysisFile.findMany": () => files,
      "codeSymbol.findMany": () => [
        {
          id: "s1",
          stableKey: "k",
          name: "util",
          kind: "FUNCTION",
          qualifiedName: "util",
          parentId: null,
          isExported: true,
          isDefaultExport: false,
          exportNames: ["util"],
          startLine: 3,
          startColumn: 1,
          endLine: 4,
          endColumn: 1,
          file: { path: "src/a.ts" },
        },
      ],
      "moduleDependency.findMany": () => [
        {
          specifier: "./util",
          status: "RESOLVED",
          targetPath: "src/util.ts",
          externalPackage: null,
          sourcePath: "src/a.ts",
          startLine: 1,
        },
        {
          specifier: "util-pkg",
          status: "EXTERNAL",
          targetPath: null,
          externalPackage: "util-pkg",
          sourcePath: "src/b.ts",
          startLine: 2,
        },
      ],
    });

    const res = await searchAnalysis("u", "ana-1", { q: "util", limit: 3 }, db);
    expect(res.query).toBe("util");
    expect(res.analysisId).toBe("ana-1");
    expect(res.results.files).toMatchObject({ hasMore: true });
    expect(res.results.files!.items).toHaveLength(3);
    expect(res.results.files!.items[0]).toMatchObject({
      path: "src/util0.ts",
      name: "util0.ts",
    });
    expect(res.results.symbols!.items[0]).toMatchObject({
      id: "s1",
      path: "src/a.ts",
      startLine: 3,
    });
    expect(res.results.exports!.items[0]).toMatchObject({
      exportNames: ["util"],
    });
    expect(res.results.modules!.items[1]).toMatchObject({
      status: "EXTERNAL",
      targetPath: null,
      importedBy: { path: "src/b.ts", line: 2 },
    });
  });

  it("only exposes a module's internal target when it actually resolved", async () => {
    const { db } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
      "moduleDependency.findMany": () => [
        {
          specifier: "./maybe",
          status: "AMBIGUOUS",
          targetPath: "src/maybe.ts",
          externalPackage: null,
          sourcePath: "src/a.ts",
          startLine: 4,
        },
      ],
    });
    const res = await searchAnalysis(
      "u",
      "ana-1",
      { q: "maybe", categories: ["modules"] },
      db,
    );
    expect(res.results.modules!.items[0].targetPath).toBeNull();
  });

  it("restricts export search to exported symbols", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await searchAnalysis(
      "u",
      "ana-1",
      { q: "foo", categories: ["exports"] },
      db,
    );
    const where = of("codeSymbol.findMany")[0].args.where;
    expect(where.OR.every((clause: any) => clause.isExported === true)).toBe(
      true,
    );
  });

  it("caps per-category limits", async () => {
    const { db, of } = makeDb({
      "codeAnalysis.findFirst": () => analysisRow(),
    });
    await searchAnalysis(
      "u",
      "ana-1",
      { q: "foo", categories: ["files"], limit: 5000 },
      db,
    );
    expect(of("analysisFile.findMany")[0].args.take).toBe(51);
  });
});
