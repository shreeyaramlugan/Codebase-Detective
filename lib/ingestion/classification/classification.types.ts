import type { GitHubTreeEntry } from "@/lib/github/github.type";

export type IngestionFileCategory =
  "SOURCE" | "CONFIGURATION" | "DOCUMENTATION";

export type FileClassificationStatus = "ELIGIBLE" | "SKIPPED";

export type FileSkipReason =
  | "UNSAFE_PATH"
  | "PATH_TOO_LONG"
  | "PATH_SEGMENT_TOO_LONG"
  | "UNSUPPORTED_GIT_ENTRY"
  | "SYMLINK_NOT_SUPPORTED"
  | "SUBMODULE_NOT_SUPPORTED"
  | "EXCLUDED_DIRECTORY"
  | "DEPENDENCY_DIRECTORY"
  | "GENERATED_DIRECTORY"
  | "CACHE_DIRECTORY"
  | "SENSITIVE_FILE"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_SIZE"
  | "SNAPSHOT_FILE_LIMIT"
  | "SNAPSHOT_SIZE_LIMIT";

export interface FileClassificationResult {
  path: string;
  name: string;
  extension: string | null;
  status: FileClassificationStatus;
  category: IngestionFileCategory | null;
  reason: FileSkipReason | null;
  gitBlobSha: string | null;
  sizeBytes: number | null;
}

export type FileClassificationInput = GitHubTreeEntry;
