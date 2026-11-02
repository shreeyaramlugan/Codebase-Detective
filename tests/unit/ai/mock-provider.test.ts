import { describe, expect, it } from "vitest";

import { MockAIProvider } from "../../../features/ai/providers/mock-provider";

describe("MockAIProvider", () => {
  it("returns a structured response", async () => {
    const provider = new MockAIProvider();

    const result = await provider.generate({
      systemPrompt: "Explain findings.",
      userPrompt: "Explain IMPORT001.",
    });

    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-v1");
    expect(result.content).toContain("Mock explanation");
  });

  it("rejects an empty prompt", async () => {
    const provider = new MockAIProvider();

    await expect(
      provider.generate({
        systemPrompt: "Explain findings.",
        userPrompt: "   ",
      }),
    ).rejects.toThrow("AI prompt cannot be empty.");
  });
});
