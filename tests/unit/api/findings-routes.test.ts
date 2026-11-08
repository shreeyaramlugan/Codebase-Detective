// tests/unit/api/findings-routes.test.ts
//
// Route-level checks: authentication, input validation and error mapping. The
// services are mocked, so these verify that every route (a) rejects
// unauthenticated callers before touching a service, (b) validates ids and
// query values, and (c) maps service errors to the documented statuses.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  start: vi.fn(),
  runs: vi.fn(),
  repoRuns: vi.fn(),
  run: vi.fn(),
  list: vi.fn(),
  analysisList: vi.fn(),
  detail: vi.fn(),
  evidence: vi.fn(),
  review: vi.fn(),
  rules: vi.fn(),
  analysisRules: vi.fn(),
  compare: vi.fn(),
  compareSnapshots: vi.fn(),
  history: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/findings/findings.start", () => ({
  startFindingsRun: mocks.start,
}));
vi.mock("@/lib/findings/findings.service", () => ({
  REVIEW_FILTERS: ["OPEN", "ACKNOWLEDGED", "DISMISSED"],
  listAnalysisFindingsRuns: mocks.runs,
  listRepositoryFindingsRuns: mocks.repoRuns,
  getFindingsRun: mocks.run,
  listFindings: mocks.list,
  listAnalysisFindings: mocks.analysisList,
  getFinding: mocks.detail,
  getFindingEvidence: mocks.evidence,
  setFindingReview: mocks.review,
  listRuleCatalogue: mocks.rules,
  getAnalysisRules: mocks.analysisRules,
  compareFindingsRuns: mocks.compare,
  compareSnapshotFindings: mocks.compareSnapshots,
  getRepositoryFindingHistory: mocks.history,
}));

import { POST as runPost } from "../../../app/api/analyses/[analysisId]/findings/run/route";
import { GET as analysisRunsGet } from "../../../app/api/analyses/[analysisId]/findings/runs/route";
import { GET as analysisFindingsGet } from "../../../app/api/analyses/[analysisId]/findings/route";
import { GET as analysisRulesGet } from "../../../app/api/analyses/[analysisId]/rules/route";
import { GET as runGet } from "../../../app/api/findings/runs/[runId]/route";
import { GET as runFindingsGet } from "../../../app/api/findings/runs/[runId]/findings/route";
import { GET as findingGet } from "../../../app/api/findings/[findingId]/route";
import { GET as evidenceGet } from "../../../app/api/findings/[findingId]/evidence/route";
import { PUT as reviewPut } from "../../../app/api/findings/[findingId]/review/route";
import { GET as rulesGet } from "../../../app/api/findings/rules/route";
import { GET as repoRunsGet } from "../../../app/api/repositories/[repositoryId]/findings/runs/route";
import { GET as compareGet } from "../../../app/api/repositories/[repositoryId]/findings/compare/route";
import { GET as historyGet } from "../../../app/api/repositories/[repositoryId]/finding-history/route";
import { POST as compareSnapshotsPost } from "../../../app/api/snapshots/compare-findings/route";
import { FindingsError } from "@/lib/findings/findings.errors";

const ana = { params: Promise.resolve({ analysisId: "ana-1" }) };
const run = { params: Promise.resolve({ runId: "run-1" }) };
const fnd = { params: Promise.resolve({ findingId: "fnd-1" }) };
const repo = { params: Promise.resolve({ repositoryId: "repo-1" }) };

