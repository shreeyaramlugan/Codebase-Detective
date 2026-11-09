// tests/unit/ai/gemini-provider.test.ts
import { describe, expect, it } from "vitest";

import { AIProviderError } from "../../../features/ai/providers/ai-provider";
import { GeminiProvider } from "../../../features/ai/providers/gemini-provider";

const REQ = { systemPrompt: "sys", userPrompt: "hello" };

function reply(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;
}

function ok(text: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [
      { finishReason: "STOP", content: { parts: [{ text }] }, ...extra },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  };
}

async function failure(p: GeminiProvider): Promise<AIProviderError> {
  try {
    await p.generate(REQ);
  } catch (e) {
    return e as AIProviderError;
  }
  throw new Error("expected failure");
}

describe("GeminiProvider", () => {
  it("returns normalised content and usage", async () => {
    const p = new GeminiProvider({ apiKey: "k", fetchImpl: reply(200, ok("hi")) });
    const r = await p.generate(REQ);
    expect(r.content).toBe("hi");
    expect(r.provider).toBe("gemini");
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("sends the key only in a header, never in the URL", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify(ok("x")), { status: 200 });
    }) as unknown as typeof fetch;
    await new GeminiProvider({ apiKey: "SECRET-KEY", fetchImpl }).generate({
      ...REQ,
      responseFormat: "json",
    });
    expect(url.includes("SECRET-KEY")).toBe(false);
    expect(headers["x-goog-api-key"]).toBe("SECRET-KEY");
  });

  it("fails safely when no key is configured", async () => {
    const e = await failure(new GeminiProvider({ apiKey: undefined, fetchImpl: reply(200, ok("x")) }));
    expect(e.code).toBe("NOT_CONFIGURED");
  });

  it("maps 429 to a retryable rate-limit error", async () => {
    const e = await failure(new GeminiProvider({ apiKey: "k", fetchImpl: reply(429, "quota") }));
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.retryable).toBe(true);
  });

  it("hides provider diagnostics on server errors and bad credentials", async () => {
    const e500 = await failure(new GeminiProvider({ apiKey: "k", fetchImpl: reply(500, "internal secret trace") }));
    expect(e500.code).toBe("PROVIDER_UNAVAILABLE");
    expect(e500.message.includes("secret")).toBe(false);
    const e403 = await failure(new GeminiProvider({ apiKey: "k", fetchImpl: reply(403, "bad key") }));
    expect(e403.code).toBe("NOT_CONFIGURED");
    expect(e403.message.includes("key")).toBe(false);
  });

  it("times out", async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          rej(err);
        });
      })) as unknown as typeof fetch;
    const p = new GeminiProvider({ apiKey: "k", fetchImpl });
    try {
      await p.generate({ ...REQ, timeoutMs: 20 });
      throw new Error("expected timeout");
    } catch (e) {
      expect((e as AIProviderError).code).toBe("TIMEOUT");
    }
  });

  it("rejects malformed, truncated, blocked and empty responses", async () => {
    const cases: Array<[unknown, string]> = [
      ["not json", "MALFORMED_RESPONSE"],
      [{ candidates: [] }, "MALFORMED_RESPONSE"],
      [ok("x", { finishReason: "MAX_TOKENS" }), "MALFORMED_RESPONSE"],
      [ok("x", { finishReason: "SAFETY" }), "BLOCKED"],
      [{ promptFeedback: { blockReason: "OTHER" } }, "BLOCKED"],
      [ok("   "), "MALFORMED_RESPONSE"],
    ];
    for (const [body, code] of cases) {
      const e = await failure(new GeminiProvider({ apiKey: "k", fetchImpl: reply(200, body) }));
      expect(e.code).toBe(code);
    }
  });

  it("rejects an unsafe model name", async () => {
    const p = new GeminiProvider({ apiKey: "k", fetchImpl: reply(200, ok("x")) });
    try {
      await p.generate({ ...REQ, model: "../../evil" });
      throw new Error("expected failure");
    } catch (e) {
      expect((e as AIProviderError).code).toBe("NOT_CONFIGURED");
    }
  });
});

describe("createAIProvider (gemini)", () => {
  it("creates the Gemini provider only when AI_PROVIDER=gemini", async () => {
    const { createAIProvider } = await import(
      "@/features/ai/providers/provider-factory"
    );
    const previous = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "gemini";
    try {
      expect(createAIProvider().name).toBe("gemini");
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = previous;
    }
  });
});
