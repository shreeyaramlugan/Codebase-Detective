import type { AIProvider } from "./ai-provider";
import { MockAIProvider } from "./mock-provider";

export function createAIProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER ?? "mock";

  switch (provider) {
    case "mock":
      return new MockAIProvider();

    default:
      throw new Error(
        `Unsupported AI provider: ${provider}`,
      );
  }
}