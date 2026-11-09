// lib/ai/ai.errors.ts
export type AIErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONTEXT_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "BUSY"
  | "PROVIDER_ERROR"
  | "NOT_CONFIGURED";

export class AIError extends Error {
  constructor(
    message: string,
    public readonly code: AIErrorCode,
    public readonly options: {
      /** HTTP status override (e.g. 504 for a provider timeout). */
      status?: number;
      retryable?: boolean;
      resetsAt?: string;
      /** Safe extra payload for the response body (e.g. the persisted failed message). */
      data?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "AIError";
  }
}
