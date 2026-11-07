// tests/unit/api/analysis-routes.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  start: vi.fn(),
  history: vi.fn(),
  summary: vi.fn(),
  symbols: vi.fn(),
  dependencies: vi.fn(),
  diagnostics: vi.fn(),
  graph: vi.fn(),
  file: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));

vi.mock("@/lib/analysis/analysis.service", () => ({
  startSnapshotAnalysis: mocks.start,
  listSnapshotAnalyses: mocks.history,
  getAnalysisSummary: mocks.summary,
  listAnalysisSymbols: mocks.symbols,
  listAnalysisDependencies: mocks.dependencies,
  listAnalysisDiagnostics: mocks.diagnostics,
  getAnalysisGraph: mocks.graph,
  getAnalysisFile: mocks.file,
}));

import { POST as analyzePost } from "../../../app/api/snapshots/[snapshotId]/analyze/route";
import { GET as historyGet } from "../../../app/api/snapshots/[snapshotId]/analyses/route";
import { GET as summaryGet } from "../../../app/api/analyses/[analysisId]/route";
import { GET as symbolsGet } from "../../../app/api/analyses/[analysisId]/symbols/route";
import { GET as dependenciesGet } from "../../../app/api/analyses/[analysisId]/dependencies/route";
import { GET as diagnosticsGet } from "../../../app/api/analyses/[analysisId]/diagnostics/route";
import { GET as graphGet } from "../../../app/api/analyses/[analysisId]/graph/route";
import { GET as fileGet } from "../../../app/api/analyses/[analysisId]/files/[fileId]/route";
import { AnalysisError } from "../../../lib/analysis/analysis.errors";

const snap = { params: Promise.resolve({ snapshotId: "snap-1" }) };
const ana = { params: Promise.resolve({ analysisId: "ana-1" }) };
const anaFile = {
  params: Promise.resolve({ analysisId: "ana-1", fileId: "file-1" }),
};
const url = "http://localhost/api/analyses/ana-1";

const get = (path = "") => new Request(`${url}${path}`);

