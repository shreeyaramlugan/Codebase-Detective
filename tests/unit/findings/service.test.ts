// tests/unit/findings/service.test.ts
//
// The service takes an injectable client, so these tests use a recording fake:
// they verify the QUERIES (ownership, run scoping, allow-lists, limits) and the
// mapping of returned rows. They do not run SQL.
import { describe, expect, it } from "vitest";

import { FindingsError } from "@/lib/findings/findings.errors";
import {
  compareFindingsRuns,
  getFinding,
  listFindings,
  listRuleCatalogue,
  setFindingReview,
  type FindingsDb,
} from "@/lib/findings/findings.service";

type Call = { model: string; op: string; args: any };

function makeDb(handlers: Record<string, (args: any) => unknown> = {}) {
  const calls: Call[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => async (args: any) => {
          calls.push({ model: name, op, args });
          const h = handlers[`${name}.${op}`];
          if (h) return h(args);
          return op === "findMany" ? [] : op === "count" ? 0 : null;
        },
      },
    );
  const db = {
    findingsRun: model("findingsRun"),
    finding: model("finding"),
    findingRuleRun: model("findingRuleRun"),
    findingReview: model("findingReview"),
    analysisFile: model("analysisFile"),
  } as unknown as FindingsDb;
  return { db, calls };
}

const run = (over: any = {}) => ({
  id: "r1",
  analysisId: "an1",
  repositoryId: "repo1",
  status: "COMPLETED",
  engineVersion: "1.0.0",
  catalogueVersion: "1.0.0",
  thresholds: {},
  stats: null,
  coverage: null,
  limitations: [],
  errorCode: null,
  errorMessage: null,
  createdAt: new Date("2026-01-01"),
  completedAt: null,
  analysis: {
    snapshotId: "sn1",
    commitSha: "abc",
    status: "COMPLETED",
    snapshotCompleteness: "COMPLETE",
  },
  ...over,
});

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as FindingsError).code;
  }
  return "none";
};

describe("ownership", () => {
  it("scopes every run lookup by repository owner and reports missing as NOT_FOUND", async () => {
    const { db, calls } = makeDb();
    expect(await code(listFindings("u1", "r1", {}, db))).toBe("NOT_FOUND");
    expect(calls[0].args.where).toEqual({
      id: "r1",
      repository: { ownerId: "u1" },
    });
    expect(calls.filter((c) => c.model === "finding")).toHaveLength(0);
  });

  it("scopes finding lookups through the run's repository owner", async () => {
    const { db, calls } = makeDb();
    expect(await code(getFinding("u1", "f1", db))).toBe("NOT_FOUND");
    expect(calls[0].args.where).toEqual({
      id: "f1",
      run: { repository: { ownerId: "u1" } },
    });
    expect(
      await code(setFindingReview("u1", "f1", { status: "ACKNOWLEDGED" }, db)),
    ).toBe("NOT_FOUND");
  });
});

