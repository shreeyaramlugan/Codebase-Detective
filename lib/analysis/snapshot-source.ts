// lib/analysis/snapshot-source.ts
//
// Loads an immutable Sprint 02 snapshot for analysis.
//
//  * Ownership is part of the snapshot query (another user's snapshot looks
//    like a missing one).
//  * Only files marked STORED are read; SKIPPED/FAILED files are never read
//    but their counts and reasons are retained.
//  * The client never supplies storage paths or keys. Keys come from the
//    database row and are passed only to the storage adapter, which verifies
//    the SHA-256 content hash on every read. Keys never appear in diagnostics.
//  * This module has no database dependency of its own: it works through the
//    SnapshotSourceReader interface so it can be tested without Prisma.
import {
  ANALYSIS_LIMITS,
  type DiagnosticRecord,
  type EngineSourceFile,
  type FileRecord,
  type UnavailableFile,
} from "@/features/code-intelligence/contracts";
import type { EngineInput } from "@/features/code-intelligence/engine/analyze-snapshot";
import {
  getExtension,
  getScriptKindName,
} from "@/features/code-intelligence/parser/script-kind";
import { isConfigFilePath } from "@/features/code-intelligence/resolution/project-config";
import { validateRepositoryPath } from "@/lib/ingestion/classification/path-validator";
import { StorageError } from "@/lib/ingestion/storage/storage.errors";
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";

import { AnalysisError } from "./analysis.errors";

export interface SnapshotHeader {
  id: string;
  repositoryId: string;
  commitSha: string;
  status: string;
  completeness: string | null;
}

export interface SnapshotFileRow {
  id: string;
  path: string;
  status: string;
  skipReason: string | null;
  failureCode: string | null;
  storageKey: string | null;
  contentHash: string | null;
  sizeBytes: number | null;
}

export interface SnapshotSourceReader {
  /** Must scope the lookup to the owning user. */
  findOwnedSnapshot(
    userId: string,
    snapshotId: string,
  ): Promise<SnapshotHeader | null>;
  listSnapshotFiles(snapshotId: string): Promise<SnapshotFileRow[]>;
}

export interface LoadedSnapshotSources {
  input: EngineInput;
  /** Reason -> count for snapshot files that were skipped or failed. */
  snapshotExclusions: Record<string, number>;
}

const READ_CONCURRENCY = 8;

export async function requireReadySnapshot(
  reader: SnapshotSourceReader,
  userId: string,
  snapshotId: string,
): Promise<SnapshotHeader> {
  const snapshot = await reader.findOwnedSnapshot(userId, snapshotId);

  if (!snapshot) {
    throw new AnalysisError("Snapshot not found.", "NOT_FOUND");
  }

  // FAILED snapshots hold no trustworthy content; in-flight ones are not final.
  if (snapshot.status !== "COMPLETED") {
    throw new AnalysisError(
      "Snapshot content is not available for analysis yet.",
      "SNAPSHOT_NOT_READY",
    );
  }

  return snapshot;
}

function diagnostic(
  severity: DiagnosticRecord["severity"],
  code: string,
  message: string,
  path: string | null,
  details: Record<string, unknown> | null = null,
): DiagnosticRecord {
  return {
    severity,
    source: "SNAPSHOT",
    code,
    message,
    path,
    line: null,
    column: null,
    details,
  };
}

function rejectedRecord(
  row: SnapshotFileRow,
  status: "SKIPPED" | "FAILED",
  reason: string,
): FileRecord {
  return {
    path: row.path,
    fileId: row.id,
    contentHash: row.contentHash ?? "",
    extension: getExtension(row.path),
    scriptKind: getScriptKindName(row.path),
    moduleSyntax: "UNKNOWN",
    status,
    reason,
    sizeBytes: row.sizeBytes ?? 0,
    lineCount: 0,
    syntaxErrorCount: 0,
    symbolCount: 0,
  };
}

