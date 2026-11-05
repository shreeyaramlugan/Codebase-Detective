export type StorageErrorCode =
  | "INVALID_STORAGE_KEY"
  | "OBJECT_NOT_FOUND"
  | "OBJECT_ALREADY_EXISTS"
  | "INTEGRITY_CHECK_FAILED"
  | "STORAGE_READ_FAILED"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_DELETE_FAILED"
  | "STORAGE_CONFIGURATION_ERROR";

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly code: StorageErrorCode,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "StorageError";
  }
}
