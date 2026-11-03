import { parseGitHubRepositoryUrl } from "./github-url";
import { fetchGitHubRepositoryMetadata } from "./github.client";
import type {
  ParsedGitHubRepository,
  GitHubRepositoryMetadata,
} from "./github.type";

export interface ValidatedGitHubRepository {
  parsed: ParsedGitHubRepository;
  metadata: GitHubRepositoryMetadata;
}

export async function validateGitHubRepository(
  input: string,
): Promise<ValidatedGitHubRepository> {
  const parsed = parseGitHubRepositoryUrl(input);

  const metadata = await fetchGitHubRepositoryMetadata(
    parsed.owner,
    parsed.name,
  );

  return {
    parsed,
    metadata,
  };
}
