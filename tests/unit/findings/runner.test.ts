// tests/unit/findings/runner.test.ts
//
// The runner is exercised with fake reader/storage/store ports and a real
// Sprint 03 analysis, so the flow from persisted records to stored findings is
// covered without a database.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FindingsError } from "@/lib/findings/findings.errors";
import {
  runFindingsForAnalysis,
  type AnalysisHeader,
  type FindingsReader,
} from "@/lib/findings/findings.runner";
import type {
  FindingsStore,
  PersistFindingsInput,
} from "@/lib/findings/findings.store";
import {
  analyze,
  fixtures,
  type Project,
} from "@/tests/fixtures/code-intelligence/projects";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function setup(
  project: Project,
  options: {
    header?: Partial<AnalysisHeader> | null;
    completeness?: string;
    failRead?: string[];
    failPersist?: boolean;
    omitRefs?: string[];
  } = {},
) {
  const completeness = options.completeness ?? "COMPLETE";
  const { records } = analyze(project, { completeness });
  const header: AnalysisHeader | null =
    options.header === null
      ? null
      : {
          id: "an1",
          snapshotId: "sn1",
          repositoryId: "repo1",
          status: completeness === "COMPLETE" ? "COMPLETED" : "PARTIAL",
          snapshotCompleteness: completeness,
          ...options.header,
        };

  const calls = {
    find: [] as string[][],
    created: [] as any[],
    persisted: [] as PersistFindingsInput[],
    failed: [] as any[],
    reads: [] as string[],
  };

  const reader: FindingsReader = {
    async findOwnedAnalysis(userId, analysisId) {
      calls.find.push([userId, analysisId]);
      return header;
    },
    async loadRecords() {
      return records;
    },
    async listSourceRefs() {
      return Object.keys(project)
        .filter((p) => !options.omitRefs?.includes(p))
        .map((path) => ({
          path,
          storageKey: `key:${path}`,
          contentHash: sha(project[path]),
        }));
    },
  };

  const storage: any = {
    async get(key: string) {
      calls.reads.push(key);
      const path = key.slice(4);
      if (options.failRead?.includes(path))
        throw new Error("disk exploded /secret/path");
      return Buffer.from(project[path]);
    },
  };

  const store: FindingsStore = {
    async createRun(input) {
      calls.created.push(input);
      return { id: "run1" };
    },
    async markProcessing() {},
    async persistResults(_id, input) {
      if (options.failPersist) throw new Error("db down");
      calls.persisted.push(input);
    },
    async markFailed(_id, input) {
      calls.failed.push(input);
    },
  };

  return { deps: { reader, storage, store }, calls };
}

const evalProject = {
  "src/e.ts": `export function run(s: string) { return eval(s); }\n`,
  "src/a.ts": `import "./gone";\n`,
};

describe("runFindingsForAnalysis", () => {
  it("persists findings, stats and coverage for an owned analysis", async () => {
    const { deps, calls } = setup(evalProject);
    const result = await runFindingsForAnalysis(deps, {
      userId: "u1",
      analysisId: "an1",
    });
    expect(result).toEqual({
      runId: "run1",
      status: "COMPLETED",
      errorCode: null,
    });
    expect(calls.find).toEqual([["u1", "an1"]]);
    expect(calls.created[0]).toMatchObject({
      analysisId: "an1",
      repositoryId: "repo1",
      requestedById: "u1",
    });
    const saved = calls.persisted[0];
    expect(saved.result.findings.map((f) => f.ruleId).sort()).toEqual([
      "DEP001",
      "SEC001",
    ]);
    expect((saved.stats as any).total).toBe(2);
    expect(saved.coverage).toEqual({ factsMissing: {}, truncated: false });
  });

  it("treats another user's or missing analysis as not found and creates nothing", async () => {
    const { deps, calls } = setup(evalProject, { header: null });
    await expect(
      runFindingsForAnalysis(deps, { userId: "u2", analysisId: "an1" }),
    ).rejects.toThrow(FindingsError);
    expect(calls.created).toHaveLength(0);
  });

  it("refuses analyses that have not finished", async () => {
    for (const status of ["PENDING", "PROCESSING", "FAILED"]) {
      const { deps, calls } = setup(evalProject, { header: { status } });
      let code = "";
      try {
        await runFindingsForAnalysis(deps, { userId: "u1", analysisId: "an1" });
      } catch (e) {
        code = (e as FindingsError).code;
      }
      expect(code).toBe("ANALYSIS_NOT_READY");
      expect(calls.created).toHaveLength(0);
    }
  });

  it("rejects invalid thresholds before creating a run", async () => {
    const { deps, calls } = setup(evalProject);
    let code = "";
    try {
      await runFindingsForAnalysis(deps, {
        userId: "u1",
        analysisId: "an1",
        thresholds: { cyclomaticMedium: -1 },
      });
    } catch (e) {
      code = (e as FindingsError).code;
    }
    expect(code).toBe("INVALID_INPUT");
    expect(calls.created).toHaveLength(0);
  });

  it("stores the thresholds used and applies them", async () => {
    const code = `export function f(a){ ${"if(a){a++}".repeat(6)} }\n`;
    const { deps, calls } = setup({ "src/f.ts": code });
    await runFindingsForAnalysis(deps, {
      userId: "u1",
      analysisId: "an1",
      thresholds: { cyclomaticMedium: 5, cyclomaticHigh: 50 },
    });
    expect(calls.created[0].thresholds.cyclomaticMedium).toBe(5);
    expect(
      calls.persisted[0].result.findings.some((f) => f.ruleId === "CPX001"),
    ).toBe(true);
  });

  it("records PARTIAL for a partial analysis and never marks it complete", async () => {
    const { deps, calls } = setup(fixtures.circular, {
      completeness: "PARTIAL",
    });
    const result = await runFindingsForAnalysis(deps, {
      userId: "u1",
      analysisId: "an1",
    });
    expect(result.status).toBe("PARTIAL");
    expect(calls.persisted[0].status).toBe("PARTIAL");
    expect(
      calls.persisted[0].result.ruleRuns.find((r) => r.ruleId === "DEP003")
        ?.status,
    ).toBe("SKIPPED");
  });

  it("records unreadable sources as missing coverage, without leaking error detail", async () => {
    const { deps, calls } = setup(evalProject, { failRead: ["src/e.ts"] });
    const result = await runFindingsForAnalysis(deps, {
      userId: "u1",
      analysisId: "an1",
    });
    expect(result.status).toBe("PARTIAL");
    expect(Object.keys(calls.persisted[0].coverage.factsMissing)).toEqual([
      "src/e.ts",
    ]);
    expect(JSON.stringify(calls.persisted[0])).not.toContain("/secret/path");
  });

  it("marks the run failed with a generic message when persistence fails", async () => {
    const { deps, calls } = setup(evalProject, { failPersist: true });
    const result = await runFindingsForAnalysis(deps, {
      userId: "u1",
      analysisId: "an1",
    });
    expect(result.status).toBe("FAILED");
    expect(calls.failed).toHaveLength(1);
    expect(JSON.stringify(calls.failed)).not.toContain("db down");
  });

  it("only reads sources the analysis covers", async () => {
    const { deps, calls } = setup({ ...evalProject, "README.md": "# hi" });
    await runFindingsForAnalysis(deps, { userId: "u1", analysisId: "an1" });
    expect(calls.reads.includes("key:README.md")).toBe(false);
  });
});
