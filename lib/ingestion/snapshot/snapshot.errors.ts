export type SnapshotErrorCode =
  | "INVALID_REQUEST"
  | "TREE_RETRIEVAL_FAILED"
  | "TREE_INCOMPLETE"
  | "SNAPSHOT_ALREADY_PROCESSING"
  | "SNAPSHOT_CONFLICT"
  | "NO_USABLE_SOURCE_FILES"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_PERSISTENCE_FAILED"
  | "FILE_INGESTION_FAILED"
  | "STORAGE_CLEANUP_FAILED";

export class SnapshotIngestionError extends Error {
  constructor(
    message: string,
    public readonly code: SnapshotErrorCode,
    public readonly retryable = false,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SnapshotIngestionError";
  }
}
