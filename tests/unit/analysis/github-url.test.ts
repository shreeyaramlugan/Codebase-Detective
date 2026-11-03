import { describe, expect, it } from "vitest";

import {
  GitHubUrlError,
  parseGitHubRepositoryUrl,
} from "../../../lib/github/github-url";

describe("parseGitHubRepositoryUrl", () => {
  it("parses a valid repository URL", () => {
    const result = parseGitHubRepositoryUrl(
      "https://github.com/facebook/react",
    );

    expect(result).toEqual({
      owner: "facebook",
      name: "react",
      fullName: "facebook/react",
      canonicalUrl: "https://github.com/facebook/react",
    });
  });

  it("normalises trailing slashes", () => {
    const result = parseGitHubRepositoryUrl(
      "https://github.com/facebook/react/",
    );

    expect(result.canonicalUrl).toBe("https://github.com/facebook/react");
  });

  it("removes the .git suffix", () => {
    const result = parseGitHubRepositoryUrl(
      "https://github.com/facebook/react.git",
    );

    expect(result.name).toBe("react");
  });

  it("accepts branch URLs", () => {
    const result = parseGitHubRepositoryUrl(
      "https://github.com/facebook/react/tree/main",
    );

    expect(result.fullName).toBe("facebook/react");
  });

  it("accepts branch names containing slashes", () => {
    const result = parseGitHubRepositoryUrl(
      "https://github.com/facebook/react/tree/feature/new-ui",
    );

    expect(result.fullName).toBe("facebook/react");
  });

  it.each([
    "",
    "not-a-url",
    "http://github.com/facebook/react",
    "https://gitlab.com/facebook/react",
    "https://github.com/facebook",
    "https://github.com/facebook/react/issues",
    "https://github.com/facebook/react/tree",
    "https://github.com.evil.com/facebook/react",
    "https://user:password@github.com/facebook/react",
    "https://github.com:8080/facebook/react",
    "https://github.com/facebook/react?tab=readme",
  ])("rejects invalid URL: %s", (url) => {
    expect(() => parseGitHubRepositoryUrl(url)).toThrow(GitHubUrlError);
  });

  it("rejects invalid owner names", () => {
    expect(() =>
      parseGitHubRepositoryUrl("https://github.com/-invalid/repository"),
    ).toThrow("owner is invalid");
  });

  it("rejects invalid repository names", () => {
    expect(() =>
      parseGitHubRepositoryUrl("https://github.com/facebook/../"),
    ).toThrow();
  });
});
