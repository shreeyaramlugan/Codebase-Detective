// lib/analysis/analysis.errors.ts
export type AnalysisErrorCode =
  "NOT_FOUND" | "SNAPSHOT_NOT_READY" | "GRAPH_UNAVAILABLE" | "INVALID_QUERY";

export class AnalysisError extends Error {
  constructor(
    message: string,
    public readonly code: AnalysisErrorCode,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}
