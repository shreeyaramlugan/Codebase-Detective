import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchGitHubRepositoryMetadata,
  getGitHubBlob,
  getGitHubRepositoryTree,
} from "../../../lib/github/github.client";
import { GitHubApiError } from "../../../lib/github/github.errors";
import { createHash } from "node:crypto";
const mockRepository = {
  id: 10270250,
  name: "react",
  full_name: "facebook/react",
  html_url: "https://github.com/facebook/react",
  description: "The library for web and native user interfaces.",
  default_branch: "main",
  private: false,
  visibility: "public",
  language: "JavaScript",
  stargazers_count: 100,
  forks_count: 20,
  owner: {
    login: "facebook",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchGitHubRepositoryMetadata", () => {
  it("retrieves public repository metadata and latest commit", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockRepository), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ sha: "a".repeat(40) }]), {
          status: 200,
        }),
      );

    const result = await fetchGitHubRepositoryMetadata("facebook", "react");

    expect(result).toEqual({
      githubId: BigInt(10270250),
      owner: "facebook",
      name: "react",
      fullName: "facebook/react",
      htmlUrl: "https://github.com/facebook/react",
      description: "The library for web and native user interfaces.",
      defaultBranch: "main",
      isPublic: true,
      language: "JavaScript",
      stars: 100,
      forks: 20,
      lastCommitSha: "a".repeat(40),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects private repositories", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...mockRepository,
          private: true,
          visibility: "private",
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchGitHubRepositoryMetadata("owner", "private-repo"),
    ).rejects.toMatchObject({
      code: "NOT_PUBLIC",
    });
  });

  it("rejects repositories that GitHub cannot find", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    await expect(
      fetchGitHubRepositoryMetadata("owner", "missing"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("handles rate limits", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Rate limit exceeded", {
        status: 403,
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60),
        },
      }),
    );

    await expect(
      fetchGitHubRepositoryMetadata("owner", "repo"),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
    });
  });

  it("handles GitHub server errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Server error", { status: 503 }),
    );

    await expect(
      fetchGitHubRepositoryMetadata("owner", "repo"),
    ).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      retryable: true,
    });
  });

  it("supports repositories without commits", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockRepository), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response("Empty repository", {
          status: 409,
        }),
      );

    const result = await fetchGitHubRepositoryMetadata("facebook", "react");

    expect(result.lastCommitSha).toBeNull();
  });
});
const TEST_COMMIT_SHA = "a".repeat(40);
const TEST_ROOT_TREE_SHA = "b".repeat(40);
const TEST_SOURCE_TREE_SHA = "c".repeat(40);

function mockCommitResponse() {
  return {
    sha: TEST_COMMIT_SHA,
    commit: {
      message: "Test repository commit",
      author: {
        name: "Test Author",
        date: "2026-11-03T10:00:00Z",
      },
      tree: {
        sha: TEST_ROOT_TREE_SHA,
      },
    },
  };
}

function mockTreeResponse(
  sha: string,
  tree: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
    size?: number;
  }>,
  truncated = false,
) {
  return {
    sha,
    tree,
    truncated,
  };
}

