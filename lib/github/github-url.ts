import type { ParsedGitHubRepository } from "./github.type";

export class GitHubUrlError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "GitHubUrlError";
  }
}

const OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

const REPOSITORY_REGEX = /^[a-zA-Z0-9._-]+$/;

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new GitHubUrlError(
      "The repository URL contains invalid encoding.",
      "INVALID_URL_ENCODING",
    );
  }
}

export function parseGitHubRepositoryUrl(
  input: string,
): ParsedGitHubRepository {
  if (!input || typeof input !== "string" || !input.trim()) {
    throw new GitHubUrlError(
      "Please enter a GitHub repository URL.",
      "EMPTY_URL",
    );
  }

  const trimmedInput = input.trim();

  let url: URL;

  try {
    url = new URL(trimmedInput);
  } catch {
    throw new GitHubUrlError(
      "Please enter a valid URL.",
      "INVALID_URL",
    );
  }

  // Only accept HTTPS GitHub URLs.
  if (url.protocol !== "https:") {
    throw new GitHubUrlError(
      "Repository URLs must use HTTPS.",
      "INVALID_PROTOCOL",
    );
  }

  // Reject credentials, custom ports and alternative hostnames.
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new GitHubUrlError(
      "Please provide a URL from github.com.",
      "INVALID_GITHUB_DOMAIN",
    );
  }

  if (url.search || url.hash) {
    throw new GitHubUrlError(
      "Remove query parameters and fragments from the repository URL.",
      "UNSUPPORTED_URL_PARAMETERS",
    );
  }

  const segments = url.pathname
    .split("/")
    .filter(Boolean);

  if (segments.length < 2) {
    throw new GitHubUrlError(
      "The URL must include a repository owner and repository name.",
      "INVALID_REPOSITORY_PATH",
    );
  }

  const owner = decodePathSegment(segments[0]);
  let repositoryName = decodePathSegment(segments[1]);

  if (!OWNER_REGEX.test(owner)) {
    throw new GitHubUrlError(
      "The GitHub repository owner is invalid.",
      "INVALID_OWNER",
    );
  }

  // Remove an optional .git suffix.
  if (repositoryName.toLowerCase().endsWith(".git")) {
    repositoryName = repositoryName.slice(0, -4);
  }

  if (
    !REPOSITORY_REGEX.test(repositoryName) ||
    repositoryName === "." ||
    repositoryName === ".." ||
    repositoryName.startsWith(".") ||
    repositoryName.endsWith(".")
  ) {
    throw new GitHubUrlError(
      "The GitHub repository name is invalid.",
      "INVALID_REPOSITORY_NAME",
    );
  }

  // Accept repository root URLs and supported branch/tree URLs.
  if (segments.length > 2 && segments[2] !== "tree") {
    throw new GitHubUrlError(
      "Only repository URLs and branch/tree URLs are supported.",
      "UNSUPPORTED_GITHUB_PATH",
    );
  }

  if (segments[2] === "tree" && segments.length < 4) {
    throw new GitHubUrlError(
      "The branch name is missing from the repository URL.",
      "MISSING_BRANCH",
    );
  }

  const fullName = `${owner}/${repositoryName}`;

  return {
    owner,
    name: repositoryName,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
  };
}