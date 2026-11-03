import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGitHubRepositoryMetadata } from "../../../lib/github/github.client";

import { GitHubApiError } from "../../../lib/github/github.errors";

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
