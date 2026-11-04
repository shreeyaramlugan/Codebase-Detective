import type { GitHubTreeEntry } from "@/lib/github/github.type";

import type {
  FileClassificationResult,
  FileSkipReason,
} from "./classification.types";

import {
  getGitEntryExclusionReason,
  getPathExclusionReason,
} from "./exclusion-rules";
import { getFileExtensionClassification } from "./file-extensions";
import { INGESTION_LIMITS } from "./ingestion-limits";
import { validateRepositoryPath } from "./path-validator";

function skipped(
  entry: GitHubTreeEntry,
  reason: FileSkipReason,
  extension: string | null = null,
): FileClassificationResult {
  const segments = entry.path.split("/");
  const name = segments[segments.length - 1] ?? entry.path;

  return {
    path: entry.path,
    name,
    extension,
    status: "SKIPPED",
    category: null,
    reason,
    gitBlobSha: entry.type === "blob" ? entry.sha : null,
    sizeBytes:
      typeof entry.size === "number" && Number.isSafeInteger(entry.size)
        ? entry.size
        : null,
  };
}

export function classifyGitHubTreeEntry(
  entry: GitHubTreeEntry,
): FileClassificationResult {
  // 1. Validate the repository path.
  const pathValidation = validateRepositoryPath(entry.path);

  if (!pathValidation.valid) {
    return skipped(entry, pathValidation.error ?? "UNSAFE_PATH");
  }

  const safePath = pathValidation.normalizedPath;

  if (!safePath) {
    return skipped(entry, "UNSAFE_PATH");
  }

  // 2. Check the Git entry type and mode.
  const gitExclusion = getGitEntryExclusionReason(entry);

  if (gitExclusion) {
    return skipped(entry, gitExclusion);
  }

  // 3. Apply sensitive-file and directory exclusions.
  const pathExclusion = getPathExclusionReason(safePath);

  if (pathExclusion) {
    return skipped(entry, pathExclusion);
  }

  // 4. Determine the file category.
  const classification = getFileExtensionClassification(safePath);

  if (!classification.category) {
    return skipped(entry, "UNSUPPORTED_FILE_TYPE", classification.extension);
  }

  // 5. Validate the declared blob size.
  const size = entry.size;

  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    return skipped(entry, "INVALID_FILE_SIZE", classification.extension);
  }

  // 6. Enforce the individual file size limit.
  if (size > INGESTION_LIMITS.MAX_FILE_SIZE_BYTES) {
    return skipped(entry, "FILE_TOO_LARGE", classification.extension);
  }

  // 7. Return an eligible file.
  const segments = safePath.split("/");
  const name = segments[segments.length - 1] ?? safePath;

  return {
    path: safePath,
    name,
    extension: classification.extension,
    status: "ELIGIBLE",
    category: classification.category,
    reason: null,
    gitBlobSha: entry.sha,
    sizeBytes: size,
  };
}
