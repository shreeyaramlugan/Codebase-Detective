// tests/unit/api/ingestion-routes.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  enqueue: vi.fn(),
  listSnapshots: vi.fn(),
  listFiles: vi.fn(),
  readContent: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireSession: mocks.requireSession,
}));

vi.mock("@/lib/jobs/job-enqueue", async () => {
  class EnqueueError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
    }
  }

  return { EnqueueError, enqueueIngestionJob: mocks.enqueue };
});

vi.mock("@/lib/ingestion/source-content/source-content.service", async () => {
  class SourceContentError extends Error {
    constructor(
      message: string,
      public readonly code: string,
    ) {
      super(message);
    }
  }

  return {
    SourceContentError,
    listRepositorySnapshots: mocks.listSnapshots,
    listSnapshotFiles: mocks.listFiles,
    readSnapshotFileContent: mocks.readContent,
    isSnapshotFileStatusFilter: (value: string) =>
      ["STORED", "SKIPPED", "FAILED", "ELIGIBLE"].includes(value),
  };
});

import { POST as ingestPost } from "../../../app/api/repositories/[repositoryId]/ingest/route";
import { GET as snapshotsGet } from "../../../app/api/repositories/[repositoryId]/snapshots/route";
import { GET as filesGet } from "../../../app/api/repositories/[repositoryId]/snapshots/[snapshotId]/files/route";
import { GET as contentGet } from "../../../app/api/repositories/[repositoryId]/snapshots/[snapshotId]/files/content/route";
import { GitHubApiError } from "../../../lib/github/github.errors";
import { EnqueueError } from "../../../lib/jobs/job-enqueue";
import { SourceContentError } from "../../../lib/ingestion/source-content/source-content.service";

const repoContext = { params: Promise.resolve({ repositoryId: "repo-1" }) };
const snapContext = {
  params: Promise.resolve({ repositoryId: "repo-1", snapshotId: "snap-1" }),
};

const base = "http://localhost/api/repositories/repo-1";

