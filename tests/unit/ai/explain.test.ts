import { describe, expect, it, vi } from "vitest";

import type { AIProvider } from "../../../features/ai/providers/ai-provider";
import type { AIResponse } from "../../../features/ai/providers/ai-provider";
import type { GroundingContext } from "../../../features/ai/grounding/evidence";

import { MockAIProvider } from "../../../features/ai/providers/mock-provider";
import { explainFindings } from "../../../features/ai/grounding/explain";

function createProvider(content: string): AIProvider {
  return {
    name: "test-provider",

    async generate(): Promise<AIResponse> {
      return {
        content,
        provider: "test-provider",
        model: "test-v1",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      };
    },
  };
}

function validExplanation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: "A potential issue was identified.",
    technicalExplanation: "The code contains a potential problem.",
    impact: "This could affect application reliability.",
    recommendations: ["Review the affected code."],
    evidenceReferences: [],
    ...overrides,
  });
}

const emptyContext: GroundingContext = {
  findings: [],
  evidence: [],
};

const codeContext: GroundingContext = {
  findings: [],
  evidence: [
    {
      id: "code-001",
      type: "code",
      path: "src/example.ts",
      startLine: 10,
      endLine: 15,
      excerpt: "const result = calculate();",
    },
  ],
};

const researchContext: GroundingContext = {
  findings: [],
  evidence: [
    {
      id: "research-001",
      type: "research",
      title: "Official Documentation",
      url: "https://example.com/docs",
      publisher: "Example",
      excerpt: "Relevant documentation excerpt.",
      retrievedAt: "2026-11-02T10:00:00.000Z",
    },
  ],
};

describe("Explanation service", () => {
  it("successfully processes a valid mock explanation", async () => {
    const provider = new MockAIProvider();

    const result = await explainFindings(provider, emptyContext);

    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-v1");

    expect(result.explanation.summary).toBe("Mock explanation generated.");

    expect(result.explanation.recommendations).toHaveLength(1);
    expect(result.explanation.evidenceReferences).toHaveLength(0);
  });

  it("returns provider usage metadata when available", async () => {
    const provider = createProvider(validExplanation());

    const result = await explainFindings(provider, emptyContext);

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("rejects malformed AI response structures", async () => {
    const provider = createProvider(
      JSON.stringify({
        summary: "An issue exists.",
        technicalExplanation: "Some explanation.",
      }),
    );

    await expect(explainFindings(provider, emptyContext)).rejects.toThrow(
      "AI explanation has an invalid structure.",
    );
  });

  it.each([
    ["invalid JSON", "{invalid-json"],
    ["empty response", ""],
    ["JSON null", "null"],
    ["JSON array", "[]"],
    ["JSON string", '"hello"'],
    ["JSON number", "123"],
    ["JSON boolean", "true"],
  ])("rejects %s", async (_description, content) => {
    const provider = createProvider(content);

    await expect(explainFindings(provider, emptyContext)).rejects.toThrow();
  });

  it.each([
    ["summary", { summary: 123 }],
    ["technicalExplanation", { technicalExplanation: false }],
    ["impact", { impact: null }],
    ["recommendations", { recommendations: "Fix the issue" }],
    ["evidenceReferences", { evidenceReferences: "code-001" }],
  ])("rejects an invalid %s field", async (_field, override) => {
    const provider = createProvider(validExplanation(override));

    await expect(explainFindings(provider, emptyContext)).rejects.toThrow(
      "AI explanation has an invalid structure.",
    );
  });

  it("rejects recommendations containing non-string values", async () => {
    const provider = createProvider(
      validExplanation({
        recommendations: ["Review the code.", 123],
      }),
    );

    await expect(explainFindings(provider, emptyContext)).rejects.toThrow(
      "Invalid recommendation format.",
    );
  });

  it.each([
    ["null reference", null],
    ["string reference", "code-001"],
    ["reference without an ID", { type: "code" }],
    ["reference with an invalid type", { id: "code-001", type: "invalid" }],
    ["reference with a non-string ID", { id: 123, type: "code" }],
  ])(
    "rejects an invalid evidence reference: %s",
    async (_description, reference) => {
      const provider = createProvider(
        validExplanation({
          evidenceReferences: [reference],
        }),
      );

      await expect(explainFindings(provider, emptyContext)).rejects.toThrow(
        "Invalid evidence reference.",
      );
    },
  );

  it("accepts a valid code evidence reference", async () => {
    const provider = createProvider(
      validExplanation({
        evidenceReferences: [
          {
            id: "code-001",
            type: "code",
          },
        ],
      }),
    );

    const result = await explainFindings(provider, codeContext);

    expect(result.explanation.evidenceReferences).toEqual([
      {
        id: "code-001",
        type: "code",
      },
    ]);
  });

  it("accepts a valid research evidence reference", async () => {
    const provider = createProvider(
      validExplanation({
        evidenceReferences: [
          {
            id: "research-001",
            type: "research",
          },
        ],
      }),
    );

    const result = await explainFindings(provider, researchContext);

    expect(result.explanation.evidenceReferences).toEqual([
      {
        id: "research-001",
        type: "research",
      },
    ]);
  });

  it("rejects evidence IDs that do not exist in the supplied context", async () => {
    const provider = createProvider(
      validExplanation({
        evidenceReferences: [
          {
            id: "unknown-001",
            type: "code",
          },
        ],
      }),
    );

    await expect(explainFindings(provider, codeContext)).rejects.toThrow(
      "Evidence validation failed: Unknown evidence reference: unknown-001",
    );
  });

  it("rejects evidence references with mismatched types", async () => {
    const provider = createProvider(
      validExplanation({
        evidenceReferences: [
          {
            id: "code-001",
            type: "research",
          },
        ],
      }),
    );

    await expect(explainFindings(provider, codeContext)).rejects.toThrow(
      "Evidence validation failed: Evidence type mismatch: code-001",
    );
  });

  it("rejects duplicate evidence references when the context contains no matching evidence", async () => {
    const provider = createProvider(
      validExplanation({
        evidenceReferences: [
          {
            id: "unknown-001",
            type: "code",
          },
          {
            id: "unknown-001",
            type: "code",
          },
        ],
      }),
    );

    await expect(explainFindings(provider, codeContext)).rejects.toThrow(
      "Unknown evidence reference: unknown-001",
    );
  });

  it("propagates provider failures", async () => {
    const provider: AIProvider = {
      name: "failing-provider",

      async generate() {
        throw new Error("Provider unavailable.");
      },
    };

    await expect(explainFindings(provider, emptyContext)).rejects.toThrow(
      "Provider unavailable.",
    );
  });

  it("propagates provider timeout errors", async () => {
    const provider: AIProvider = {
      name: "timeout-provider",

      async generate() {
        throw new Error("Request timed out.");
      },
    };

    await expect(explainFindings(provider, emptyContext)).rejects.toThrow(
      "Request timed out.",
    );
  });
});
