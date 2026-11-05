import { GitHubApiError } from "./github.errors";
import type {
  GitHubBlob,
  GitHubBlobContent,
  GitHubCommitReference,
  GitHubRepositoryMetadata,
  GitHubRepositoryTree,
  GitHubTreeEntry,
} from "./github.type";
import { createHash } from "node:crypto";

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
    if (error instanceof Error && error.name === "TimeoutError") {
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

    if (response.status === 403 && (remaining === "0" || retryAfter !== null)) {
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
    if (error instanceof GitHubApiError && error.status === 409) {
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
    repository.private === false && repository.visibility === "public";

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
interface GitHubApiCommitDetails {
  sha: string;
  commit: {
    message: string;
    author: {
      name: string | null;
      date: string | null;
    } | null;
    tree: {
      sha: string;
    };
  };
}

interface GitHubApiTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubApiTree {
  sha: string;
  tree: GitHubApiTreeEntry[];
  truncated: boolean;
}

const SHA_REGEX = /^[a-f0-9]{40}$/i;

const MAX_TREE_REQUESTS = 10_000;
const MAX_TREE_ENTRIES = 100_000;

function isValidSha(value: unknown): value is string {
  return typeof value === "string" && SHA_REGEX.test(value);
}

function validateTreeEntry(entry: GitHubApiTreeEntry): GitHubTreeEntry {
  if (
    typeof entry.path !== "string" ||
    entry.path.length === 0 ||
    entry.path.startsWith("/") ||
    entry.path
      .split("/")
      .some((segment) => segment === "." || segment === "..") ||
    typeof entry.mode !== "string" ||
    !["blob", "tree", "commit"].includes(entry.type) ||
    !isValidSha(entry.sha) ||
    (entry.size !== undefined &&
      (!Number.isSafeInteger(entry.size) || entry.size < 0))
  ) {
    throw new GitHubApiError(
      "GitHub returned an invalid repository tree entry.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  return {
    path: entry.path,
    mode: entry.mode,
    type: entry.type as GitHubTreeEntry["type"],
    sha: entry.sha,
    ...(entry.size !== undefined ? { size: entry.size } : {}),
  };
}

function validateTreeResponse(
  response: GitHubApiTree,
  expectedSha: string,
): GitHubTreeEntry[] {
  if (
    !response ||
    !isValidSha(response.sha) ||
    response.sha.toLowerCase() !== expectedSha.toLowerCase() ||
    !Array.isArray(response.tree) ||
    typeof response.truncated !== "boolean"
  ) {
    throw new GitHubApiError(
      "GitHub returned an invalid repository tree response.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  return response.tree.map((entry) => validateTreeEntry(entry));
}

/**
 * Resolves a branch, tag or commit reference to an immutable commit.
 * All subsequent source retrieval must use the returned SHA values,
 * never the original branch name.
 */
export async function resolveGitHubCommit(
  owner: string,
  name: string,
  revision: string,
): Promise<GitHubCommitReference> {
  if (!revision.trim()) {
    throw new GitHubApiError(
      "A GitHub branch, tag or commit reference is required.",
      "INVALID_RESPONSE",
      400,
      false,
    );
  }

  const commit = await githubFetch<GitHubApiCommitDetails>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(revision)}`,
  );

  if (
    !commit ||
    !isValidSha(commit.sha) ||
    !commit.commit ||
    !commit.commit.tree ||
    !isValidSha(commit.commit.tree.sha) ||
    typeof commit.commit.message !== "string"
  ) {
    throw new GitHubApiError(
      "GitHub returned incomplete commit information.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  return {
    sha: commit.sha,
    treeSha: commit.commit.tree.sha,
    message: commit.commit.message,
    authorName:
      typeof commit.commit.author?.name === "string"
        ? commit.commit.author.name
        : null,
    committedAt:
      typeof commit.commit.author?.date === "string"
        ? commit.commit.author.date
        : null,
  };
}

/**
 * Retrieves a Git tree by its immutable SHA.
 *
 * recursive=false is used during recovery so that each subtree
 * can be retrieved independently.
 */
export async function getGitHubTree(
  owner: string,
  name: string,
  treeSha: string,
  recursive = false,
): Promise<{
  sha: string;
  entries: GitHubTreeEntry[];
  truncated: boolean;
}> {
  if (!isValidSha(treeSha)) {
    throw new GitHubApiError(
      "A valid Git tree SHA is required.",
      "INVALID_RESPONSE",
      400,
      false,
    );
  }

  const query = recursive ? "?recursive=1" : "";

  const response = await githubFetch<GitHubApiTree>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(treeSha)}${query}`,
  );

  const entries = validateTreeResponse(response, treeSha);

  return {
    sha: response.sha,
    entries,
    truncated: response.truncated,
  };
}

/**
 * Retrieves a complete repository inventory.
 *
 * First attempts GitHub's recursive tree endpoint.
 * If GitHub truncates the result, it walks each subtree individually.
 *
 * If a complete inventory cannot be established within safety limits,
 * this function throws instead of returning an incomplete inventory.
 */
/**
 * Retrieves a complete repository tree for an already-resolved commit.
 *
 * The supplied commit is immutable. This prevents branch movement
 * between commit resolution and tree retrieval from mixing revisions.
 *
 * If GitHub truncates the recursive tree, the function walks each
 * subtree individually and enforces the configured safety limits.
 */
export async function getGitHubRepositoryTreeForCommit(
  owner: string,
  name: string,
  commit: GitHubCommitReference,
): Promise<GitHubRepositoryTree> {
  if (
    !owner.trim() ||
    !name.trim() ||
    !isValidSha(commit.sha) ||
    !isValidSha(commit.treeSha)
  ) {
    throw new GitHubApiError(
      "Valid repository details and resolved commit metadata are required.",
      "INVALID_RESPONSE",
      400,
      false,
    );
  }

  const recursiveTree = await getGitHubTree(owner, name, commit.treeSha, true);

  if (!recursiveTree.truncated) {
    if (recursiveTree.entries.length > MAX_TREE_ENTRIES) {
      throw new GitHubApiError(
        "The repository tree exceeds the supported inventory limit.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    assertUniqueTreePaths(recursiveTree.entries);

    return {
      commitSha: commit.sha,
      rootTreeSha: commit.treeSha,
      entries: recursiveTree.entries,
      recoveredFromTruncation: false,
    };
  }

  let requestCount = 0;
  const entries: GitHubTreeEntry[] = [];
  const paths = new Set<string>();

  async function walkTree(
    currentTreeSha: string,
    prefix: string,
    ancestors: Set<string>,
  ): Promise<void> {
    requestCount++;

    if (requestCount > MAX_TREE_REQUESTS) {
      throw new GitHubApiError(
        "Repository tree recovery exceeded the request safety limit.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    const normalizedSha = currentTreeSha.toLowerCase();

    if (ancestors.has(normalizedSha)) {
      throw new GitHubApiError(
        "GitHub returned a cyclic repository tree.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    const tree = await getGitHubTree(owner, name, currentTreeSha, false);

    if (tree.truncated) {
      throw new GitHubApiError(
        "GitHub returned a truncated subtree. A complete inventory could not be established.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(normalizedSha);

    for (const entry of tree.entries) {
      const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;

      if (paths.has(fullPath)) {
        throw new GitHubApiError(
          "GitHub returned duplicate paths in the repository tree.",
          "INVALID_RESPONSE",
          200,
          false,
        );
      }

      paths.add(fullPath);

      entries.push({
        ...entry,
        path: fullPath,
      });

      if (entries.length > MAX_TREE_ENTRIES) {
        throw new GitHubApiError(
          "The repository tree exceeds the supported inventory limit.",
          "INVALID_RESPONSE",
          200,
          false,
        );
      }

      if (entry.type === "tree") {
        await walkTree(entry.sha, fullPath, nextAncestors);
      }
    }
  }

  await walkTree(commit.treeSha, "", new Set<string>());

  return {
    commitSha: commit.sha,
    rootTreeSha: commit.treeSha,
    entries,
    recoveredFromTruncation: true,
  };
}

/**
 * Resolves a branch, tag or commit reference and retrieves its tree.
 *
 * This wrapper preserves the existing public API.
 */
export async function getGitHubRepositoryTree(
  owner: string,
  name: string,
  revision: string,
): Promise<GitHubRepositoryTree> {
  const commit = await resolveGitHubCommit(owner, name, revision);

  return getGitHubRepositoryTreeForCommit(owner, name, commit);
}

function assertUniqueTreePaths(entries: GitHubTreeEntry[]): void {
  const paths = new Set<string>();

  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new GitHubApiError(
        "GitHub returned duplicate paths in the repository tree.",
        "INVALID_RESPONSE",
        200,
        false,
      );
    }

    paths.add(entry.path);
  }
}
/**
 * Retrieves and verifies a GitHub blob using its immutable SHA.
 *
 * Validates:
 * - Requested and returned Git blob SHA
 * - Base64 encoding
 * - Decoded content size
 * - Git's SHA-1 blob object hash
 *
 * Returns the verified file contents as a Buffer.
 */
export async function getGitHubBlob(
  owner: string,
  name: string,
  blobSha: string,
): Promise<GitHubBlobContent> {
  if (!isValidSha(blobSha)) {
    throw new GitHubApiError(
      "A valid Git blob SHA is required.",
      "INVALID_RESPONSE",
      400,
      false,
    );
  }

  const blob = await githubFetch<GitHubBlob>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/blobs/${encodeURIComponent(blobSha)}`,
  );

  if (
    !blob ||
    !isValidSha(blob.sha) ||
    blob.sha.toLowerCase() !== blobSha.toLowerCase() ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 0 ||
    typeof blob.content !== "string" ||
    blob.encoding !== "base64"
  ) {
    throw new GitHubApiError(
      "GitHub returned invalid blob metadata.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  // GitHub may include line breaks in Base64 content.
  const normalizedBase64 = blob.content.replace(/\s/g, "");

  // Reject invalid Base64 characters and malformed padding.
  const validBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

  if (!validBase64.test(normalizedBase64)) {
    throw new GitHubApiError(
      "GitHub returned invalid Base64 blob content.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  const content = Buffer.from(normalizedBase64, "base64");

  // Ensure decoding was canonical and lossless.
  if (content.toString("base64") !== normalizedBase64) {
    throw new GitHubApiError(
      "GitHub returned malformed Base64 blob content.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  if (content.byteLength !== blob.size) {
    throw new GitHubApiError(
      "GitHub blob content size does not match its reported size.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  // Git hashes the complete blob object, not just its raw content.
  const gitObjectHeader = Buffer.from(`blob ${content.byteLength}\0`);

  const calculatedGitSha = createHash("sha1")
    .update(Buffer.concat([gitObjectHeader, content]))
    .digest("hex");

  if (calculatedGitSha !== blobSha.toLowerCase()) {
    throw new GitHubApiError(
      "GitHub blob content failed SHA verification.",
      "INVALID_RESPONSE",
      200,
      false,
    );
  }

  return {
    sha: calculatedGitSha,
    sizeBytes: content.byteLength,
    content,
  };
}
