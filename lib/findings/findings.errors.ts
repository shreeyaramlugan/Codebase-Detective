// lib/findings/findings.errors.ts
export type FindingsErrorCode =
  "NOT_FOUND" | "ANALYSIS_NOT_READY" | "INVALID_INPUT" | "INCOMPATIBLE_RUNS";

export class FindingsError extends Error {
  constructor(
    message: string,
    public readonly code: FindingsErrorCode,
  ) {
    super(message);
    this.name = "FindingsError";
  }
}
