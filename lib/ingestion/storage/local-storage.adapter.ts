import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { StorageError } from "./storage.errors";
import type { SourceStorageAdapter, StoredObject } from "./storage.types";

const STORAGE_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export class LocalStorageAdapter implements SourceStorageAdapter {
  private readonly rootPath: string;
  private readonly objectsPath: string;
  private initializationPromise: Promise<void> | null = null;

  constructor(rootPath: string) {
    if (!rootPath.trim()) {
      throw new StorageError(
        "Storage root directory is not configured.",
        "STORAGE_CONFIGURATION_ERROR",
      );
    }

    this.rootPath = path.resolve(rootPath);
    this.objectsPath = path.join(this.rootPath, "objects");
  }

  private async initialize(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        try {
          await mkdir(this.objectsPath, { recursive: true });

          const resolvedRoot = await realpath(this.rootPath);
          const resolvedObjects = await realpath(this.objectsPath);

          if (
            resolvedObjects !== resolvedRoot &&
            !resolvedObjects.startsWith(`${resolvedRoot}${path.sep}`)
          ) {
            throw new StorageError(
              "Storage objects directory resolves outside the storage root.",
              "STORAGE_CONFIGURATION_ERROR",
            );
          }
        } catch (error) {
          if (error instanceof StorageError) {
            throw error;
          }

          throw new StorageError(
            "Unable to initialize local source storage.",
            "STORAGE_CONFIGURATION_ERROR",
            true,
          );
        }
      })();
    }

    return this.initializationPromise;
  }

  private validateStorageKey(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new StorageError("Invalid storage key.", "INVALID_STORAGE_KEY");
    }

    const objectPath = path.resolve(this.objectsPath, storageKey);

    if (path.dirname(objectPath) !== this.objectsPath) {
      throw new StorageError(
        "Storage key resolves outside the objects directory.",
        "INVALID_STORAGE_KEY",
      );
    }

    return objectPath;
  }

  private hash(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
  }

  async put(content: Buffer): Promise<StoredObject> {
    if (!Buffer.isBuffer(content)) {
      throw new StorageError(
        "Storage content must be a Buffer.",
        "STORAGE_WRITE_FAILED",
      );
    }

    await this.initialize();

    const storageKey = randomUUID();
    const contentHash = this.hash(content);
    const destination = this.validateStorageKey(storageKey);

    let temporaryDirectory: string | null = null;
    let temporaryFile: string | null = null;

    try {
      temporaryDirectory = await mkdtemp(path.join(this.objectsPath, ".tmp-"));

      temporaryFile = path.join(temporaryDirectory, "content");

      await writeFile(temporaryFile, content, { flag: "wx" });

      // Hard-link publication is atomic and fails if the destination exists.
      await link(temporaryFile, destination);

      return {
        storageKey,
        contentHash,
        sizeBytes: content.byteLength,
      };
    } catch {
      throw new StorageError(
        "Unable to store source content.",
        "STORAGE_WRITE_FAILED",
        true,
      );
    } finally {
      if (temporaryDirectory) {
        try {
          await rm(temporaryDirectory, {
            recursive: true,
            force: true,
          });
        } catch {
          // Preserve the original operation result.
        }
      }
    }
  }

  async get(storageKey: string, expectedContentHash: string): Promise<Buffer> {
    if (!SHA256_PATTERN.test(expectedContentHash)) {
      throw new StorageError(
        "Invalid expected SHA-256 content hash.",
        "INTEGRITY_CHECK_FAILED",
      );
    }

    await this.initialize();

    const objectPath = this.validateStorageKey(storageKey);

    try {
      const metadata = await lstat(objectPath);

      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new StorageError(
          "Stored object is not a regular file.",
          "STORAGE_READ_FAILED",
        );
      }

      const content = await readFile(objectPath);
      const actualHash = this.hash(content);

      if (actualHash !== expectedContentHash.toLowerCase()) {
        throw new StorageError(
          "Stored object failed SHA-256 integrity verification.",
          "INTEGRITY_CHECK_FAILED",
        );
      }

      return content;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        throw new StorageError(
          "Stored object was not found.",
          "OBJECT_NOT_FOUND",
        );
      }

      throw new StorageError(
        "Unable to read stored source content.",
        "STORAGE_READ_FAILED",
        true,
      );
    }
  }

  async delete(storageKey: string): Promise<void> {
    await this.initialize();

    const objectPath = this.validateStorageKey(storageKey);

    try {
      const metadata = await lstat(objectPath);

      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new StorageError(
          "Stored object is not a regular file.",
          "STORAGE_DELETE_FAILED",
        );
      }

      await unlink(objectPath);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return;
      }

      throw new StorageError(
        "Unable to delete stored source content.",
        "STORAGE_DELETE_FAILED",
        true,
      );
    }
  }
  async exists(storageKey: string): Promise<boolean> {
    await this.initialize();

    const objectPath = this.validateStorageKey(storageKey);

    try {
      const metadata = await lstat(objectPath);

      return metadata.isFile() && !metadata.isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === "ENOENT") {
        return false;
      }

      throw new StorageError(
        "Unable to check stored source content.",
        "STORAGE_READ_FAILED",
        true,
      );
    }
  }
}
