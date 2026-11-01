import type { AIProvider } from "../providers/ai-provider";

import type {
  AIExplanation,
  ExplanationResult,
} from "../providers/explanation";

import type { GroundingContext } from "./evidence";

import { buildExplanationPrompt } from "../prompts/explain-finding";
import { validateEvidenceReferences } from "./validate-references";

function parseExplanation(content: string): AIExplanation {
  const parsed: unknown = JSON.parse(content);

  if (
    typeof parsed !== "object" ||
    parsed === null
  ) {
    throw new Error("Invalid AI explanation.");
  }

  const value = parsed as Record<string, unknown>;

  if (
    typeof value.summary !== "string" ||
    typeof value.technicalExplanation !== "string" ||
    typeof value.impact !== "string" ||
    !Array.isArray(value.recommendations) ||
    !Array.isArray(value.evidenceReferences)
  ) {
    throw new Error("AI explanation has an invalid structure.");
  }

  if (
    !value.recommendations.every(
      (item) => typeof item === "string",
    )
  ) {
    throw new Error("Invalid recommendation format.");
  }

  const references = value.evidenceReferences;

  for (const reference of references) {
    if (
      typeof reference !== "object" ||
      reference === null
    ) {
      throw new Error("Invalid evidence reference.");
    }

    const item = reference as Record<string, unknown>;

    if (
      typeof item.id !== "string" ||
      (item.type !== "code" && item.type !== "research")
    ) {
      throw new Error("Invalid evidence reference.");
    }
  }

  return {
    summary: value.summary,
    technicalExplanation: value.technicalExplanation,
    impact: value.impact,
    recommendations: value.recommendations,
    evidenceReferences: references as AIExplanation["evidenceReferences"],
  };
}

export async function explainFindings(
  provider: AIProvider,
  context: GroundingContext,
): Promise<ExplanationResult> {
  const response = await provider.generate({
    systemPrompt:
      "You are a technical code analysis explanation assistant. " +
      "Use only supplied evidence.",
    userPrompt: buildExplanationPrompt(context),
    temperature: 0,
  });

  const explanation = parseExplanation(response.content);

  const validation = validateEvidenceReferences(
    explanation,
    context,
  );

  if (!validation.valid) {
    throw new Error(
      `Evidence validation failed: ${validation.errors.join("; ")}`,
    );
  }

  return {
    explanation,
    provider: response.provider,
    model: response.model,
    usage: response.usage,
  };
}