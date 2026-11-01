import { describe, expect, it } from "vitest";

import { validateEvidenceReferences } from "../../../features/ai/grounding/validate-references";

import type {
  GroundingContext,
} from "../../../features/ai/grounding/evidence";

import type {
  AIExplanation,
} from "../../../features/ai/providers/explanation";

const context: GroundingContext = {
  findings: [],
  evidence: [
    {
      id: "CODE-001",
      type: "code",
      path: "src/app/page.tsx",
      startLine: 10,
      endLine: 10,
      excerpt: 'import Button from "./Button";',
    },
  ],
};

describe("Evidence grounding", () => {
  it("accepts a known evidence reference", () => {
    const explanation: AIExplanation = {
      summary: "An import could not be resolved.",
      technicalExplanation: "The module was not found.",
      impact: "The application may fail to compile.",
      recommendations: ["Verify the module path."],
      evidenceReferences: [
        {
          id: "CODE-001",
          type: "code",
        },
      ],
    };

    const result = validateEvidenceReferences(
      explanation,
      context,
    );

    expect(result.valid).toBe(true);
    expect(result.acceptedReferences).toHaveLength(1);
  });

  it("rejects fabricated evidence IDs", () => {
    const explanation: AIExplanation = {
      summary: "An issue exists.",
      technicalExplanation: "Unsupported explanation.",
      impact: "Unknown.",
      recommendations: [],
      evidenceReferences: [
        {
          id: "FAKE-999",
          type: "code",
        },
      ],
    };

    const result = validateEvidenceReferences(
      explanation,
      context,
    );

    expect(result.valid).toBe(false);
    expect(result.rejectedReferences).toHaveLength(1);
  });

  it("rejects evidence type mismatches", () => {
    const explanation: AIExplanation = {
      summary: "An issue exists.",
      technicalExplanation: "Explanation.",
      impact: "Unknown.",
      recommendations: [],
      evidenceReferences: [
        {
          id: "CODE-001",
          type: "research",
        },
      ],
    };

    const result = validateEvidenceReferences(
      explanation,
      context,
    );

    expect(result.valid).toBe(false);
  });

  it("rejects duplicate references from accepted output", () => {
    const explanation: AIExplanation = {
      summary: "An issue exists.",
      technicalExplanation: "Explanation.",
      impact: "Unknown.",
      recommendations: [],
      evidenceReferences: [
        { id: "CODE-001", type: "code" },
        { id: "CODE-001", type: "code" },
      ],
    };

    const result = validateEvidenceReferences(
      explanation,
      context,
    );

    expect(result.valid).toBe(true);
    expect(result.acceptedReferences).toHaveLength(1);
  });
});