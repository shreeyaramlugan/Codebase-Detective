import { afterEach, describe, expect, it, vi } from "vitest";
import { MockAIProvider } from "@/features/ai/providers/mock-provider";
import { createAIProvider } from "@/features/ai/providers/provider-factory";

describe("createAIProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates the mock provider when AI_PROVIDER is mock", () => {
    vi.stubEnv("AI_PROVIDER", "mock");

    const provider = createAIProvider();

    expect(provider).toBeInstanceOf(MockAIProvider);
    expect(provider.name).toBe("mock");
  });

  it("defaults to the mock provider when AI_PROVIDER is unset", () => {
    vi.stubEnv("AI_PROVIDER", undefined);

    const provider = createAIProvider();

    expect(provider).toBeInstanceOf(MockAIProvider);
  });

  it("throws an error for an unsupported provider", () => {
    vi.stubEnv("AI_PROVIDER", "openai");

    expect(() => createAIProvider()).toThrow("Unsupported AI provider: openai");
  });

  it("does not silently accept an unsupported provider", () => {
    vi.stubEnv("AI_PROVIDER", "unknown");

    expect(() => createAIProvider()).toThrow(
      "Unsupported AI provider: unknown",
    );
  });
});