describe("ingestion API routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  describe("authentication", () => {
    beforeEach(() => {
      mocks.requireSession.mockRejectedValue(new Error("UNAUTHORIZED"));
    });

    it("rejects every endpoint without a session", async () => {
      const responses = await Promise.all([
        ingestPost(
          new Request(`${base}/ingest`, { method: "POST" }),
          repoContext,
        ),
        snapshotsGet(new Request(`${base}/snapshots`), repoContext),
        filesGet(new Request(`${base}/snapshots/snap-1/files`), snapContext),
        contentGet(
          new Request(`${base}/snapshots/snap-1/files/content?path=a.ts`),
          snapContext,
        ),
      ]);

      expect(responses.map((response) => response.status)).toEqual([
        401, 401, 401, 401,
      ]);
      expect(mocks.enqueue).not.toHaveBeenCalled();
      expect(mocks.readContent).not.toHaveBeenCalled();
    });
  });

  describe("POST ingest", () => {
    it("queues ingestion for the signed-in owner", async () => {
      mocks.enqueue.mockResolvedValue({
        id: "job-2",
        status: "PENDING",
        targetCommitSha: "a".repeat(40),
        attempts: 0,
        maxAttempts: 3,
      });

      const response = await ingestPost(
        new Request(`${base}/ingest`, { method: "POST" }),
        repoContext,
      );

      expect(response.status).toBe(202);
      expect(mocks.enqueue).toHaveBeenCalledWith({
        repositoryId: "repo-1",
        ownerId: "user-1",
      });
      expect((await response.json()).job.id).toBe("job-2");
    });

    it("returns 404 for another user's repository", async () => {
      mocks.enqueue.mockRejectedValue(
        new EnqueueError("Repository not found.", "REPOSITORY_NOT_FOUND"),
      );

      const response = await ingestPost(
        new Request(`${base}/ingest`, { method: "POST" }),
        repoContext,
      );

      expect(response.status).toBe(404);
    });

    it("returns 409 when ingestion is already active", async () => {
      mocks.enqueue.mockRejectedValue(
        new EnqueueError("busy", "JOB_ALREADY_ACTIVE"),
      );

      const response = await ingestPost(
        new Request(`${base}/ingest`, { method: "POST" }),
        repoContext,
      );

      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe("JOB_ALREADY_ACTIVE");
    });

    it("returns 429 when GitHub rate limits the commit lookup", async () => {
      mocks.enqueue.mockRejectedValue(
        new GitHubApiError("limit", "RATE_LIMITED", 403, true, 60),
      );

      const response = await ingestPost(
        new Request(`${base}/ingest`, { method: "POST" }),
        repoContext,
      );

      expect(response.status).toBe(429);
    });

    it("hides internal errors", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      mocks.enqueue.mockRejectedValue(new Error("password=hunter2"));

      const response = await ingestPost(
        new Request(`${base}/ingest`, { method: "POST" }),
        repoContext,
      );
      const body = JSON.stringify(await response.json());

      expect(response.status).toBe(500);
      expect(body).not.toContain("hunter2");

      spy.mockRestore();
    });
  });

  describe("GET snapshots and files", () => {
    it("returns snapshot history without caching", async () => {
      mocks.listSnapshots.mockResolvedValue([{ id: "snap-1" }]);

      const response = await snapshotsGet(
        new Request(`${base}/snapshots`),
        repoContext,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(mocks.listSnapshots).toHaveBeenCalledWith("user-1", "repo-1");
    });

    it("returns 404 for a repository the user does not own", async () => {
      mocks.listSnapshots.mockRejectedValue(
        new SourceContentError("Repository not found.", "NOT_FOUND"),
      );

      const response = await snapshotsGet(
        new Request(`${base}/snapshots`),
        repoContext,
      );

      expect(response.status).toBe(404);
    });

    it("passes a valid status filter and rejects an invalid one", async () => {
      mocks.listFiles.mockResolvedValue([]);

      const ok = await filesGet(
        new Request(`${base}/snapshots/snap-1/files?status=FAILED`),
        snapContext,
      );

      expect(ok.status).toBe(200);
      expect(mocks.listFiles).toHaveBeenCalledWith(
        "user-1",
        "repo-1",
        "snap-1",
        "FAILED",
      );

      const bad = await filesGet(
        new Request(`${base}/snapshots/snap-1/files?status=DROP`),
        snapContext,
      );

      expect(bad.status).toBe(400);
    });
  });

  describe("GET file content", () => {
    const contentUrl = (path: string) =>
      `${base}/snapshots/snap-1/files/content?path=${encodeURIComponent(path)}`;

    it("serves content as inert, uncached plain text", async () => {
      mocks.readContent.mockResolvedValue({
        path: "src/index.ts",
        sizeBytes: 5,
        contentHash: "f".repeat(64),
        content: Buffer.from("hello"),
      });

      const response = await contentGet(
        new Request(contentUrl("src/index.ts")),
        snapContext,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("hello");
      expect(response.headers.get("Content-Type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "sandbox",
      );
      expect(mocks.readContent).toHaveBeenCalledWith({
        userId: "user-1",
        repositoryId: "repo-1",
        snapshotId: "snap-1",
        path: "src/index.ts",
      });
    });

    it("requires a path", async () => {
      const response = await contentGet(
        new Request(`${base}/snapshots/snap-1/files/content`),
        snapContext,
      );

      expect(response.status).toBe(400);
      expect(mocks.readContent).not.toHaveBeenCalled();
    });

    it.each([
      ["NOT_FOUND", 404],
      ["INVALID_PATH", 400],
      ["SNAPSHOT_NOT_READY", 409],
      ["CONTENT_UNAVAILABLE", 410],
      ["INTEGRITY_FAILURE", 500],
    ])("maps %s to HTTP %i", async (code, status) => {
      mocks.readContent.mockRejectedValue(
        new SourceContentError("x", code as never),
      );

      const response = await contentGet(
        new Request(contentUrl("../../etc/passwd")),
        snapContext,
      );

      expect(response.status).toBe(status);
      expect((await response.json()).code).toBe(code);
    });
  });
});
