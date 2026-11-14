// features/ai/providers/provider-factory.ts
import type { AIProvider } from "./ai-provider";
import { GeminiProvider } from "./gemini-provider";
import { MockAIProvider } from "./mock-provider";

export function createAIProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER ?? "mock";

  switch (provider) {
    case "mock":
      return new MockAIProvider();

    case "gemini":
      return new GeminiProvider({
        apiKey: process.env.GEMINI_API_KEY,
        model: process.env.GEMINI_MODEL,
        fallbackModel: process.env.GEMINI_FALLBACK_MODEL,
      });

    default:
      throw new Error(`Unsupported AI provider: ${provider}`);
  }
}
