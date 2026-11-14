// features/ai/providers/ai-provider.ts
//
// Provider-independent AI interface. Sprint 06 extends the original contract
// with optional limits and a typed error; existing callers are unaffected.
export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIRequest {
  systemPrompt: string;
  userPrompt: string;
  model?: string;
  temperature?: number;
  /** Hard cap on generated tokens (Sprint 06). */
  maxOutputTokens?: number;
  /** Abort the provider call after this many milliseconds (Sprint 06). */
  timeoutMs?: number;
  /** Ask the provider for a JSON document (Sprint 06). */
  responseFormat?: "text" | "json";
  /** JSON schema the provider should enforce when responseFormat is "json". */
  responseSchema?: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  provider: string;
  model: string;
  usage?: AIUsage;
}

export interface AIProvider {
  readonly name: string;

  generate(request: AIRequest): Promise<AIResponse>;
}

export type AIProviderErrorCode =
  | "NOT_CONFIGURED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "BLOCKED"
  | "MALFORMED_RESPONSE";

/**
 * A provider failure that is safe to show. `message` never contains provider
 * diagnostics, credentials or request bodies; `detail` is for server logs only.
 */
export class AIProviderError extends Error {
  readonly code: AIProviderErrorCode;
  readonly retryable: boolean;
  readonly detail?: string;

  constructor(
    message: string,
    code: AIProviderErrorCode,
    options: { retryable?: boolean; detail?: string } = {},
  ) {
    super(message);
    this.name = "AIProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.detail = options.detail;
  }
}
