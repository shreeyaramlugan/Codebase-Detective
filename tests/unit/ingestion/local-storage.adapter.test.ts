import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStorageAdapter } from "@/lib/ingestion/storage/local-storage.adapter";
import { StorageError } from "@/lib/ingestion/storage/storage.errors";

describe("LocalStorageAdapter", () => {
  let rootPath: string;
  let adapter: LocalStorageAdapter;

  const testContent = Buffer.from("Codebase Detective source content");

  const sha256 = (content: Buffer): string =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(async () => {
    rootPath = await mkdtemp(
      path.join(os.tmpdir(), "codebase-detective-storage-"),
    );

    adapter = new LocalStorageAdapter(rootPath);
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });
  });

  it("stores content and returns the correct metadata", async () => {
    const result = await adapter.put(testContent);

    expect(result.storageKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(result.contentHash).toBe(sha256(testContent));
    expect(result.sizeBytes).toBe(testContent.byteLength);
  });

  it("retrieves stored content successfully", async () => {
    const stored = await adapter.put(testContent);

    const retrieved = await adapter.get(stored.storageKey, stored.contentHash);

    expect(retrieved.equals(testContent)).toBe(true);
  });

  it("rejects content when the expected hash is incorrect", async () => {
    const stored = await adapter.put(testContent);

    await expect(
      adapter.get(stored.storageKey, "a".repeat(64)),
    ).rejects.toMatchObject({
      code: "INTEGRITY_CHECK_FAILED",
    });
  });

  it("rejects malformed storage keys", async () => {
    await expect(
      adapter.get("../outside", sha256(testContent)),
    ).rejects.toMatchObject({
      code: "INVALID_STORAGE_KEY",
    });

    await expect(adapter.exists("../../outside")).rejects.toBeInstanceOf(
      StorageError,
    );
  });

  it("returns false when an object does not exist", async () => {
    const missingKey = "00000000-0000-4000-8000-000000000000";

    await expect(adapter.exists(missingKey)).resolves.toBe(false);
  });

  it("deletes stored objects successfully", async () => {
    const stored = await adapter.put(testContent);

    await adapter.delete(stored.storageKey);

    await expect(adapter.exists(stored.storageKey)).resolves.toBe(false);
  });

  it("treats deletion of a missing object as successful", async () => {
    const missingKey = "00000000-0000-4000-8000-000000000000";

    await expect(adapter.delete(missingKey)).resolves.toBeUndefined();
  });

  it("does not overwrite an existing object", async () => {
    const first = await adapter.put(testContent);
    const originalContent = await adapter.get(
      first.storageKey,
      first.contentHash,
    );

    expect(originalContent.equals(testContent)).toBe(true);

    // UUID generation makes collisions extremely unlikely.
    // The adapter's hard-link publication prevents overwrites.
    const second = await adapter.put(Buffer.from("Different content"));

    expect(second.storageKey).not.toBe(first.storageKey);

    const unchanged = await adapter.get(first.storageKey, first.contentHash);

    expect(unchanged.equals(testContent)).toBe(true);
  });

  it("supports empty content", async () => {
    const emptyContent = Buffer.alloc(0);
    const stored = await adapter.put(emptyContent);

    expect(stored.sizeBytes).toBe(0);
    expect(stored.contentHash).toBe(sha256(emptyContent));

    const retrieved = await adapter.get(stored.storageKey, stored.contentHash);

    expect(retrieved.length).toBe(0);
  });

  it("supports Unicode content", async () => {
    const unicodeContent = Buffer.from(
      "Codebase Detective — café ☕ — 代码侦探",
      "utf8",
    );

    const stored = await adapter.put(unicodeContent);

    const retrieved = await adapter.get(stored.storageKey, stored.contentHash);

    expect(retrieved.equals(unicodeContent)).toBe(true);
  });

  it("cleans up temporary directories after successful writes", async () => {
    await adapter.put(testContent);

    const objectsDirectory = path.join(rootPath, "objects");
    const entries = await readdir(objectsDirectory);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
  it("does not report symbolic links as stored objects", async () => {
    const stored = await adapter.put(testContent);

    const objectPath = path.join(rootPath, "objects", stored.storageKey);

    await rm(objectPath);

    const outsideFile = path.join(rootPath, "outside.txt");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(outsideFile, testContent),
    );

    await import("node:fs/promises").then(({ symlink }) =>
      symlink(outsideFile, objectPath),
    );

    await expect(adapter.exists(stored.storageKey)).resolves.toBe(false);
  });

  it("refuses to delete symbolic links", async () => {
    const stored = await adapter.put(testContent);

    const objectPath = path.join(rootPath, "objects", stored.storageKey);

    await rm(objectPath);

    const outsideFile = path.join(rootPath, "outside.txt");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(outsideFile, testContent),
    );

    await import("node:fs/promises").then(({ symlink }) =>
      symlink(outsideFile, objectPath),
    );

    await expect(adapter.delete(stored.storageKey)).rejects.toMatchObject({
      code: "STORAGE_DELETE_FAILED",
    });
  });
  it("stores objects as regular files", async () => {
    const stored = await adapter.put(testContent);

    const objectsDirectory = path.join(rootPath, "objects");
    const storedContent = await readFile(
      path.join(objectsDirectory, stored.storageKey),
    );

    expect(storedContent.equals(testContent)).toBe(true);
  });
  it("detects content modified directly on disk", async () => {
    const stored = await adapter.put(testContent);

    const objectPath = path.join(rootPath, "objects", stored.storageKey);

    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(objectPath, Buffer.from("Tampered content")),
    );

    await expect(
      adapter.get(stored.storageKey, stored.contentHash),
    ).rejects.toMatchObject({
      code: "INTEGRITY_CHECK_FAILED",
    });
  });
});
