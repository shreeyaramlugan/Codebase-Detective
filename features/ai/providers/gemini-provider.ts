// features/ai/providers/gemini-provider.ts
//
// Google Gemini adapter (generateContent REST API). Everything Gemini-specific
// stays in this file: request shape, response shape, error mapping. The
// credential is read from the server environment and is only ever sent in the
// `x-goog-api-key` header; it is never logged, returned or put in a URL.
import {
  AIProviderError,
  type AIProvider,
  type AIRequest,
  type AIResponse,
} from "./ai-provider";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 30_000;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface GeminiProviderOptions {
  apiKey: string | undefined;
  model?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

interface GeminiPart {
  text?: unknown;
}
interface GeminiCandidate {
  finishReason?: unknown;
  content?: { parts?: unknown };
}
interface GeminiBody {
  candidates?: unknown;
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    totalTokenCount?: unknown;
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.endpoint = (options.endpoint ?? DEFAULT_GEMINI_ENDPOINT).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey) {
      throw new AIProviderError(
        "The AI provider is not configured.",
        "NOT_CONFIGURED",
      );
    }
    if (!request.userPrompt.trim()) {
      throw new AIProviderError(
        "The AI request was empty.",
        "MALFORMED_RESPONSE",
      );
    }

    const model = request.model ?? this.model;
    if (!MODEL_PATTERN.test(model)) {
      throw new AIProviderError(
        "The AI model name is invalid.",
        "NOT_CONFIGURED",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.endpoint}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey,
          },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: request.systemPrompt }] },
            contents: [{ role: "user", parts: [{ text: request.userPrompt }] }],
            generationConfig: {
              temperature: request.temperature ?? 0.1,
              ...(request.maxOutputTokens
                ? { maxOutputTokens: request.maxOutputTokens }
                : {}),
              ...(request.responseFormat === "json"
                ? { responseMimeType: "application/json" }
                : {}),
            },
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && error.name === "AbortError");
      throw new AIProviderError(
        aborted
          ? "The AI provider took too long to respond."
          : "The AI provider could not be reached.",
        aborted ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new AIProviderError(
        "The AI provider is rate limiting requests. Try again shortly.",
        "RATE_LIMITED",
        { retryable: true },
      );
    }
    if (response.status === 401 || response.status === 403) {
      // Credential problems are operator errors, not user errors.
      throw new AIProviderError(
        "The AI provider is not available.",
        "NOT_CONFIGURED",
        { detail: `HTTP ${response.status}` },
      );
    }
    if (!response.ok) {
      throw new AIProviderError(
        "The AI provider returned an error.",
        "PROVIDER_UNAVAILABLE",
        { retryable: response.status >= 500, detail: `HTTP ${response.status}` },
      );
    }

    let body: GeminiBody;
    try {
      body = (await response.json()) as GeminiBody;
    } catch {
      throw new AIProviderError(
        "The AI provider returned an unreadable response.",
        "MALFORMED_RESPONSE",
      );
    }

    if (!body || typeof body !== "object") {
      throw new AIProviderError(
        "The AI provider returned an unreadable response.",
        "MALFORMED_RESPONSE",
      );
    }
    if (body.promptFeedback?.blockReason) {
      throw new AIProviderError(
        "The AI provider declined to answer this request.",
        "BLOCKED",
      );
    }

    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const first = candidates[0] as GeminiCandidate | undefined;
    const parts = first?.content?.parts;
    if (!first || !Array.isArray(parts)) {
      throw new AIProviderError(
        "The AI provider returned no answer.",
        "MALFORMED_RESPONSE",
      );
    }
    if (first.finishReason === "SAFETY" || first.finishReason === "RECITATION") {
      throw new AIProviderError(
        "The AI provider declined to answer this request.",
        "BLOCKED",
      );
    }
    if (first.finishReason === "MAX_TOKENS") {
      // A truncated JSON document must never be treated as a valid answer.
      throw new AIProviderError(
        "The AI answer was cut off before it finished.",
        "MALFORMED_RESPONSE",
        { retryable: true },
      );
    }

    const content = (parts as GeminiPart[])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
    if (!content.trim()) {
      throw new AIProviderError(
        "The AI provider returned an empty answer.",
        "MALFORMED_RESPONSE",
      );
    }

    const usage = body.usageMetadata;
    return {
      content,
      provider: this.name,
      model,
      usage: {
        inputTokens: count(usage?.promptTokenCount),
        outputTokens: count(usage?.candidatesTokenCount),
        totalTokens: count(usage?.totalTokenCount),
      },
    };
  }
}
