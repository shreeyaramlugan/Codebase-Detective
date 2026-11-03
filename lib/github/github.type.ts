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
