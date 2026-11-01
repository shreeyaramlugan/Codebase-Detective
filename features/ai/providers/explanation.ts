import type { AIUsage } from "./ai-provider";

export interface EvidenceReference {
  id: string;
  type: "code" | "research";
}

export interface AIExplanation {
  summary: string;
  technicalExplanation: string;
  impact: string;
  recommendations: string[];
  evidenceReferences: EvidenceReference[];
}

export interface ExplanationResult {
  explanation: AIExplanation;
  provider: string;
  model: string;
  usage?: AIUsage;
}