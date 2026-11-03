import { afterEach, describe, expect, it, vi } from "vitest";

import { validateGitHubRepository } from "../../../lib/github/github.repository";

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

describe("validateGitHubRepository", () => {
  it("validates a URL and retrieves repository metadata", async () => {
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

    const result = await validateGitHubRepository(
      "https://github.com/facebook/react",
    );

    expect(result.parsed).toEqual({
      owner: "facebook",
      name: "react",
      fullName: "facebook/react",
      canonicalUrl: "https://github.com/facebook/react",
    });

    expect(result.metadata.fullName).toBe("facebook/react");
    expect(result.metadata.isPublic).toBe(true);
    expect(result.metadata.lastCommitSha).toBe("a".repeat(40));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("normalises the submitted repository URL", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(mockRepository), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ sha: "b".repeat(40) }]), {
          status: 200,
        }),
      );

    const result = await validateGitHubRepository(
      "https://github.com/facebook/react/tree/main",
    );

    expect(result.parsed.canonicalUrl).toBe(
      "https://github.com/facebook/react",
    );
  });

  it("rejects invalid URLs before making API requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(
      validateGitHubRepository("https://gitlab.com/owner/repo"),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates GitHub repository errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 }),
    );

    await expect(
      validateGitHubRepository("https://github.com/owner/missing-repo"),
    ).rejects.toBeInstanceOf(GitHubApiError);
  });
});
