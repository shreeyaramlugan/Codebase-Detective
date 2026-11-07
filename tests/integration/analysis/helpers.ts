// tests/integration/analysis/helpers.ts
//
// In-memory implementations of the snapshot reader and analysis store, plus a
// real LocalStorageAdapter, so the orchestration can be tested end to end
// without a database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AnalysisStore,
  CreateRunInput,
  PersistResultsInput,
} from "@/lib/analysis/analysis.store";
import {
  recordsToRows,
  rowsToRecords,
  type AnalysisRows,
} from "@/lib/analysis/analysis.mappers";
import type {
  SnapshotFileRow,
  SnapshotHeader,
  SnapshotSourceReader,
} from "@/lib/analysis/snapshot-source";
import { LocalStorageAdapter } from "@/lib/ingestion/storage/local-storage.adapter";
import { sha256 } from "../../fixtures/code-intelligence/projects";

export interface StoredRun {
  id: string;
  input: CreateRunInput;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  stats: Record<string, unknown> | null;
  rows: AnalysisRows | null;
  graph: PersistResultsInput["graph"] | null;
  failureDiagnostics: { code: string; message: string }[];
}

export class InMemoryAnalysisStore implements AnalysisStore {
  readonly runs = new Map<string, StoredRun>();
  failPersistence = false;
  private counter = 0;

  async createRun(input: CreateRunInput) {
    const id = `analysis-${++this.counter}`;
    this.runs.set(id, {
      id,
      input,
      status: "PENDING",
      errorCode: null,
      errorMessage: null,
      stats: null,
      rows: null,
      graph: null,
      failureDiagnostics: [],
    });
    return { id };
  }

  async markProcessing(id: string) {
    this.runs.get(id)!.status = "PROCESSING";
  }

  async persistResults(id: string, input: PersistResultsInput) {
    if (this.failPersistence)
      throw new Error("database exploded at /secret/path");
    const run = this.runs.get(id)!;
    // Exercises the same record -> row mapping the Prisma store uses.
    run.rows = recordsToRows(id, input.records);
    run.graph = input.graph;
    run.stats = input.stats;
    run.status = input.status;
  }

  async markFailed(
    id: string,
    input: Parameters<AnalysisStore["markFailed"]>[1],
  ) {
    const run = this.runs.get(id)!;
    run.status = "FAILED";
    run.errorCode = input.errorCode;
    run.errorMessage = input.errorMessage;
    run.failureDiagnostics = input.diagnostics;
  }

  /** Records read back from the stored rows. */
  recordsOf(id: string) {
    return rowsToRecords(this.runs.get(id)!.rows!);
  }
}

export interface FakeSnapshot {
  header: SnapshotHeader;
  ownerId: string;
  files: SnapshotFileRow[];
}

export class InMemorySnapshotReader implements SnapshotSourceReader {
  readonly snapshots = new Map<string, FakeSnapshot>();

  async findOwnedSnapshot(userId: string, snapshotId: string) {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot && snapshot.ownerId === userId ? snapshot.header : null;
  }

  async listSnapshotFiles(snapshotId: string) {
    return this.snapshots.get(snapshotId)?.files ?? [];
  }
}

export interface Harness {
  root: string;
  storage: LocalStorageAdapter;
  reader: InMemorySnapshotReader;
  store: InMemoryAnalysisStore;
  cleanup(): Promise<void>;
  addSnapshot(input: {
    id?: string;
    ownerId?: string;
    status?: string;
    completeness?: string | null;
    files: Record<string, string>;
    extra?: Partial<SnapshotFileRow>[];
  }): Promise<FakeSnapshot>;
}

export async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), "cd-analysis-"));
  const storage = new LocalStorageAdapter(root);
  const reader = new InMemorySnapshotReader();
  const store = new InMemoryAnalysisStore();

  return {
    root,
    storage,
    reader,
    store,
    cleanup: () => rm(root, { recursive: true, force: true }),
    async addSnapshot(input) {
      const id = input.id ?? "snapshot-1";
      const files: SnapshotFileRow[] = [];
      let index = 0;

      for (const [filePath, content] of Object.entries(input.files)) {
        const stored = await storage.put(Buffer.from(content));
        files.push({
          id: `file-${index++}`,
          path: filePath,
          status: "STORED",
          skipReason: null,
          failureCode: null,
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          sizeBytes: stored.sizeBytes,
        });
      }

      for (const extra of input.extra ?? []) {
        files.push({
          id: `file-${index++}`,
          path: "x",
          status: "SKIPPED",
          skipReason: null,
          failureCode: null,
          storageKey: null,
          contentHash: null,
          sizeBytes: null,
          ...extra,
        });
      }

      const snapshot: FakeSnapshot = {
        ownerId: input.ownerId ?? "user-1",
        files,
        header: {
          id,
          repositoryId: "repo-1",
          commitSha: "c0ffee",
          status: input.status ?? "COMPLETED",
          completeness:
            input.completeness === undefined ? "COMPLETE" : input.completeness,
        },
      };
      reader.snapshots.set(id, snapshot);
      return snapshot;
    },
  };
}

export { sha256 };
