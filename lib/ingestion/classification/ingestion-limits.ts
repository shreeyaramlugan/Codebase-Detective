/**
 * Centralised safety limits for repository source ingestion.
 *
 * These limits apply before file contents are downloaded.
 * Downloaded content must be checked again against the same limits.
 */

export const INGESTION_LIMITS = {
  /** Maximum size of an individual file: 1 MiB. */
  MAX_FILE_SIZE_BYTES: 1 * 1024 * 1024,

  /** Maximum total stored content per snapshot: 100 MiB. */
  MAX_SNAPSHOT_SIZE_BYTES: 100 * 1024 * 1024,

  /** Maximum number of eligible files in one snapshot. */
  MAX_ELIGIBLE_FILES: 10_000,

  /** Maximum full repository path length. */
  MAX_PATH_LENGTH: 1_024,

  /** Maximum individual path segment length. */
  MAX_PATH_SEGMENT_LENGTH: 255,

  /** Maximum number of entries in a repository tree. */
  MAX_TREE_ENTRIES: 100_000,

  /** Maximum retrieval attempts for an individual GitHub blob. */
  MAX_BLOB_RETRIEVAL_ATTEMPTS: 3,
} as const;
