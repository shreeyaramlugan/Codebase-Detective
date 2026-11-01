import { describe, expect, it } from "vitest";

import { MockAIProvider } from "../../../features/ai/providers/mock-provider";
import { explainFindings } from "../../../features/ai/grounding/explain";

describe("Explanation service", () => {
  it("successfully processes a valid mock explanation", async () => {
    const provider = new MockAIProvider();

    const result = await explainFindings(provider, {
      findings: [],
      evidence: [],
    });

    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-v1");

    expect(result.explanation.summary).toBe(
      "Mock explanation generated."
    );

    expect(result.explanation.recommendations).toHaveLength(1);
    expect(result.explanation.evidenceReferences).toHaveLength(0);
  });

  it("rejects malformed AI responses", async () => {
    const provider = {
      name: "invalid-mock",

      async generate() {
        return {
          content: JSON.stringify({
            summary: "An issue exists.",
            technicalExplanation: "Some explanation.",
            // Missing impact, recommendations and evidenceReferences.
          }),
          provider: "invalid-mock",
          model: "invalid-v1",
        };
      },
    };

    await expect(
      explainFindings(provider, {
        findings: [],
        evidence: [],
      })
    ).rejects.toThrow(
      "AI explanation has an invalid structure."
    );
  });
});