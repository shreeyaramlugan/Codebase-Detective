// lib/research/research.errors.ts
export type ResearchErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "UNSUPPORTED"
  | "CONTEXT_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "BUSY"
  | "INVALID_STATE"
  | "PROVIDER_ERROR"
  | "NOT_CONFIGURED";

export class ResearchError extends Error {
  constructor(
    message: string,
    public readonly code: ResearchErrorCode,
    public readonly options: {
      status?: number;
      retryable?: boolean;
      resetsAt?: string;
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "ResearchError";
  }
}