export async function loadSnapshotSources(
  reader: SnapshotSourceReader,
  storage: SourceStorage,
  snapshot: SnapshotHeader,
): Promise<LoadedSnapshotSources> {
  const rows = await reader.listSnapshotFiles(snapshot.id);

  const sources: EngineSourceFile[] = [];
  const configs: EngineSourceFile[] = [];
  const otherStoredPaths: string[] = [];
  const unavailable: UnavailableFile[] = [];
  const rejectedFiles: FileRecord[] = [];
  const loadDiagnostics: DiagnosticRecord[] = [];
  const snapshotExclusions: Record<string, number> = {};

  const toRead: Array<{ row: SnapshotFileRow; target: "source" | "config" }> =
    [];

  for (const row of [...rows].sort((a, b) => a.path.localeCompare(b.path))) {
    const validation = validateRepositoryPath(row.path);

    if (!validation.valid) {
      loadDiagnostics.push(
        diagnostic(
          "ERROR",
          "INVALID_FILE_PATH",
          "A snapshot file has an unsafe path and was ignored.",
          null,
        ),
      );
      continue;
    }

    if (row.status !== "STORED") {
      const reason = row.skipReason ?? row.failureCode ?? "not stored";
      const label = `${row.status}: ${reason}`;
      snapshotExclusions[label] = (snapshotExclusions[label] ?? 0) + 1;
      unavailable.push({ path: row.path, reason: label });
      continue;
    }

    if (getScriptKindName(row.path) !== null) {
      toRead.push({ row, target: "source" });
    } else if (isConfigFilePath(row.path)) {
      toRead.push({ row, target: "config" });
    } else {
      otherStoredPaths.push(row.path);
    }
  }

  const readOne = async (item: (typeof toRead)[number]) => {
    const { row, target } = item;

    if (!row.storageKey || !row.contentHash) {
      rejectedFiles.push(
        rejectedRecord(row, "FAILED", "Stored file metadata is incomplete."),
      );
      loadDiagnostics.push(
        diagnostic(
          "ERROR",
          "STORED_FILE_METADATA_INCOMPLETE",
          "Stored file metadata is incomplete; the file was not analysed.",
          row.path,
        ),
      );
      return;
    }

    const limit =
      target === "config"
        ? ANALYSIS_LIMITS.MAX_CONFIG_BYTES
        : ANALYSIS_LIMITS.MAX_FILE_BYTES;

    if (row.sizeBytes !== null && row.sizeBytes > limit) {
      rejectedFiles.push(
        rejectedRecord(
          row,
          "SKIPPED",
          `File exceeds the ${limit}-byte analysis limit.`,
        ),
      );
      loadDiagnostics.push(
        diagnostic(
          "WARNING",
          "OVERSIZED_SOURCE",
          `File exceeds the ${limit}-byte analysis limit and was not read.`,
          row.path,
        ),
      );
      return;
    }

    let buffer: Buffer;

    try {
      buffer = await storage.get(row.storageKey, row.contentHash);
    } catch (error) {
      const code =
        error instanceof StorageError ? error.code : "STORAGE_READ_FAILED";
      const [diagCode, message] =
        code === "INTEGRITY_CHECK_FAILED"
          ? [
              "INTEGRITY_FAILURE",
              "Stored file failed its content hash check and was rejected.",
            ]
          : code === "OBJECT_NOT_FOUND"
            ? ["STORAGE_OBJECT_MISSING", "The stored file content is missing."]
            : code === "INVALID_STORAGE_KEY"
              ? [
                  "INVALID_STORAGE_REFERENCE",
                  "The stored file has an invalid storage reference.",
                ]
              : [
                  "STORAGE_READ_FAILED",
                  "The stored file content could not be read.",
                ];

      rejectedFiles.push(rejectedRecord(row, "FAILED", message));
      loadDiagnostics.push(diagnostic("ERROR", diagCode, message, row.path));
      return;
    }

    if (buffer.length > limit) {
      rejectedFiles.push(
        rejectedRecord(
          row,
          "SKIPPED",
          `File exceeds the ${limit}-byte analysis limit.`,
        ),
      );
      loadDiagnostics.push(
        diagnostic(
          "WARNING",
          "OVERSIZED_SOURCE",
          `File exceeds the ${limit}-byte analysis limit.`,
          row.path,
        ),
      );
      return;
    }

    const file: EngineSourceFile = {
      fileId: row.id,
      path: row.path,
      contentHash: row.contentHash,
      sizeBytes: buffer.length,
      // Untrusted text: decoded only, never evaluated.
      content: new TextDecoder("utf-8", { fatal: false }).decode(buffer),
    };

    (target === "source" ? sources : configs).push(file);
  };

  for (let index = 0; index < toRead.length; index += READ_CONCURRENCY) {
    await Promise.all(
      toRead.slice(index, index + READ_CONCURRENCY).map(readOne),
    );
  }

  for (const rejected of rejectedFiles) {
    const label = `${rejected.status}: ${rejected.reason}`;
    snapshotExclusions[label] = (snapshotExclusions[label] ?? 0) + 1;
  }

  if (snapshot.completeness !== "COMPLETE") {
    loadDiagnostics.push(
      diagnostic(
        "WARNING",
        "SNAPSHOT_NOT_COMPLETE",
        `The snapshot is ${snapshot.completeness ?? "of unknown completeness"}: some files were not stored, so results do not describe the whole repository.`,
        null,
        { completeness: snapshot.completeness, exclusions: snapshotExclusions },
      ),
    );
  }

  return {
    input: {
      sources,
      configs,
      otherStoredPaths,
      unavailable,
      rejectedFiles,
      loadDiagnostics,
      snapshotCompleteness: snapshot.completeness,
    },
    snapshotExclusions,
  };
}
