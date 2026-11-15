// lib/ingestion/storage/storage.factory.ts
import { StorageError } from "./storage.errors";
import { LocalStorageAdapter } from "./local-storage.adapter";
import { S3StorageAdapter, type S3StorageOptions } from "./s3-storage.adapter";
import type { SourceStorageAdapter, StorageProvider } from "./storage.types";

export interface StorageFactoryOptions {
  provider?: string;
  rootPath?: string;
  /** Overrides the S3_* environment variables (used by tests). */
  s3?: Partial<S3StorageOptions>;
}

function configError(message: string): StorageError {
  return new StorageError(message, "STORAGE_CONFIGURATION_ERROR");
}

function createS3Adapter(
  overrides: Partial<S3StorageOptions> = {},
): S3StorageAdapter {
  const env = process.env;
  return new S3StorageAdapter({
    endpoint: env.S3_ENDPOINT ?? "",
    region: env.S3_REGION ?? "auto",
    bucket: env.S3_BUCKET ?? "",
    accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== "false",
    keyPrefix: env.S3_KEY_PREFIX ?? "",
    ...overrides,
  });
}

export function createSourceStorageAdapter(
  options: StorageFactoryOptions = {},
): SourceStorageAdapter {
  const provider = (
    options.provider ??
    process.env.SOURCE_STORAGE_PROVIDER ??
    "local"
  ).trim();

  if (!provider) {
    throw configError("SOURCE_STORAGE_PROVIDER cannot be empty.");
  }

  if (provider !== "local" && provider !== "s3") {
    throw configError(`Unsupported source storage provider: ${provider}.`);
  }

  const selectedProvider: StorageProvider = provider;

  switch (selectedProvider) {
    case "s3":
      return createS3Adapter(options.s3);
    case "local": {
      const rootPath = (
        options.rootPath ??
        process.env.SOURCE_STORAGE_ROOT ??
        "./storage"
      ).trim();
      if (!rootPath) {
        throw configError("SOURCE_STORAGE_ROOT cannot be empty.");
      }
      return new LocalStorageAdapter(rootPath);
    }
    default: {
      const exhaustiveCheck: never = selectedProvider;
      throw configError(
        `Unsupported source storage provider: ${exhaustiveCheck}.`,
      );
    }
  }
}
