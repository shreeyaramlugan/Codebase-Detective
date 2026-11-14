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

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const DEFAULT_GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 1_500;
const MODEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface GeminiProviderOptions {
  apiKey: string | undefined;
  model?: string;
  /** Tried once if the primary model stays overloaded. */
  fallbackModel?: string;
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
  private readonly fallbackModel: string | null;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.model = options.model?.trim() || DEFAULT_GEMINI_MODEL;
    this.fallbackModel = options.fallbackModel?.trim() || null;
    this.endpoint = (options.endpoint ?? DEFAULT_GEMINI_ENDPOINT).replace(
      /\/+$/,
      "",
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Retries once on temporary overload (HTTP 429/5xx), then tries the optional
   * fallback model once. The caller's timeout is a total budget shared by all
   * attempts, so retrying never makes a request wait longer than it asked.
   */
  async generate(request: AIRequest): Promise<AIResponse> {
    const total = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    const primary = request.model ?? this.model;
    const fallback =
      this.fallbackModel && this.fallbackModel !== primary ? this.fallbackModel : null;
    const remaining = () => total - (Date.now() - startedAt);
    const isTransient = (error: unknown): error is AIProviderError =>
      error instanceof AIProviderError &&
      error.retryable &&
      (error.code === "PROVIDER_UNAVAILABLE" || error.code === "RATE_LIMITED");

    try {
      // With a fallback the primary gets most of the budget, not all of it.
      return await this.generateOnce(request, primary, fallback ? Math.floor(total * 0.6) : total);
    } catch (firstError) {
      if (!isTransient(firstError)) throw firstError;
      let lastError: AIProviderError = firstError;

      if (remaining() > 8_000) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        try {
          return await this.generateOnce(
            request,
            primary,
            fallback ? Math.min(remaining(), Math.floor(total * 0.3)) : remaining(),
          );
        } catch (secondError) {
          if (!isTransient(secondError)) throw secondError;
          lastError = secondError;
        }
      }

      if (fallback && remaining() > 5_000) {
        try {
          return await this.generateOnce(request, fallback, remaining());
        } catch (fallbackError) {
          if (!isTransient(fallbackError)) throw fallbackError;
          lastError = fallbackError;
        }
      }
      throw lastError;
    }
  }

  private async generateOnce(
    request: AIRequest,
    model: string,
    timeoutMs: number,
  ): Promise<AIResponse> {
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

    if (!MODEL_PATTERN.test(model)) {
      throw new AIProviderError(
        "The AI model name is invalid.",
        "NOT_CONFIGURED",
      );
    }

    const rawBudget = process.env.GEMINI_THINKING_BUDGET?.trim();
    const parsedBudget = rawBudget ? Number(rawBudget) : NaN;
    const thinkingBudget =
      Number.isInteger(parsedBudget) && parsedBudget >= 0 && parsedBudget <= 24_576 ? parsedBudget : null;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs,
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
              // Optional: GEMINI_THINKING_BUDGET=0 turns off "thinking" on Flash
              // models for faster answers. Off by default (not sent at all).
              ...(thinkingBudget !== null
                ? { thinkingConfig: { thinkingBudget } }
                : {}),
              ...(request.responseFormat === "json" && request.responseSchema
                ? { responseSchema: request.responseSchema }
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
      // Google's error text describes the request (for example an unknown
      // model); it never contains our prompt or key. Keep it short.
      let reason = "";
      try {
        const errorBody = (await response.json()) as { error?: { message?: unknown } };
        if (typeof errorBody?.error?.message === "string") {
          reason = ` reason=${errorBody.error.message.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]").slice(0, 200)}`;
        }
      } catch {
        /* no readable body */
      }
      throw new AIProviderError(
        "The AI provider returned an error.",
        "PROVIDER_UNAVAILABLE",
        {
          retryable: response.status >= 500,
          // The model name was validated against MODEL_PATTERN above, so it is
          // safe to log; it is what a 404 almost always refers to.
          detail: `HTTP ${response.status} model=${model}${reason}`,
        },
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