describe("listFindings", () => {
  const handlers = { "findingsRun.findFirst": () => run() };

  it("always filters by the owned run and applies allow-listed filters", async () => {
    const { db, calls } = makeDb(handlers);
    await listFindings(
      "u1",
      "r1",
      {
        severities: ["HIGH"],
        categories: ["SECURITY"],
        ruleIds: ["SEC001"],
        q: " eval ",
        limit: 10,
      },
      db,
    );
    const q = calls.find(
      (c) => c.model === "finding" && c.op === "findMany",
    )!.args;
    expect(q.where.runId).toBe("r1");
    expect(q.where.severity).toEqual({ in: ["HIGH"] });
    expect(q.where.OR).toHaveLength(3);
    expect(q.take).toBe(11);
  });

  it("rejects unknown filter values instead of passing them to the query", async () => {
    const { db, calls } = makeDb(handlers);
    expect(
      await code(listFindings("u1", "r1", { severities: ["BOGUS"] }, db)),
    ).toBe("INVALID_INPUT");
    expect(
      await code(listFindings("u1", "r1", { categories: ["x"] }, db)),
    ).toBe("INVALID_INPUT");
    expect(
      await code(listFindings("u1", "r1", { ruleIds: ["NOPE99"] }, db)),
    ).toBe("INVALID_INPUT");
    expect(
      await code(listFindings("u1", "r1", { q: "x".repeat(101) }, db)),
    ).toBe("INVALID_INPUT");
    expect(await code(listFindings("u1", "r1", { path: "a\0b" }, db))).toBe(
      "INVALID_INPUT",
    );
    expect(calls.filter((c) => c.model === "finding")).toHaveLength(0);
  });

  it("clamps the page size and returns a cursor only when more rows exist", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      id: `f${i}`,
      fingerprint: `fp${i}`,
      ruleId: "SEC001",
      category: "SECURITY",
      severity: "LOW",
      certainty: "INDICATOR",
      title: "t",
      subjectPath: "a.ts",
      primaryLine: 1,
    }));
    const { db, calls } = makeDb({
      ...handlers,
      "finding.findMany": () => rows,
      "finding.count": () => 3,
    });
    const r = await listFindings("u1", "r1", { limit: 2 }, db);
    expect(r.items).toHaveLength(2);
    expect(r.nextCursor).toBe("f1");
    expect(r.total).toBe(3);
    await listFindings("u1", "r1", { limit: 9999 }, db);
    const last = calls
      .filter((c) => c.model === "finding" && c.op === "findMany")
      .pop()!;
    expect(last.args.take).toBe(201);
  });

  it("attaches review state by repository and fingerprint", async () => {
    const rows = [
      {
        id: "f1",
        fingerprint: "fp1",
        ruleId: "SEC001",
        category: "SECURITY",
        severity: "LOW",
        certainty: "INDICATOR",
        title: "t",
        subjectPath: "a.ts",
        primaryLine: 1,
      },
    ];
    const { db, calls } = makeDb({
      ...handlers,
      "finding.findMany": () => rows,
      "findingReview.findMany": () => [
        { fingerprint: "fp1", status: "DISMISSED", reason: "test code" },
      ],
    });
    const r = await listFindings("u1", "r1", {}, db);
    expect(r.items[0].review).toEqual({
      status: "DISMISSED",
      reason: "test code",
    });
    const q = calls.find((c) => c.model === "findingReview")!.args;
    expect(q.where.repositoryId).toBe("repo1");
  });
});

