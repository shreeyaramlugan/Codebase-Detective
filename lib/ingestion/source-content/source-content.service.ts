// lib/ingestion/source-content/source-content.service.ts
import { prisma } from "@/lib/db/prisma";
import { validateRepositoryPath } from "@/lib/ingestion/classification/path-validator";
import { StorageError } from "@/lib/ingestion/storage/storage.errors";
import { createSourceStorageAdapter } from "@/lib/ingestion/storage/storage.factory";
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";

export type SourceContentErrorCode =
  | "NOT_FOUND"
  | "INVALID_PATH"
  | "SNAPSHOT_NOT_READY"
  | "CONTENT_UNAVAILABLE"
  | "INTEGRITY_FAILURE";

export class SourceContentError extends Error {
  constructor(
    message: string,
    public readonly code: SourceContentErrorCode,
  ) {
    super(message);
    this.name = "SourceContentError";
  }
}

export interface SnapshotSummaryView {
  id: string;
  commitSha: string;
  commitMessage: string | null;
  status: string;
  completeness: string | null;
  totalFiles: number;
  eligibleFiles: number;
  storedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface SnapshotFileView {
  path: string;
  name: string;
  extension: string | null;
  category: string | null;
  status: string;
  sizeBytes: string | null;
  skipReason: string | null;
  failureCode: string | null;
}

const MAX_HISTORY = 50;

async function requireOwnedRepository(userId: string, repositoryId: string) {
  const repository = await prisma.repository.findFirst({
    where: { id: repositoryId, ownerId: userId },
    select: { id: true },
  });

  if (!repository) {
    throw new SourceContentError("Repository not found.", "NOT_FOUND");
  }
}

async function requireOwnedSnapshot(
  userId: string,
  repositoryId: string,
  snapshotId: string,
) {
  // Ownership is part of the query: another user's snapshot is
  // indistinguishable from a missing one.
  const snapshot = await prisma.repositorySnapshot.findFirst({
    where: {
      id: snapshotId,
      repositoryId,
      repository: { ownerId: userId },
    },
    select: { id: true, status: true },
  });

  if (!snapshot) {
    throw new SourceContentError("Snapshot not found.", "NOT_FOUND");
  }

  return snapshot;
}

/** Snapshot history for a repository owned by the user, newest first. */
export async function listRepositorySnapshots(
  userId: string,
  repositoryId: string,
  limit = 20,
): Promise<SnapshotSummaryView[]> {
  await requireOwnedRepository(userId, repositoryId);

  const snapshots = await prisma.repositorySnapshot.findMany({
    where: { repositoryId, repository: { ownerId: userId } },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(1, Math.floor(limit)), MAX_HISTORY),
  });

  return snapshots.map(toSnapshotSummaryView);
}

export function toSnapshotSummaryView(snapshot: {
  id: string;
  commitSha: string;
  commitMessage: string | null;
  status: string;
  completeness: string | null;
  totalFiles: number;
  eligibleFiles: number;
  storedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  totalBytes: bigint;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): SnapshotSummaryView {
  return {
    id: snapshot.id,
    commitSha: snapshot.commitSha,
    commitMessage: snapshot.commitMessage,
    status: snapshot.status,
    completeness: snapshot.completeness,
    totalFiles: snapshot.totalFiles,
    eligibleFiles: snapshot.eligibleFiles,
    storedFiles: snapshot.storedFiles,
    skippedFiles: snapshot.skippedFiles,
    failedFiles: snapshot.failedFiles,
    totalBytes: snapshot.totalBytes.toString(),
    startedAt: snapshot.startedAt?.toISOString() ?? null,
    completedAt: snapshot.completedAt?.toISOString() ?? null,
    createdAt: snapshot.createdAt.toISOString(),
  };
}

const FILE_STATUSES = ["STORED", "SKIPPED", "FAILED", "ELIGIBLE"] as const;
export type SnapshotFileStatusFilter = (typeof FILE_STATUSES)[number];

export function isSnapshotFileStatusFilter(
  value: string,
): value is SnapshotFileStatusFilter {
  return (FILE_STATUSES as readonly string[]).includes(value);
}

/** File metadata for an owned snapshot. Never returns storage keys. */
export async function listSnapshotFiles(
  userId: string,
  repositoryId: string,
  snapshotId: string,
  status?: SnapshotFileStatusFilter,
): Promise<SnapshotFileView[]> {
  await requireOwnedSnapshot(userId, repositoryId, snapshotId);

  const files = await prisma.snapshotFile.findMany({
    where: { snapshotId, ...(status ? { status } : {}) },
    orderBy: { path: "asc" },
    select: {
      path: true,
      name: true,
      extension: true,
      category: true,
      status: true,
      sizeBytes: true,
      skipReason: true,
      failureCode: true,
    },
  });

  return files.map((file) => ({
    ...file,
    sizeBytes: file.sizeBytes === null ? null : file.sizeBytes.toString(),
  }));
}

export interface SourceContentResult {
  path: string;
  sizeBytes: number;
  contentHash: string;
  content: Buffer;
}

/**
 * Owner-protected read of one stored source file.
 *
 * The path is validated, the snapshot must belong to the user and be
 * COMPLETED, and the file must be STORED. The storage adapter verifies the
 * SHA-256 hash on read, so tampered or missing objects are never returned.
 * The caller supplies only a repository path, never a storage key.
 */
export async function readSnapshotFileContent(
  input: {
    userId: string;
    repositoryId: string;
    snapshotId: string;
    path: string;
  },
  storage?: SourceStorage,
): Promise<SourceContentResult> {
  const validation = validateRepositoryPath(input.path);

  if (!validation.valid || !validation.normalizedPath) {
    throw new SourceContentError("Invalid file path.", "INVALID_PATH");
  }

  const snapshot = await requireOwnedSnapshot(
    input.userId,
    input.repositoryId,
    input.snapshotId,
  );

  if (snapshot.status !== "COMPLETED") {
    throw new SourceContentError(
      "Snapshot content is not available yet.",
      "SNAPSHOT_NOT_READY",
    );
  }

  const file = await prisma.snapshotFile.findUnique({
    where: {
      snapshotId_path: {
        snapshotId: snapshot.id,
        path: validation.normalizedPath,
      },
    },
    select: {
      path: true,
      status: true,
      storageKey: true,
      contentHash: true,
      sizeBytes: true,
    },
  });

  if (!file || file.status !== "STORED") {
    throw new SourceContentError("File not found.", "NOT_FOUND");
  }

  if (!file.storageKey || !file.contentHash) {
    throw new SourceContentError(
      "Stored file metadata is incomplete.",
      "CONTENT_UNAVAILABLE",
    );
  }

  const adapter = storage ?? createSourceStorageAdapter();

  try {
    const content = await adapter.get(file.storageKey, file.contentHash);

    return {
      path: file.path,
      sizeBytes: content.length,
      contentHash: file.contentHash,
      content,
    };
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === "INTEGRITY_CHECK_FAILED") {
        throw new SourceContentError(
          "Stored file failed its integrity check.",
          "INTEGRITY_FAILURE",
        );
      }

      throw new SourceContentError(
        "Stored file content is unavailable.",
        "CONTENT_UNAVAILABLE",
      );
    }

    throw new SourceContentError(
      "Stored file content is unavailable.",
      "CONTENT_UNAVAILABLE",
    );
  }
}
