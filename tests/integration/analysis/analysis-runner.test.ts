// tests/integration/analysis/analysis-runner.test.ts
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildGraph } from "@/features/code-intelligence/graph/build-graph";
import { validateGraph } from "@/features/code-intelligence/graph/validate-graph";
import { AnalysisError } from "@/lib/analysis/analysis.errors";
import { runSnapshotAnalysis } from "@/lib/analysis/analysis.runner";
import { ANALYSIS_LIMITS } from "@/features/code-intelligence/contracts";
import { fixtures } from "../../fixtures/code-intelligence/projects";
import { createHarness, type Harness } from "./helpers";

const project = {
  ...fixtures.relativeImports,
  ...fixtures.aliases,
  "package.json": `{"name":"app"}`,
};

describe("snapshot analysis (end to end)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const run = (userId = "user-1", snapshotId = "snapshot-1") =>
    runSnapshotAnalysis(
      { reader: h.reader, storage: h.storage, store: h.store },
      { userId, snapshotId },
    );

  it("analyses a stored snapshot and persists records and graph", async () => {
    await h.addSnapshot({ files: project });
    const result = await run();

    expect(result).toEqual({
      analysisId: "analysis-1",
      status: "COMPLETED",
      errorCode: null,
    });
    const stored = h.store.runs.get(result.analysisId)!;
    expect(stored.input.commitSha).toBe("c0ffee");
    expect(stored.input.snapshotCompleteness).toBe("COMPLETE");
    expect(stored.input.engineVersion).toMatch(/\d/);
    expect(stored.input.parserVersion).toMatch(/^typescript@/);
    expect(stored.rows!.symbols.length).toBeGreaterThan(0);
    expect(
      stored.rows!.files.find((f) => f.path === "src/a.ts")!.contentHash,
    ).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.graph!.metadata.analysisId).toBe(result.analysisId);
    expect(validateGraph(stored.graph!)).toEqual([]);
  });

  it("creates a new immutable run for every execution", async () => {
    await h.addSnapshot({ files: project });
    const first = await run();
    const snapshotBefore = JSON.stringify(h.store.runs.get(first.analysisId));
    const second = await run();

    expect(second.analysisId).not.toBe(first.analysisId);
    expect(JSON.stringify(h.store.runs.get(first.analysisId))).toBe(
      snapshotBefore,
    );

    const a = h.store.runs.get(first.analysisId)!.rows!;
    const b = h.store.runs.get(second.analysisId)!.rows!;
    // Same inputs, same stable keys, but run-scoped row ids never collide.
    expect(a.symbols.map((s) => s.stableKey)).toEqual(
      b.symbols.map((s) => s.stableKey),
    );
    const ids = new Set([...a.symbols, ...b.symbols].map((s) => s.id));
    expect(ids.size).toBe(a.symbols.length + b.symbols.length);
    expect(b.symbols.every((s) => s.analysisId === second.analysisId)).toBe(
      true,
    );
  });

  it("is safe when submitted twice at once", async () => {
    await h.addSnapshot({ files: project });
    const [x, y] = await Promise.all([run(), run()]);
    expect(x.analysisId).not.toBe(y.analysisId);
    expect(h.store.runs.size).toBe(2);
    expect(x.status).toBe("COMPLETED");
    expect(y.status).toBe("COMPLETED");
  });

  it("preserves partial snapshot completeness and never reports it as complete", async () => {
    await h.addSnapshot({
      completeness: "PARTIAL",
      files: { "src/a.ts": `import { x } from "./cut";` },
      extra: [
        { path: "src/cut.ts", status: "SKIPPED", skipReason: "FILE_TOO_LARGE" },
      ],
    });
    const result = await run();
    const stored = h.store.runs.get(result.analysisId)!;

    expect(result.status).toBe("PARTIAL");
    expect(stored.input.snapshotCompleteness).toBe("PARTIAL");
    expect(stored.stats!.snapshotExclusions).toEqual({
      "SKIPPED: FILE_TOO_LARGE": 1,
    });
    const records = h.store.recordsOf(result.analysisId);
    expect(
      records.diagnostics.some((d) => d.code === "SNAPSHOT_NOT_COMPLETE"),
    ).toBe(true);
    expect(records.dependencies[0].reason).toContain("FILE_TOO_LARGE");
  });

  it("marks runs with syntax errors as PARTIAL", async () => {
    await h.addSnapshot({ files: fixtures.invalidSyntax });
    expect((await run()).status).toBe("PARTIAL");
  });

  it("excludes skipped and failed files from parsing but keeps their reasons", async () => {
    await h.addSnapshot({
      files: { "src/a.ts": "export const a = 1;" },
      extra: [
        { path: "src/s.ts", status: "SKIPPED", skipReason: "SENSITIVE" },
        { path: "src/f.ts", status: "FAILED", failureCode: "DOWNLOAD_FAILED" },
      ],
    });
    const result = await run();
    const files = h.store.runs
      .get(result.analysisId)!
      .rows!.files.map((f) => f.path);
    expect(files).toEqual(["src/a.ts"]);
    expect(
      h.store.runs.get(result.analysisId)!.stats!.snapshotExclusions,
    ).toEqual({
      "SKIPPED: SENSITIVE": 1,
      "FAILED: DOWNLOAD_FAILED": 1,
    });
  });

  it("rejects a file whose content no longer matches its hash", async () => {
    const snapshot = await h.addSnapshot({
      files: {
        "src/a.ts": "export const a = 1;",
        "src/b.ts": "export const b = 2;",
      },
    });
    const tampered = snapshot.files.find((f) => f.path === "src/a.ts")!;
    await writeFile(
      path.join(h.root, "objects", tampered.storageKey!),
      "export const evil = 1;",
    );

    const result = await run();
    const records = h.store.recordsOf(result.analysisId);
    expect(result.status).toBe("PARTIAL");
    expect(records.files.find((f) => f.path === "src/a.ts")).toMatchObject({
      status: "FAILED",
    });
    expect(records.symbols.map((s) => s.name)).toEqual(["b"]);
    const diag = records.diagnostics.find(
      (d) => d.code === "INTEGRITY_FAILURE",
    )!;
    expect(diag.path).toBe("src/a.ts");
    expect(JSON.stringify(records.diagnostics)).not.toContain(
      tampered.storageKey!,
    );
  });

  it("records a safe diagnostic when the storage object is missing", async () => {
    const snapshot = await h.addSnapshot({
      files: { "src/a.ts": "export const a = 1;" },
    });
    const row = snapshot.files[0];
    await unlink(path.join(h.root, "objects", row.storageKey!));

    const result = await run();
    const records = h.store.recordsOf(result.analysisId);
    expect(result.status).toBe("PARTIAL");
    expect(
      records.diagnostics.some((d) => d.code === "STORAGE_OBJECT_MISSING"),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain(row.storageKey!);
  });

  it("rejects tampered storage references without reading outside storage", async () => {
    const snapshot = await h.addSnapshot({
      files: { "src/a.ts": "export const a = 1;" },
    });
    snapshot.files[0].storageKey = "../../etc/passwd";

    const result = await run();
    const records = h.store.recordsOf(result.analysisId);
    expect(records.files[0].status).toBe("FAILED");
    expect(
      records.diagnostics.some((d) => d.code === "INVALID_STORAGE_REFERENCE"),
    ).toBe(true);
    expect(JSON.stringify(records)).not.toContain("etc/passwd");
  });

  it("diagnoses incomplete stored metadata", async () => {
    const snapshot = await h.addSnapshot({
      files: { "src/a.ts": "export const a = 1;" },
    });
    snapshot.files[0].storageKey = null;
    const result = await run();
    expect(
      h.store
        .recordsOf(result.analysisId)
        .diagnostics.some((d) => d.code === "STORED_FILE_METADATA_INCOMPLETE"),
    ).toBe(true);
  });

  it("limits oversized input without reading it", async () => {
    const snapshot = await h.addSnapshot({
      files: { "src/a.ts": "export const a = 1;" },
    });
    snapshot.files[0].sizeBytes = ANALYSIS_LIMITS.MAX_FILE_BYTES + 1;
    const result = await run();
    const records = h.store.recordsOf(result.analysisId);
    expect(records.files[0].status).toBe("SKIPPED");
    expect(records.diagnostics.some((d) => d.code === "OVERSIZED_SOURCE")).toBe(
      true,
    );
  });

  it("ignores snapshot files with unsafe paths", async () => {
    const snapshot = await h.addSnapshot({
      files: { "src/a.ts": "export const a = 1;" },
    });
    snapshot.files.push({
      ...snapshot.files[0],
      id: "evil",
      path: "../../outside.ts",
    });
    const result = await run();
    const records = h.store.recordsOf(result.analysisId);
    expect(records.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(
      records.diagnostics.some((d) => d.code === "INVALID_FILE_PATH"),
    ).toBe(true);
  });

  it("keeps failed runs inspectable and hides internal error detail", async () => {
    await h.addSnapshot({ files: project });
    h.store.failPersistence = true;
    const result = await run();
    const stored = h.store.runs.get(result.analysisId)!;

    expect(result).toMatchObject({
      status: "FAILED",
      errorCode: "ANALYSIS_FAILED",
    });
    expect(stored.status).toBe("FAILED");
    expect(stored.errorMessage).toBe("The analysis could not be completed.");
    expect(JSON.stringify(stored)).not.toContain("/secret/path");
    expect(stored.failureDiagnostics[0].code).toBe("ANALYSIS_FAILED");

    h.store.failPersistence = false;
    const again = await run();
    expect(again.status).toBe("COMPLETED");
    expect(h.store.runs.get(result.analysisId)!.status).toBe("FAILED");
  });

  it("regenerates an identical graph from the stored relational rows", async () => {
    await h.addSnapshot({
      files: {
        ...project,
        ...fixtures.reexports,
        ...fixtures.commonjs,
        ...fixtures.circular,
      },
    });
    const result = await run();
    const stored = h.store.runs.get(result.analysisId)!;
    const regenerated = buildGraph(h.store.recordsOf(result.analysisId), {
      analysisId: result.analysisId,
      snapshotId: stored.input.snapshotId,
      commitSha: stored.input.commitSha,
      snapshotCompleteness: stored.input.snapshotCompleteness,
      engineVersion: stored.input.engineVersion,
      parserVersion: stored.input.parserVersion,
    });
    expect(JSON.stringify(regenerated)).toBe(JSON.stringify(stored.graph));
  });

  it("keeps every row inside its own analysis and file", async () => {
    await h.addSnapshot({ files: { ...project, ...fixtures.duplicateNames } });
    const result = await run();
    const rows = h.store.runs.get(result.analysisId)!.rows!;
    const fileIds = new Set(rows.files.map((f) => f.id));
    const symbolIds = new Set(rows.symbols.map((s) => s.id));

    for (const row of [
      ...rows.files,
      ...rows.symbols,
      ...rows.dependencies,
      ...rows.calls,
      ...rows.relations,
      ...rows.diagnostics,
    ]) {
      expect(row.analysisId).toBe(result.analysisId);
    }
    for (const symbol of rows.symbols) {
      expect(fileIds.has(symbol.fileId)).toBe(true);
      if (symbol.parentId) expect(symbolIds.has(symbol.parentId)).toBe(true);
    }
    for (const call of rows.calls) {
      if (call.targetSymbolId)
        expect(symbolIds.has(call.targetSymbolId)).toBe(true);
    }
  });
});

describe("snapshot access control", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
    await h.addSnapshot({ files: { "src/a.ts": "export const a = 1;" } });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const run = (userId: string, snapshotId: string) =>
    runSnapshotAnalysis(
      { reader: h.reader, storage: h.storage, store: h.store },
      { userId, snapshotId },
    );

  it("prevents cross-user snapshot access and creates no run", async () => {
    await expect(run("intruder", "snapshot-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(h.store.runs.size).toBe(0);
  });

  it("treats unknown snapshots like missing ones", async () => {
    await expect(run("user-1", "nope")).rejects.toBeInstanceOf(AnalysisError);
  });

  it("refuses snapshots that are not completed", async () => {
    await h.addSnapshot({ id: "pending", status: "INGESTING", files: {} });
    await h.addSnapshot({
      id: "failed",
      status: "FAILED",
      completeness: "FAILED",
      files: {},
    });
    await expect(run("user-1", "pending")).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_READY",
    });
    await expect(run("user-1", "failed")).rejects.toMatchObject({
      code: "SNAPSHOT_NOT_READY",
    });
    expect(h.store.runs.size).toBe(0);
  });
});
