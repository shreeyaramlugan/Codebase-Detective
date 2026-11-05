import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocalStorageAdapter } from "@/lib/ingestion/storage/local-storage.adapter";
import { StorageError } from "@/lib/ingestion/storage/storage.errors";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";

describe("createSourceStorageAdapter", () => {
  let rootPath: string;
  const originalProvider = process.env.SOURCE_STORAGE_PROVIDER;
  const originalRoot = process.env.SOURCE_STORAGE_ROOT;

  beforeEach(async () => {
    rootPath = await mkdtemp(
      path.join(os.tmpdir(), "codebase-detective-factory-"),
    );

    delete process.env.SOURCE_STORAGE_PROVIDER;
    delete process.env.SOURCE_STORAGE_ROOT;
  });

  afterEach(async () => {
    await rm(rootPath, { recursive: true, force: true });

    if (originalProvider === undefined) {
      delete process.env.SOURCE_STORAGE_PROVIDER;
    } else {
      process.env.SOURCE_STORAGE_PROVIDER = originalProvider;
    }

    if (originalRoot === undefined) {
      delete process.env.SOURCE_STORAGE_ROOT;
    } else {
      process.env.SOURCE_STORAGE_ROOT = originalRoot;
    }

    vi.restoreAllMocks();
  });

  it("selects local storage by default", () => {
    const adapter = createSourceStorageAdapter({
      rootPath,
    });

    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it("selects the explicitly configured local provider", () => {
    const adapter = createSourceStorageAdapter({
      provider: "local",
      rootPath,
    });

    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it("reads the provider from environment variables", () => {
    process.env.SOURCE_STORAGE_PROVIDER = "local";
    process.env.SOURCE_STORAGE_ROOT = rootPath;

    const adapter = createSourceStorageAdapter();

    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it("uses the default storage root when no root is configured", () => {
    const adapter = createSourceStorageAdapter({
      provider: "local",
    });

    expect(adapter).toBeInstanceOf(LocalStorageAdapter);
  });

  it("rejects an empty provider", () => {
    expect(() =>
      createSourceStorageAdapter({
        provider: "   ",
        rootPath,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_CONFIGURATION_ERROR",
      }),
    );
  });

  it("rejects an empty storage root", () => {
    expect(() =>
      createSourceStorageAdapter({
        provider: "local",
        rootPath: "   ",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_CONFIGURATION_ERROR",
      }),
    );
  });

  it("rejects unsupported providers", () => {
    expect(() =>
      createSourceStorageAdapter({
        provider: "s3",
        rootPath,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "STORAGE_CONFIGURATION_ERROR",
      }),
    );
  });

  it("does not initialize the storage directory during factory creation", async () => {
    const nestedRoot = path.join(rootPath, "not-created-yet");

    createSourceStorageAdapter({
      provider: "local",
      rootPath: nestedRoot,
    });

    await expect(
      import("node:fs/promises").then(({ access }) => access(nestedRoot)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not modify the configured storage environment variables", () => {
    const providerBefore = process.env.SOURCE_STORAGE_PROVIDER;
    const rootBefore = process.env.SOURCE_STORAGE_ROOT;

    createSourceStorageAdapter({
      provider: "local",
      rootPath,
    });

    expect(process.env.SOURCE_STORAGE_PROVIDER).toBe(providerBefore);
    expect(process.env.SOURCE_STORAGE_ROOT).toBe(rootBefore);
  });

  it("throws a StorageError for invalid configuration", () => {
    try {
      createSourceStorageAdapter({
        provider: "s3",
        rootPath,
      });

      throw new Error("Expected factory to reject unsupported provider");
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect((error as StorageError).code).toBe("STORAGE_CONFIGURATION_ERROR");
    }
  });
});
