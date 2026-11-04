export interface ParsedGitHubRepository {
  owner: string;
  name: string;
  fullName: string;
  canonicalUrl: string;
}

export interface GitHubRepositoryMetadata {
  githubId: bigint;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  description: string | null;
  defaultBranch: string | null;
  isPublic: boolean;
  language: string | null;
  stars: number;
  forks: number;
  lastCommitSha: string | null;
}
export interface GitHubCommitReference {
  sha: string;
  treeSha: string;
  message: string;
  authorName: string | null;
  committedAt: string | null;
}

export type GitHubTreeEntryType = "blob" | "tree" | "commit";

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: GitHubTreeEntryType;
  sha: string;
  size?: number;
}

export interface GitHubRepositoryTree {
  commitSha: string;
  rootTreeSha: string;
  entries: GitHubTreeEntry[];
  recoveredFromTruncation: boolean;
}