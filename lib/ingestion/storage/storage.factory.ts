import { StorageError } from "./storage.errors";
import { LocalStorageAdapter } from "./local-storage.adapter";
import type { SourceStorageAdapter, StorageProvider } from "./storage.types";

export interface StorageFactoryOptions {
  provider?: string;
  rootPath?: string;
}

export function createSourceStorageAdapter(
  options: StorageFactoryOptions = {},
): SourceStorageAdapter {
  const provider = (
    options.provider ??
    process.env.SOURCE_STORAGE_PROVIDER ??
    "local"
  ).trim();

  const rootPath = (
    options.rootPath ??
    process.env.SOURCE_STORAGE_ROOT ??
    "./storage"
  ).trim();

  if (!provider) {
    throw new StorageError(
      "SOURCE_STORAGE_PROVIDER cannot be empty.",
      "STORAGE_CONFIGURATION_ERROR",
    );
  }

  if (!rootPath) {
    throw new StorageError(
      "SOURCE_STORAGE_ROOT cannot be empty.",
      "STORAGE_CONFIGURATION_ERROR",
    );
  }

  if (provider !== "local") {
    throw new StorageError(
      `Unsupported source storage provider: ${provider}.`,
      "STORAGE_CONFIGURATION_ERROR",
    );
  }

  const selectedProvider: StorageProvider = "local";

  switch (selectedProvider) {
    case "local":
      return new LocalStorageAdapter(rootPath);
    default: {
      const exhaustiveCheck: never = selectedProvider;
      throw new StorageError(
        `Unsupported source storage provider: ${exhaustiveCheck}.`,
        "STORAGE_CONFIGURATION_ERROR",
      );
    }
  }
}
