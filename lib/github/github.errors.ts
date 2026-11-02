export type GitHubErrorCode =
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "FORBIDDEN"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE"
  | "NOT_PUBLIC"
  | "TIMEOUT";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly code: GitHubErrorCode,
    public readonly status?: number,
    public readonly retryable: boolean = false,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}