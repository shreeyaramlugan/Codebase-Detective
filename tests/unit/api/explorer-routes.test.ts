// tests/unit/api/explorer-routes.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  overview: vi.fn(),
  tree: vi.fn(),
  symbols: vi.fn(),
  symbol: vi.fn(),
  search: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));

vi.mock("@/lib/explorer/explorer.service", () => ({
  // Mirrors the real constant so the route's allow-list is exercised without
  // loading Prisma.
  EXPLORER_SYMBOL_KINDS: [
    "FUNCTION",
    "CLASS",
    "METHOD",
    "INTERFACE",
    "TYPE",
    "VARIABLE",
    "ENUM",
  ],
  getRepositoryExplorerOverview: mocks.overview,
  getAnalysisTree: mocks.tree,
  listExplorerSymbols: mocks.symbols,
  getExplorerSymbol: mocks.symbol,
  searchAnalysis: mocks.search,
}));

import { GET as overviewGet } from "../../../app/api/repositories/[repositoryId]/explorer/route";
import { GET as treeGet } from "../../../app/api/analyses/[analysisId]/explorer/tree/route";
import { GET as symbolsGet } from "../../../app/api/analyses/[analysisId]/explorer/symbols/route";
import { GET as symbolGet } from "../../../app/api/analyses/[analysisId]/explorer/symbols/[symbolId]/route";
import { GET as searchGet } from "../../../app/api/analyses/[analysisId]/explorer/search/route";
import { AnalysisError } from "@/lib/analysis/analysis.errors";

const repo = { params: Promise.resolve({ repositoryId: "repo-1" }) };
const ana = { params: Promise.resolve({ analysisId: "ana-1" }) };
const sym = {
  params: Promise.resolve({ analysisId: "ana-1", symbolId: "sym-1" }),
};

const get = (path: string) => new Request(`http://localhost${path}`);

describe("explorer API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("rejects unauthenticated requests on every route", async () => {
    mocks.requireSession.mockRejectedValue(new Error("UNAUTHORIZED"));

    const responses = await Promise.all([
      overviewGet(get("/x"), repo),
      treeGet(get("/x"), ana),
      symbolsGet(get("/x"), ana),
      symbolGet(get("/x"), sym),
      searchGet(get("/x?q=abc"), ana),
    ]);

    for (const response of responses) expect(response.status).toBe(401);
    for (const fn of [
      mocks.overview,
      mocks.tree,
      mocks.symbols,
      mocks.symbol,
      mocks.search,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("passes the session user id to every service call", async () => {
    mocks.overview.mockResolvedValue({});
    mocks.tree.mockResolvedValue({});
    mocks.symbols.mockResolvedValue({ items: [] });
    mocks.symbol.mockResolvedValue({});
    mocks.search.mockResolvedValue({});

    await overviewGet(get("/x?analysisId=ana-1"), repo);
    await treeGet(get("/x"), ana);
    await symbolsGet(get("/x"), ana);
    await symbolGet(get("/x"), sym);
    await searchGet(get("/x?q=abc"), ana);

    expect(mocks.overview).toHaveBeenCalledWith("user-1", "repo-1", {
      snapshotId: undefined,
      analysisId: "ana-1",
    });
    expect(mocks.tree).toHaveBeenCalledWith("user-1", "ana-1");
    expect(mocks.symbols.mock.calls[0].slice(0, 2)).toEqual([
      "user-1",
      "ana-1",
    ]);
    expect(mocks.symbol).toHaveBeenCalledWith("user-1", "ana-1", "sym-1");
    expect(mocks.search.mock.calls[0].slice(0, 2)).toEqual(["user-1", "ana-1"]);
  });

  it("marks responses private and uncacheable", async () => {
    mocks.tree.mockResolvedValue({ entries: [] });
    const response = await treeGet(get("/x"), ana);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("returns 404 for analyses or repositories the user does not own", async () => {
    const notFound = new AnalysisError("Analysis not found.", "NOT_FOUND");
    for (const fn of [
      mocks.overview,
      mocks.tree,
      mocks.symbols,
      mocks.symbol,
      mocks.search,
    ]) {
      fn.mockRejectedValue(notFound);
    }

    const responses = await Promise.all([
      overviewGet(get("/x"), repo),
      treeGet(get("/x"), ana),
      symbolsGet(get("/x"), ana),
      symbolGet(get("/x"), sym),
      searchGet(get("/x?q=abc"), ana),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "Analysis not found.",
        code: "NOT_FOUND",
      });
    }
  });

  it("returns a generic 500 without leaking internal errors", async () => {
    mocks.tree.mockRejectedValue(
      new Error("connection string postgres://secret"),
    );
    const response = await treeGet(get("/x"), ana);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  describe("query validation", () => {
    it("rejects bad symbol filters before calling the service", async () => {
      const bad = [
        "?kinds=FUNCTION,NOPE",
        "?exported=maybe",
        "?limit=0",
        "?limit=abc",
        "?cursor=",
        "?parent=a%20b",
        `?q=${"x".repeat(101)}`,
        `?path=${"x".repeat(1025)}`,
      ];

      for (const query of bad) {
        const response = await symbolsGet(get(`/x${query}`), ana);
        expect(response.status).toBe(400);
      }
      expect(mocks.symbols).not.toHaveBeenCalled();
    });

    it("parses valid symbol filters", async () => {
      mocks.symbols.mockResolvedValue({
        items: [],
        nextCursor: null,
        facets: {},
      });
      await symbolsGet(
        get(
          "/x?q=run&kinds=FUNCTION,CLASS&exported=true&parent=none&limit=25&cursor=abc&path=src/a.ts",
        ),
        ana,
      );
      expect(mocks.symbols.mock.calls[0][2]).toMatchObject({
        q: "run",
        kinds: ["FUNCTION", "CLASS"],
        exported: true,
        parent: "none",
        limit: 25,
        cursor: "abc",
        path: "src/a.ts",
      });
    });

    it("rejects invalid ids and categories on the other routes", async () => {
      expect(
        (await overviewGet(get("/x?analysisId=../etc"), repo)).status,
      ).toBe(400);
      expect((await overviewGet(get("/x?snapshotId=a%20b"), repo)).status).toBe(
        400,
      );
      expect(
        (await searchGet(get("/x?q=abc&categories=files,secrets"), ana)).status,
      ).toBe(400);
      expect((await searchGet(get("/x?q=abc&limit=-1"), ana)).status).toBe(400);
    });

    it("passes search parameters to the service", async () => {
      mocks.search.mockResolvedValue({ query: "abc", results: {} });
      await searchGet(get("/x?q=abc&categories=files,exports&limit=10"), ana);
      expect(mocks.search.mock.calls[0][2]).toEqual({
        q: "abc",
        categories: ["files", "exports"],
        limit: 10,
      });
    });

    it("maps a too-short search to 400 via the service error", async () => {
      mocks.search.mockRejectedValue(
        new AnalysisError("Too short.", "INVALID_QUERY"),
      );
      const response = await searchGet(get("/x?q=a"), ana);
      expect(response.status).toBe(400);
    });
  });
});
