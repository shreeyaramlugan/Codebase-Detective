import type { AnalysisFinding } from "@/features/analysis/contracts";

export interface CodeEvidence {
  id: string;
  type: "code";
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
}

export interface ResearchEvidence {
  id: string;
  type: "research";
  title: string;
  url: string;
  publisher: string;
  excerpt: string;
  retrievedAt: string;
}

export type GroundingEvidence = CodeEvidence | ResearchEvidence;

export interface GroundingContext {
  findings: AnalysisFinding[];
  evidence: GroundingEvidence[];
}
