export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface CodeLocation {
  path: string;
  startLine: number;
  endLine: number;
}

export interface AnalysisFinding {
  ruleId: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  location: CodeLocation;
  evidence: string[];
  recommendation?: string;
}
