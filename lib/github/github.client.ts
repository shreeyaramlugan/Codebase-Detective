import { GitHubApiError } from "./github.errors";
import type { GitHubRepositoryMetadata } from "./github.type";

const GITHUB_API = "https://api.github.com";

const API_VERSION = "2022-11-28";

const REQUEST_TIMEOUT_MS = 10_000;

interface GitHubApiRepository {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string | null;
  private: boolean;
  visibility: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  owner: {
    login: string;
  };
}

interface GitHubApiCommit {
  sha: string;
}

async function githubFetch<T>(path: string): Promise<T> {
  let response: Response;

  try {
    response = await fetch(`${GITHUB_API}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "Codebase-Detective",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TimeoutError"
    ) {
      throw new GitHubApiError(
        "GitHub took too long to respond. Please try again.",
        "TIMEOUT",
        undefined,
        true,
      );
    }

    throw new GitHubApiError(
      "Unable to connect to GitHub. Please try again.",
      "NETWORK_ERROR",
      undefined,
      true,
    );
  }

  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const retryAfter = response.headers.get("retry-after");

    if (
      response.status === 403 &&
      (remaining === "0" || retryAfter !== null)
    ) {
      let retryAfterSeconds: number | undefined;

      if (retryAfter) {
        const parsed = Number(retryAfter);

        if (Number.isFinite(parsed) && parsed >= 0) {
          retryAfterSeconds = parsed;
        }
      } else if (reset) {
        const resetTime = Number(reset);

        if (Number.isFinite(resetTime)) {
          retryAfterSeconds = Math.max(
            0,
            resetTime - Math.floor(Date.now() / 1000),
          );
        }
      }

      throw new GitHubApiError(
        "GitHub API rate limit reached. Please try again later.",
        "RATE_LIMITED",
        response.status,
        true,
        retryAfterSeconds,
      );
    }

    if (response.status === 404) {
      throw new GitHubApiError(
        "Repository not found or not publicly accessible.",
        "NOT_FOUND",
        404,
        false,
      );
    }

    if (response.status === 403) {
      throw new GitHubApiError(
        "GitHub denied this request.",
        "FORBIDDEN",
        403,
        false,
      );
    }

    if (response.status === 429) {
      throw new GitHubApiError(
        "GitHub API rate limit reached. Please try again later.",
        "RATE_LIMITED",
        429,
        true,
      );
    }

    if (response.status >= 500) {
      throw new GitHubApiError(
        "GitHub is temporarily unavailable.",
        "UPSTREAM_ERROR",
        response.status,
        true,
      );
    }

    throw new GitHubApiError(
      "GitHub rejected the repository request.",
      "INVALID_RESPONSE",
      response.status,
      false,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubApiError(
      "GitHub returned an invalid response.",
      "INVALID_RESPONSE",
      response.status,
      true,
    );
  }
}

export async function getGitHubRepository(
  owner: string,
  name: string,
): Promise<GitHubApiRepository> {
  const repository = await githubFetch<GitHubApiRepository>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );

  if (
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    typeof repository.owner?.login !== "string" ||
    typeof repository.name !== "string" ||
    typeof repository.full_name !== "string" ||
    typeof repository.html_url !== "string" ||
    typeof repository.private !== "boolean"
  ) {
    throw new GitHubApiError(
      "GitHub returned incomplete repository metadata.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  return repository;
}

export async function getLatestCommitSha(
  owner: string,
  name: string,
  branch: string,
): Promise<string | null> {
  try {
    const commits = await githubFetch<GitHubApiCommit[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    );

    if (!Array.isArray(commits)) {
      throw new GitHubApiError(
        "GitHub returned an invalid commit response.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    if (commits.length === 0) {
      return null;
    }

    const sha = commits[0]?.sha;

    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
      throw new GitHubApiError(
        "GitHub returned an invalid commit identifier.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    return sha;
  } catch (error) {
    // GitHub returns 409 when a repository has no commits.
    if (
      error instanceof GitHubApiError &&
      error.status === 409
    ) {
      return null;
    }

    throw error;
  }
}

export async function fetchGitHubRepositoryMetadata(
  owner: string,
  name: string,
): Promise<GitHubRepositoryMetadata> {
  const repository = await getGitHubRepository(owner, name);

  const isPublic =
    repository.private === false &&
    repository.visibility === "public";

  if (!isPublic) {
    throw new GitHubApiError(
      "Only public GitHub repositories are supported.",
      "NOT_PUBLIC",
      403,
      false,
    );
  }

  const lastCommitSha = repository.default_branch
    ? await getLatestCommitSha(
        repository.owner.login,
        repository.name,
        repository.default_branch,
      )
    : null;

  return {
    githubId: BigInt(repository.id),
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    htmlUrl: repository.html_url,
    description: repository.description,
    defaultBranch: repository.default_branch,
    isPublic,
    language: repository.language,
    stars: repository.stargazers_count,
    forks: repository.forks_count,
    lastCommitSha,
  };
}