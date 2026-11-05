// lib/ingestion/storage/storage.types.ts
export type StorageProvider = "local";

export interface StoredObject {
  storageKey: string;
  contentHash: string;
  sizeBytes: number;
}

export interface SourceStorageAdapter {
  /**
   * Stores verified source bytes and returns their storage metadata.
   * Implementations must not overwrite an existing object.
   */
  put(content: Buffer): Promise<StoredObject>;

  /**
   * Retrieves an object and verifies it against the expected SHA-256 hash.
   */
  get(storageKey: string, expectedContentHash: string): Promise<Buffer>;

  /**
   * Deletes an object.
   * Deleting a missing object should be treated as successful.
   */
  delete(storageKey: string): Promise<void>;

  /**
   * Checks whether an object exists.
   */
  exists(storageKey: string): Promise<boolean>;
}

/**
 * Provider-independent name used by services. Services depend on this
 * interface and never on a concrete adapter such as the local filesystem.
 */
export type SourceStorage = SourceStorageAdapter;
