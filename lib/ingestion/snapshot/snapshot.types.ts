import type { GitHubCommitReference } from "@/lib/github/github.type";
import type { FileClassificationResult } from "@/lib/ingestion/classification/classification.types";

export type SnapshotIngestionStatus = "COMPLETED" | "PARTIAL" | "FAILED";

export type SnapshotIngestionCompleteness = "COMPLETE" | "PARTIAL" | "FAILED";

export interface SnapshotIngestionRequest {
  repositoryId: string;
  jobId: string;
  owner: string;
  repositoryName: string;
  revision: string;
}

export interface SnapshotIngestionSummary {
  totalFiles: number;
  eligibleFiles: number;
  storedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: bigint;
}

export interface SnapshotIngestionResult {
  snapshotId: string;
  commit: GitHubCommitReference;
  status: SnapshotIngestionStatus;
  completeness: SnapshotIngestionCompleteness;
  summary: SnapshotIngestionSummary;
}

export interface SnapshotFileFailure {
  path: string;
  code: string;
  message: string;
  retryable: boolean;
}

export interface SnapshotFileProcessingOutcome {
  classification: FileClassificationResult;
  stored: boolean;
  contentHash: string | null;
  storageKey: string | null;
  failure: SnapshotFileFailure | null;
}

export interface SnapshotIngestionProgress {
  snapshotId: string;
  status: "DISCOVERING" | "INGESTING";
  processedFiles: number;
  totalFiles: number;
}
export interface PersistSnapshotInventoryInput {
  snapshotId: string;
  files: FileClassificationResult[];
}
export interface PersistSnapshotFileInput {
  snapshotId: string;
  path: string;
  contentHash: string;
  storageKey: string;
  sizeBytes: number;
}
export interface MarkSnapshotFileFailedInput {
  snapshotId: string;
  path: string;
  failureCode: string;
}
export interface FinalizeSnapshotResult {
  snapshotId: string;
  status: SnapshotIngestionStatus;
  completeness: SnapshotIngestionCompleteness;
  summary: SnapshotIngestionSummary;
}