describe("setFindingReview", () => {
  const finding = {
    id: "f1",
    fingerprint: "fp1",
    run: { id: "r1", analysisId: "an1", repositoryId: "repo1" },
    evidence: [],
  };
  const handlers = { "finding.findFirst": () => finding };

  it("requires a reason to dismiss and bounds its length", async () => {
    const { db } = makeDb(handlers);
    expect(
      await code(setFindingReview("u1", "f1", { status: "DISMISSED" }, db)),
    ).toBe("INVALID_INPUT");
    expect(
      await code(
        setFindingReview(
          "u1",
          "f1",
          { status: "DISMISSED", reason: "x".repeat(501) },
          db,
        ),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      await code(setFindingReview("u1", "f1", { status: "FIXED" as any }, db)),
    ).toBe("INVALID_INPUT");
  });

  it("upserts by repository + fingerprint so triage survives re-analysis", async () => {
    const { db, calls } = makeDb({
      ...handlers,
      "findingReview.upsert": () => ({
        status: "DISMISSED",
        reason: "generated",
      }),
    });
    const r = await setFindingReview(
      "u1",
      "f1",
      { status: "DISMISSED", reason: " generated " },
      db,
    );
    expect(r.review).toEqual({ status: "DISMISSED", reason: "generated" });
    const upsert = calls.find((c) => c.op === "upsert")!.args;
    expect(upsert.where.repositoryId_fingerprint).toEqual({
      repositoryId: "repo1",
      fingerprint: "fp1",
    });
    expect(upsert.create.reviewedById).toBe("u1");
  });

  it("clears a review with null status", async () => {
    const { db, calls } = makeDb(handlers);
    expect(
      (await setFindingReview("u1", "f1", { status: null }, db)).review,
    ).toBeNull();
    expect(calls.some((c) => c.op === "deleteMany")).toBe(true);
  });
});

describe("getFinding", () => {
  it("flags indicators and returns ordered evidence", async () => {
    const row = {
      id: "f1",
      fingerprint: "fp1",
      ruleId: "SEC001",
      ruleVersion: "1.0.0",
      category: "SECURITY",
      severity: "MEDIUM",
      certainty: "INDICATOR",
      title: "Possible x",
      description: "d",
      recommendation: "r",
      subjectPath: "a.ts",
      subjectKey: "k",
      symbolKey: null,
      primaryLine: 3,
      measurements: null,
      evidence: [
        {
          ordinal: 0,
          kind: "PATTERN_MATCH",
          filePath: "a.ts",
          symbolKey: null,
          startLine: 3,
          startColumn: 1,
          endLine: 3,
          endColumn: 9,
          excerpt: "eval(x)",
          message: "m",
          data: null,
        },
      ],
      run: { id: "r1", analysisId: "an1", repositoryId: "repo1" },
    };
    const { db } = makeDb({ "finding.findFirst": () => row });
    const f = await getFinding("u1", "f1", db);
    expect(f.isIndicator).toBe(true);
    expect(f.rule?.name).toMatch(/^Possible/);
    expect(f.evidence[0].startLine).toBe(3);
  });
});

describe("compareFindingsRuns", () => {
  it("rejects the same run twice, cross-repository runs and unfinished runs", async () => {
    const { db } = makeDb();
    expect(await code(compareFindingsRuns("u1", "r1", "r1", db))).toBe(
      "INVALID_INPUT",
    );

    const other = makeDb({
      "findingsRun.findFirst": (a: any) =>
        run({
          id: a.where.id,
          repositoryId: a.where.id === "r2" ? "repo2" : "repo1",
        }),
    });
    expect(await code(compareFindingsRuns("u1", "r1", "r2", other.db))).toBe(
      "INCOMPATIBLE_RUNS",
    );

    const failed = makeDb({
      "findingsRun.findFirst": (a: any) =>
        run({
          id: a.where.id,
          status: a.where.id === "r2" ? "FAILED" : "COMPLETED",
        }),
    });
    expect(await code(compareFindingsRuns("u1", "r1", "r2", failed.db))).toBe(
      "INCOMPATIBLE_RUNS",
    );
  });

  it("requires both runs to be owned", async () => {
    const { db } = makeDb({
      "findingsRun.findFirst": (a: any) => (a.where.id === "r1" ? run() : null),
    });
    expect(await code(compareFindingsRuns("u1", "r1", "r2", db))).toBe(
      "NOT_FOUND",
    );
  });

  it("compares persisted findings and never treats a partial head as resolved", async () => {
    const f = {
      fingerprint: "fp1",
      ruleId: "DEP001",
      ruleVersion: "1.0.0",
      severity: "MEDIUM",
      subjectPath: "a.ts",
      subjectKey: "k",
      title: "t",
    };
    const rr = {
      ruleId: "DEP001",
      ruleVersion: "1.0.0",
      status: "COMPLETED",
      configHash: "h",
    };
    const { db } = makeDb({
      "findingsRun.findFirst": (a: any) =>
        a.where.id === "r1"
          ? run({ id: "r1", analysisId: "an1" })
          : run({
              id: "r2",
              analysisId: "an2",
              status: "PARTIAL",
              analysis: {
                snapshotId: "sn2",
                commitSha: "def",
                status: "PARTIAL",
                snapshotCompleteness: "PARTIAL",
              },
            }),
      "finding.findMany": (a: any) => (a.where.runId === "r1" ? [f] : []),
      "findingRuleRun.findMany": () => [rr],
      "analysisFile.findMany": (a: any) =>
        a.where.analysisId === "an1"
          ? [{ path: "a.ts", contentHash: "x" }]
          : [],
    });
    const r = await compareFindingsRuns("u1", "r1", "r2", db);
    expect(r.summary.resolved).toBe(0);
    expect(r.summary.unverified).toBe(1);
    expect(r.head.commitSha).toBe("def");
  });
});

describe("rule catalogue endpoint data", () => {
  it("exposes documented rules without evaluation functions", () => {
    const { rules } = listRuleCatalogue();
    expect(rules.length).toBeGreaterThanOrEqual(10);
    for (const rule of rules) {
      expect((rule as any).evaluate).toBeUndefined();
      expect(rule.severityPolicy.length).toBeGreaterThan(0);
    }
  });
});

describe("spec-named entry points", () => {
  const finalRun = run();

  it("lists findings for the latest finished run of an owned analysis only", async () => {
    const { db, calls } = makeDb({ "findingsRun.findFirst": () => finalRun });
    const { listAnalysisFindings } =
      await import("@/lib/findings/findings.service");
    const r = await listAnalysisFindings("u1", "an1", {}, db);
    expect(r.run.id).toBe("r1");
    const lookup = calls[0].args;
    expect(lookup.where.analysisId).toBe("an1");
    expect(lookup.where.repository).toEqual({ ownerId: "u1" });
    expect(lookup.where.status).toEqual({ in: ["COMPLETED", "PARTIAL"] });
    expect(lookup.orderBy).toEqual({ createdAt: "desc" });
  });

  it("does not let a run id from another analysis be used", async () => {
    const { db, calls } = makeDb();
    const { listAnalysisFindings } =
      await import("@/lib/findings/findings.service");
    expect(
      await code(listAnalysisFindings("u1", "an1", { runId: "other" }, db)),
    ).toBe("NOT_FOUND");
    expect(calls[0].args.where).toMatchObject({
      analysisId: "an1",
      id: "other",
    });
  });

  it("reports no findings generated as NOT_FOUND, never as an empty clean result", async () => {
    const { db } = makeDb();
    const { listAnalysisFindings } =
      await import("@/lib/findings/findings.service");
    expect(await code(listAnalysisFindings("u1", "an1", {}, db))).toBe(
      "NOT_FOUND",
    );
  });

  it("refuses to compare snapshots when the newer one has no findings run", async () => {
    const { db } = makeDb({
      "findingsRun.findFirst": (a: any) =>
        a.where.analysis?.snapshotId === "old" ? { id: "r1" } : null,
    });
    const { compareSnapshotFindings } =
      await import("@/lib/findings/findings.service");
    expect(await code(compareSnapshotFindings("u1", "old", "new", db))).toBe(
      "ANALYSIS_NOT_READY",
    );
    expect(await code(compareSnapshotFindings("u1", "old", "old", db))).toBe(
      "INVALID_INPUT",
    );
  });

  it("builds a per-fingerprint timeline across runs and validates the fingerprint", async () => {
    const { getRepositoryFindingHistory } =
      await import("@/lib/findings/findings.service");
    const fp = "fnd_" + "a".repeat(32);
    const { db, calls } = makeDb({
      "findingsRun.findMany": () => [
        run({ id: "r2", createdAt: new Date("2026-02-01") }),
        run({ id: "r1" }),
      ],
      "finding.findMany": () => [
        { id: "f1", runId: "r1", severity: "LOW", ruleVersion: "1.0.0" },
      ],
    });
    const h = await getRepositoryFindingHistory(
      "u1",
      "repo1",
      { fingerprint: fp },
      db,
    );
    expect(h.timeline?.map((t) => [t.runId, t.present])).toEqual([
      ["r1", true],
      ["r2", false],
    ]);
    const q = calls.find((c) => c.model === "finding")!.args;
    expect(q.where.run).toEqual({
      repositoryId: "repo1",
      repository: { ownerId: "u1" },
    });
    expect(
      await code(
        getRepositoryFindingHistory("u1", "repo1", { fingerprint: "bad" }, db),
      ),
    ).toBe("INVALID_INPUT");
  });
});