describe("analysis API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  describe("authentication", () => {
    it("rejects unauthenticated requests on every route", async () => {
      mocks.requireSession.mockRejectedValue(new Error("UNAUTHORIZED"));

      const responses = await Promise.all([
        analyzePost(
          new Request("http://localhost/x", { method: "POST" }),
          snap,
        ),
        historyGet(get(), snap),
        summaryGet(get(), ana),
        symbolsGet(get("/symbols"), ana),
        dependenciesGet(get("/dependencies"), ana),
        diagnosticsGet(get("/diagnostics"), ana),
        graphGet(get("/graph"), ana),
        fileGet(get("/files/file-1"), anaFile),
      ]);

      for (const response of responses) expect(response.status).toBe(401);
      for (const mock of [
        mocks.start,
        mocks.history,
        mocks.summary,
        mocks.symbols,
        mocks.dependencies,
        mocks.diagnostics,
        mocks.graph,
        mocks.file,
      ]) {
        expect(mock).not.toHaveBeenCalled();
      }
    });
  });

  describe("POST /api/snapshots/[snapshotId]/analyze", () => {
    it("scopes the run to the session user and the snapshot id only", async () => {
      mocks.start.mockResolvedValue({
        analysisId: "ana-1",
        status: "COMPLETED",
        errorCode: null,
      });
      const response = await analyzePost(
        new Request("http://localhost/x", {
          method: "POST",
          body: JSON.stringify({ storageKey: "../../etc" }),
        }),
        snap,
      );

      expect(response.status).toBe(201);
      expect(mocks.start).toHaveBeenCalledWith("user-1", "snap-1");
      expect(await response.json()).toEqual({
        analysisId: "ana-1",
        status: "COMPLETED",
        errorCode: null,
      });
    });

    it("returns 404 for another user's snapshot and 409 when not ready", async () => {
      mocks.start.mockRejectedValueOnce(
        new AnalysisError("Snapshot not found.", "NOT_FOUND"),
      );
      expect(
        (
          await analyzePost(
            new Request("http://localhost/x", { method: "POST" }),
            snap,
          )
        ).status,
      ).toBe(404);

      mocks.start.mockRejectedValueOnce(
        new AnalysisError("not ready", "SNAPSHOT_NOT_READY"),
      );
      expect(
        (
          await analyzePost(
            new Request("http://localhost/x", { method: "POST" }),
            snap,
          )
        ).status,
      ).toBe(409);
    });

    it("does not leak unexpected error details", async () => {
      mocks.start.mockRejectedValue(
        new Error("connect ECONNREFUSED /var/storage/objects"),
      );
      const response = await analyzePost(
        new Request("http://localhost/x", { method: "POST" }),
        snap,
      );
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("storage");
    });
  });

  describe("owner-scoped reads", () => {
    it("passes the session user to every read", async () => {
      mocks.history.mockResolvedValue([]);
      mocks.summary.mockResolvedValue({ id: "ana-1" });
      mocks.symbols.mockResolvedValue({ items: [], nextCursor: null });
      mocks.dependencies.mockResolvedValue({ items: [], nextCursor: null });
      mocks.diagnostics.mockResolvedValue({ items: [], nextCursor: null });
      mocks.graph.mockResolvedValue({ nodes: [], edges: [] });
      mocks.file.mockResolvedValue({});

      await historyGet(get(), snap);
      await summaryGet(get(), ana);
      await symbolsGet(get("/symbols"), ana);
      await dependenciesGet(get("/dependencies"), ana);
      await diagnosticsGet(get("/diagnostics"), ana);
      await graphGet(get("/graph"), ana);
      await fileGet(get("/files/file-1"), anaFile);

      expect(mocks.history).toHaveBeenCalledWith("user-1", "snap-1");
      expect(mocks.summary).toHaveBeenCalledWith("user-1", "ana-1");
      expect(mocks.symbols.mock.calls[0].slice(0, 2)).toEqual([
        "user-1",
        "ana-1",
      ]);
      expect(mocks.dependencies.mock.calls[0].slice(0, 2)).toEqual([
        "user-1",
        "ana-1",
      ]);
      expect(mocks.diagnostics.mock.calls[0].slice(0, 2)).toEqual([
        "user-1",
        "ana-1",
      ]);
      expect(mocks.graph).toHaveBeenCalledWith("user-1", "ana-1", undefined);
      expect(mocks.file).toHaveBeenCalledWith("user-1", "ana-1", "file-1");
    });

    it("maps not-found (including cross-user) to 404", async () => {
      mocks.summary.mockRejectedValue(
        new AnalysisError("Analysis not found.", "NOT_FOUND"),
      );
      mocks.file.mockRejectedValue(
        new AnalysisError("File not found in this analysis.", "NOT_FOUND"),
      );
      expect((await summaryGet(get(), ana)).status).toBe(404);
      expect((await fileGet(get("/files/file-1"), anaFile)).status).toBe(404);
    });

    it("maps a missing graph to 409", async () => {
      mocks.graph.mockRejectedValue(
        new AnalysisError("no graph", "GRAPH_UNAVAILABLE"),
      );
      expect((await graphGet(get("/graph"), ana)).status).toBe(409);
    });
  });

  describe("query validation", () => {
    it("rejects invalid filters and pagination before querying", async () => {
      expect((await symbolsGet(get("/symbols?kind=DROP"), ana)).status).toBe(
        400,
      );
      expect((await symbolsGet(get("/symbols?limit=-1"), ana)).status).toBe(
        400,
      );
      expect(
        (await symbolsGet(get("/symbols?exported=maybe"), ana)).status,
      ).toBe(400);
      expect(
        (await dependenciesGet(get("/dependencies?status=NOPE"), ana)).status,
      ).toBe(400);
      expect(
        (await diagnosticsGet(get("/diagnostics?severity=LOUD"), ana)).status,
      ).toBe(400);
      expect((await graphGet(get("/graph?source=disk"), ana)).status).toBe(400);
      expect(mocks.symbols).not.toHaveBeenCalled();
    });

    it("forwards valid filters", async () => {
      mocks.symbols.mockResolvedValue({ items: [], nextCursor: null });
      await symbolsGet(
        get("/symbols?kind=CLASS&exported=true&limit=10&cursor=abc"),
        ana,
      );
      expect(mocks.symbols.mock.calls[0][2]).toMatchObject({
        kind: "CLASS",
        exported: true,
        limit: 10,
        cursor: "abc",
      });
    });

    it("forwards graph source=relational", async () => {
      mocks.graph.mockResolvedValue({ nodes: [], edges: [] });
      await graphGet(get("/graph?source=relational"), ana);
      expect(mocks.graph).toHaveBeenCalledWith("user-1", "ana-1", "relational");
    });
  });
});