const get = (path: string) => new Request(`http://localhost${path}`);
const send = (method: string, body: unknown) =>
  new Request("http://localhost/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("findings API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  it("rejects unauthenticated requests on every route", async () => {
    mocks.requireSession.mockRejectedValue(new Error("UNAUTHORIZED"));

    const responses = await Promise.all([
      runPost(send("POST", {}), ana),
      analysisRunsGet(get("/x"), ana),
      analysisFindingsGet(get("/x"), ana),
      analysisRulesGet(get("/x"), ana),
      runGet(get("/x"), run),
      runFindingsGet(get("/x"), run),
      findingGet(get("/x"), fnd),
      evidenceGet(get("/x"), fnd),
      reviewPut(send("PUT", { status: null }), fnd),
      rulesGet(),
      repoRunsGet(get("/x"), repo),
      compareGet(get("/x?base=a&head=b"), repo),
      historyGet(get("/x"), repo),
      compareSnapshotsPost(
        send("POST", { baseSnapshotId: "a", headSnapshotId: "b" }),
      ),
    ]);

    for (const response of responses) expect(response.status).toBe(401);
    for (const fn of Object.values(mocks)) {
      if (fn !== mocks.requireSession) expect(fn).not.toHaveBeenCalled();
    }
  });

  it("starts a run with the caller's id and returns 201", async () => {
    mocks.start.mockResolvedValue({
      runId: "run-1",
      status: "COMPLETED",
      errorCode: null,
    });
    const response = await runPost(
      send("POST", { thresholds: { cyclomaticMedium: 20 } }),
      ana,
    );
    expect(response.status).toBe(201);
    expect(mocks.start).toHaveBeenCalledWith("user-1", "ana-1", {
      cyclomaticMedium: 20,
    });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects malformed ids and bodies before calling a service", async () => {
    const badAna = { params: Promise.resolve({ analysisId: "../etc" }) };
    expect((await runPost(send("POST", {}), badAna)).status).toBe(400);
    expect((await runPost(send("POST", "{not json"), ana)).status).toBe(400);
    expect((await runPost(send("POST", "x".repeat(5000)), ana)).status).toBe(
      400,
    );
    const badFnd = { params: Promise.resolve({ findingId: "a b" }) };
    expect((await findingGet(get("/x"), badFnd)).status).toBe(400);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it("validates list filters against allow-lists", async () => {
    mocks.list.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    for (const q of [
      "severity=HIGH;DROP",
      "review=HACK",
      "limit=0",
      "limit=abc",
    ]) {
      expect((await runFindingsGet(get(`/x?${q}`), run)).status).toBe(400);
    }
    expect(mocks.list).not.toHaveBeenCalled();

    const ok = await runFindingsGet(
      get("/x?severity=HIGH,LOW&category=SECURITY&review=OPEN&q=eval&limit=10"),
      run,
    );
    expect(ok.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(
      "user-1",
      "run-1",
      expect.objectContaining({
        severities: ["HIGH", "LOW"],
        categories: ["SECURITY"],
        review: "OPEN",
        q: "eval",
        limit: 10,
      }),
    );
  });

  it("maps service errors to documented statuses", async () => {
    mocks.detail.mockRejectedValue(
      new FindingsError("Finding not found.", "NOT_FOUND"),
    );
    expect((await findingGet(get("/x"), fnd)).status).toBe(404);
    mocks.start.mockRejectedValue(
      new FindingsError("not ready", "ANALYSIS_NOT_READY"),
    );
    expect((await runPost(send("POST", {}), ana)).status).toBe(409);
    mocks.compare.mockRejectedValue(
      new FindingsError("different repos", "INCOMPATIBLE_RUNS"),
    );
    expect((await compareGet(get("/x?base=a&head=b"), repo)).status).toBe(409);
    mocks.run.mockRejectedValue(new Error("db password=secret"));
    const response = await runGet(get("/x"), run);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
  });

  it("validates the review body and passes the caller through", async () => {
    mocks.review.mockResolvedValue({ review: null });
    expect((await reviewPut(send("PUT", {}), fnd)).status).toBe(400);
    expect((await reviewPut(send("PUT", { status: 5 }), fnd)).status).toBe(400);
    expect(
      (await reviewPut(send("PUT", { status: "DISMISSED", reason: 7 }), fnd))
        .status,
    ).toBe(400);
    expect(mocks.review).not.toHaveBeenCalled();
    expect(
      (
        await reviewPut(
          send("PUT", { status: "DISMISSED", reason: "generated" }),
          fnd,
        )
      ).status,
    ).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith("user-1", "fnd-1", {
      status: "DISMISSED",
      reason: "generated",
    });
  });

  it("requires base and head for comparison and keeps runs inside the repository", async () => {
    expect((await compareGet(get("/x?base=a"), repo)).status).toBe(400);
    mocks.compare.mockResolvedValue({
      base: { repositoryId: "repo-1" },
      head: { repositoryId: "repo-OTHER" },
      entries: [],
    });
    expect((await compareGet(get("/x?base=a&head=b"), repo)).status).toBe(404);
  });

  it("validates the snapshot comparison body", async () => {
    expect(
      (await compareSnapshotsPost(send("POST", { baseSnapshotId: "a" })))
        .status,
    ).toBe(400);
    expect(
      (
        await compareSnapshotsPost(
          send("POST", { baseSnapshotId: "a/b", headSnapshotId: "c" }),
        )
      ).status,
    ).toBe(400);
    mocks.compareSnapshots.mockResolvedValue({ entries: [] });
    expect(
      (
        await compareSnapshotsPost(
          send("POST", { baseSnapshotId: "a", headSnapshotId: "b" }),
        )
      ).status,
    ).toBe(200);
    expect(mocks.compareSnapshots).toHaveBeenCalledWith("user-1", "a", "b");
  });

  it("serves the rule catalogue to signed-in users", async () => {
    mocks.rules.mockReturnValue({ rules: [] });
    expect((await rulesGet()).status).toBe(200);
  });
});