describe("getGitHubRepositoryTree", () => {
  it("retrieves a complete recursive repository tree", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockCommitResponse()), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(TEST_ROOT_TREE_SHA, [
              {
                path: "src/index.ts",
                mode: "100644",
                type: "blob",
                sha: "d".repeat(40),
                size: 120,
              },
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: "e".repeat(40),
                size: 80,
              },
            ]),
          ),
          { status: 200 },
        ),
      );

    const result = await getGitHubRepositoryTree("owner", "repo", "main");

    expect(result.commitSha).toBe(TEST_COMMIT_SHA);
    expect(result.rootTreeSha).toBe(TEST_ROOT_TREE_SHA);
    expect(result.recoveredFromTruncation).toBe(false);

    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.path)).toEqual([
      "src/index.ts",
      "README.md",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      `${TEST_ROOT_TREE_SHA}?recursive=1`,
    );
  });

  it("recovers a truncated recursive tree using individual subtrees", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockCommitResponse()), {
          status: 200,
        }),
      )
      // Initial recursive request is truncated.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(
              TEST_ROOT_TREE_SHA,
              [
                {
                  path: "src/index.ts",
                  mode: "100644",
                  type: "blob",
                  sha: "d".repeat(40),
                  size: 120,
                },
              ],
              true,
            ),
          ),
          { status: 200 },
        ),
      )
      // Root tree retrieved without recursion.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(TEST_ROOT_TREE_SHA, [
              {
                path: "src",
                mode: "040000",
                type: "tree",
                sha: TEST_SOURCE_TREE_SHA,
              },
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: "e".repeat(40),
                size: 80,
              },
            ]),
          ),
          { status: 200 },
        ),
      )
      // Nested src tree retrieved separately.
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(TEST_SOURCE_TREE_SHA, [
              {
                path: "index.ts",
                mode: "100644",
                type: "blob",
                sha: "d".repeat(40),
                size: 120,
              },
            ]),
          ),
          { status: 200 },
        ),
      );

    const result = await getGitHubRepositoryTree("owner", "repo", "main");

    expect(result.recoveredFromTruncation).toBe(true);

    expect(result.entries.map((entry) => entry.path).sort()).toEqual([
      "README.md",
      "src",
      "src/index.ts",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("fails safely when a subtree is also truncated", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockCommitResponse()), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(mockTreeResponse(TEST_ROOT_TREE_SHA, [], true)),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(TEST_ROOT_TREE_SHA, [
              {
                path: "src",
                mode: "040000",
                type: "tree",
                sha: TEST_SOURCE_TREE_SHA,
              },
            ]),
          ),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(mockTreeResponse(TEST_SOURCE_TREE_SHA, [], true)),
          { status: 200 },
        ),
      );

    await expect(
      getGitHubRepositoryTree("owner", "repo", "main"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("rejects duplicate paths in a recursive tree", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockCommitResponse()), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(TEST_ROOT_TREE_SHA, [
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: "d".repeat(40),
              },
              {
                path: "README.md",
                mode: "100644",
                type: "blob",
                sha: "e".repeat(40),
              },
            ]),
          ),
          { status: 200 },
        ),
      );

    await expect(
      getGitHubRepositoryTree("owner", "repo", "main"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects unsafe paths returned by GitHub", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockCommitResponse()), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            mockTreeResponse(TEST_ROOT_TREE_SHA, [
              {
                path: "../outside.txt",
                mode: "100644",
                type: "blob",
                sha: "d".repeat(40),
              },
            ]),
          ),
          { status: 200 },
        ),
      );

    await expect(
      getGitHubRepositoryTree("owner", "repo", "main"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
function createGitBlob(content: Buffer) {
  const header = Buffer.from(`blob ${content.byteLength}\0`);

  const sha = createHash("sha1")
    .update(Buffer.concat([header, content]))
    .digest("hex");

  return {
    sha,
    size: content.byteLength,
    content: content.toString("base64"),
    encoding: "base64" as const,
  };
}

describe("getGitHubBlob", () => {
  it("retrieves and verifies a valid GitHub blob", async () => {
    const content = Buffer.from("console.log('Hello World');");
    const blob = createGitBlob(content);

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(blob), { status: 200 }),
      );

    const result = await getGitHubBlob("owner", "repo", blob.sha);

    expect(result.sha).toBe(blob.sha);
    expect(result.sizeBytes).toBe(content.byteLength);
    expect(result.content.equals(content)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      `/git/blobs/${blob.sha}`,
    );
  });

  it("supports empty blobs", async () => {
    const content = Buffer.alloc(0);
    const blob = createGitBlob(content);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(blob), { status: 200 }),
    );

    const result = await getGitHubBlob("owner", "repo", blob.sha);

    expect(result.content.byteLength).toBe(0);
    expect(result.sha).toBe(blob.sha);
  });

  it("supports Unicode content", async () => {
    const content = Buffer.from("Hello 🌍 café");
    const blob = createGitBlob(content);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(blob), { status: 200 }),
    );

    const result = await getGitHubBlob("owner", "repo", blob.sha);

    expect(result.content.toString("utf8")).toBe("Hello 🌍 café");
  });

  it("rejects an invalid requested SHA before making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      getGitHubBlob("owner", "repo", "invalid-sha"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      status: 400,
      retryable: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a response containing a different blob SHA", async () => {
    const content = Buffer.from("test");
    const blob = createGitBlob(content);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...blob,
          sha: "f".repeat(40),
        }),
        { status: 200 },
      ),
    );

    await expect(
      getGitHubBlob("owner", "repo", blob.sha),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("rejects malformed Base64 content", async () => {
    const content = Buffer.from("test");
    const blob = createGitBlob(content);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...blob,
          content: "invalid@@@",
        }),
        { status: 200 },
      ),
    );

    await expect(
      getGitHubBlob("owner", "repo", blob.sha),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects a reported size that differs from the decoded content", async () => {
    const content = Buffer.from("test");
    const blob = createGitBlob(content);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...blob,
          size: 100,
        }),
        { status: 200 },
      ),
    );

    await expect(
      getGitHubBlob("owner", "repo", blob.sha),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });

  it("rejects content that fails Git SHA verification", async () => {
    const original = createGitBlob(Buffer.from("original"));
    const different = Buffer.from("tampered");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...original,
          size: different.byteLength,
          content: different.toString("base64"),
        }),
        { status: 200 },
      ),
    );

    await expect(
      getGitHubBlob("owner", "repo", original.sha),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
    });
  });

  it("rejects unsupported blob encodings", async () => {
    const content = Buffer.from("test");
    const blob = createGitBlob(content);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...blob,
          encoding: "utf-8",
        }),
        { status: 200 },
      ),
    );

    await expect(
      getGitHubBlob("owner", "repo", blob.sha),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
  });
});
