// features/ai/assistant/contracts.ts
//
// Contracts for the Sprint 06 investigation assistant. Nothing here knows
// about Gemini, Prisma or HTTP.
export const ASSISTANT_VERSION = "1.0.0";

export const EVIDENCE_KINDS = [
  "repository",
  "source",
  "symbol",
  "dependency",
  "call",
  "finding",
  "document",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** How firmly the platform's own analysis established an evidence item. */
export type EvidenceCertainty =
  | "CONFIRMED"
  | "POSSIBLE"
  | "AMBIGUOUS"
  | "UNRESOLVED"
  | "INDICATOR"
  | "NOT_APPLICABLE";

/** The one snapshot + analysis an answer is allowed to draw on. */
export interface SnapshotScope {
  repositoryId: string;
  repositoryName: string;
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  /** Snapshot completeness at analysis time (COMPLETE / PARTIAL / null). */
  completeness: string | null;
  analysisStatus: string;
  findingsRunId: string | null;
}

/** Evidence as retrieved from the database, before an id is assigned. */
export interface EvidenceCandidate {
  kind: EvidenceKind;
  certainty: EvidenceCertainty;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  symbolKey: string | null;
  title: string;
  /** Raw text. For source/document items: the file lines, newline separated. */
  text: string;
  /** Higher is more relevant. Must be deterministic for identical inputs. */
  score: number;
}

export interface EvidenceItem extends EvidenceCandidate {
  /** E1, E2, ... assigned in ranking order; the only handle the model sees. */
  id: string;
}

export interface AssistantLimits {
  maxQuestionChars: number;
  maxContextChars: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  dailyRequestLimit: number;
  dailyTokenLimit: number;
}

export type SectionType = "fact" | "inference" | "uncertainty";

/** Derived by the platform from the evidence a section cites - never by the model. */
export type SectionCertainty = "ESTABLISHED" | "POSSIBLE" | "NOT_SUPPORTED";

export interface Citation {
  evidenceId: string;
  kind: EvidenceKind;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  symbolKey: string | null;
  certainty: EvidenceCertainty;
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  label: string;
}

export interface AnswerSection {
  type: SectionType;
  text: string;
  certainty: SectionCertainty;
  citations: Citation[];
}

export interface SourceReference extends Citation {
  /** Indexes of the answer sections that cite this reference. */
  sections: number[];
}

export type AnswerStatus = "ANSWERED" | "INSUFFICIENT_EVIDENCE";

export interface AssistantAnswer {
  status: AnswerStatus;
  sections: AnswerSection[];
  references: SourceReference[];
  limitations: string[];
  /** Factual claims dropped because no valid evidence supported them. */
  removedClaims: number;
  /** Citations dropped because they did not validate. */
  rejectedCitations: number;
  scope: SnapshotScope;
}

export interface RetrievalSummary {
  category: string;
  terms: string[];
  evidenceCount: number;
  usedChars: number;
  truncated: boolean;
  droppedCount: number;
  evidenceIds: string[];
}
