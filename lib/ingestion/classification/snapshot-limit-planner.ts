import type {
  FileClassificationResult,
  FileSkipReason,
} from "./classification.types";

import { INGESTION_LIMITS } from "./ingestion-limits";

export interface SnapshotLimitPlan {
  files: FileClassificationResult[];
  eligibleFiles: number;
  skippedByFileLimit: number;
  skippedBySizeLimit: number;
  plannedBytes: number;
}

function skipFile(
  file: FileClassificationResult,
  reason: FileSkipReason,
): FileClassificationResult {
  return {
    ...file,
    status: "SKIPPED",
    category: null,
    reason,
  };
}

export function planSnapshotFiles(
  input: readonly FileClassificationResult[],
): SnapshotLimitPlan {
  const files = input
    .map((file) => ({ ...file }))
    .sort((a, b) => {
      if (a.path < b.path) return -1;
      if (a.path > b.path) return 1;
      return 0;
    });

  const eligibleFiles = files.filter((file) => file.status === "ELIGIBLE");

  const admittedPaths = new Set<string>();
  const rejectionReasons = new Map<string, FileSkipReason>();

  let admittedCount = 0;
  let plannedBytes = 0;
  let skippedByFileLimit = 0;
  let skippedBySizeLimit = 0;

  for (const file of eligibleFiles) {
    if (
      file.sizeBytes === null ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0
    ) {
      rejectionReasons.set(file.path, "INVALID_FILE_SIZE");
      continue;
    }

    if (admittedCount >= INGESTION_LIMITS.MAX_ELIGIBLE_FILES) {
      rejectionReasons.set(file.path, "SNAPSHOT_FILE_LIMIT");
      skippedByFileLimit += 1;
      continue;
    }

    if (
      plannedBytes + file.sizeBytes >
      INGESTION_LIMITS.MAX_SNAPSHOT_SIZE_BYTES
    ) {
      rejectionReasons.set(file.path, "SNAPSHOT_SIZE_LIMIT");
      skippedBySizeLimit += 1;
      continue;
    }

    admittedPaths.add(file.path);
    admittedCount += 1;
    plannedBytes += file.sizeBytes;
  }

  const plannedFiles = files.map((file) => {
    if (file.status !== "ELIGIBLE" || admittedPaths.has(file.path)) {
      return file;
    }

    const reason = rejectionReasons.get(file.path);

    return reason ? skipFile(file, reason) : file;
  });

  return {
    files: plannedFiles,
    eligibleFiles: admittedCount,
    skippedByFileLimit,
    skippedBySizeLimit,
    plannedBytes,
  };
}
