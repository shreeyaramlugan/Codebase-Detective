// features/findings/contracts.ts
//
// Contracts for the Sprint 05 deterministic findings engine.
//
// PRINCIPLES
//  - A finding is produced only by a versioned rule evaluating persisted
//    Sprint 03 analysis data (plus the syntax-only source facts defined in
//    ./facts). Nothing here uses AI, heuristics that guess code
//    relationships, or runtime behaviour.
//  - Every finding carries evidence that is validated against the analysis it
//    came from. A finding without valid evidence is never produced.
//  - Certainty is explicit. A security-like pattern is an INDICATOR, never a
//    confirmed vulnerability.
import type {
  AnalysisRecords,
  SourceLocation,
} from "@/features/code-intelligence/contracts";

/** Bump when engine behaviour (not an individual rule) changes. */
export const FINDINGS_ENGINE_VERSION = "1.0.0";

/** Bump when the set of rules in the catalogue changes. */
export const RULE_CATALOGUE_VERSION = "1.0.0";

export type FindingCategory =
  "DEPENDENCY" | "COMPLEXITY" | "STRUCTURE" | "SECURITY";

export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "DEPENDENCY",
  "COMPLEXITY",
  "STRUCTURE",
  "SECURITY",
];

/**
 * Severity levels. The rule defines severity; it is never inferred elsewhere.
 * CRITICAL is reserved: no rule in the initial catalogue can emit it, because
 * a purely static check cannot establish a "highly significant, confirmed"
 * issue (see docs/sprint-05-findings.md).
 */
export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export const SEVERITY_ORDER: readonly FindingSeverity[] = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFO",
];

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/**
 * How strongly the available data supports the finding:
 *  CONFIRMED - the condition is a recorded fact of the analysis (e.g. an
 *              internal import that did not resolve, a dependency cycle).
 *  MEASURED  - a measurement exceeds an explicit, recorded threshold.
 *  INDICATOR - a static pattern that warrants investigation; it does not
 *              establish a defect or vulnerability.
 */
export type FindingCertainty = "CONFIRMED" | "MEASURED" | "INDICATOR";

export const FINDING_CERTAINTIES: readonly FindingCertainty[] = [
  "CONFIRMED",
  "MEASURED",
  "INDICATOR",
];

/** FILE rules only need the files they report on; PROJECT rules need all. */
export type RuleScope = "FILE" | "PROJECT";

export type EvidenceKind =
  | "SOURCE_LOCATION"
  | "DEPENDENCY"
  | "SYMBOL"
  | "METRIC"
  | "CYCLE_EDGE"
  | "PATTERN_MATCH";

export type JsonPrimitive = string | number | boolean | null;

export interface RawEvidence {
  kind: EvidenceKind;
  /** Repository-relative path; must be a file of the analysis. */
  filePath: string;
  /** Stable key of a Sprint 03 symbol, when the evidence is about one. */
  symbolKey: string | null;
  location: SourceLocation | null;
  /** Short source excerpt. Credential-like values are always redacted. */
  excerpt: string | null;
  /** Why this evidence supports the finding. */
  message: string;
  data?: Record<string, JsonPrimitive>;
}

export interface RawFinding {
  title: string;
  description: string;
  severity: FindingSeverity;
  certainty: FindingCertainty;
  /** File the finding is about. Part of the finding identity. */
  subjectPath: string;
  /**
   * Path-independent identifier of the subject within the file (for example
   * `FUNCTION:Foo.bar#0`, or an import specifier). Together with the rule id
   * and subjectPath it forms the finding fingerprint.
   */
  subjectKey: string;
  symbolKey: string | null;
  /** Line to open first; usually the start of the primary evidence. */
  primaryLine: number | null;
  evidence: RawEvidence[];
  /** The measurements that triggered the rule (metric, value, threshold). */
  measurements: Record<string, JsonPrimitive> | null;
}

export type RuleEvaluation =
  | { kind: "findings"; findings: RawFinding[]; limitations?: string[] }
  | { kind: "insufficient"; reason: string };

export interface RuleDefinition {
  /** Stable, unique identifier, e.g. "DEP001". Never reused or renumbered. */
  id: string;
  name: string;
  /** Implementation version (semver). Bump on ANY behaviour change. */
  version: string;
  category: FindingCategory;
  /** The only severities this rule may emit; enforced by the engine. */
  severities: readonly FindingSeverity[];
  /** Human-readable severity policy. */
  severityPolicy: string;
  /** The certainty values this rule may emit; enforced by the engine. */
  certainties: readonly FindingCertainty[];
  scope: RuleScope;
  /** When true, a PARTIAL analysis/snapshot yields "insufficient evidence". */
  requiresCompleteAnalysis: boolean;
  /** When true, the rule reads source facts (and reports missing ones). */
  usesSourceFacts: boolean;
  /** Threshold keys that influence this rule (recorded and compared). */
  thresholdKeys: readonly (keyof Thresholds)[];
  description: string;
  /** Documented, deterministic evaluation condition. */
  evaluation: string;
  /** What evidence every finding of this rule must carry. */
  evidenceRequirement: string;
  recommendation: string;
  evaluate(context: RuleContext): RuleEvaluation;
}

export interface Thresholds {
  /** Cyclomatic complexity at which a function is reported (Medium). */
  cyclomaticMedium: number;
  /** Cyclomatic complexity reported as High. */
  cyclomaticHigh: number;
  functionLinesLow: number;
  functionLinesMedium: number;
  nestingDepthLow: number;
  parameterCountLow: number;
  moduleLinesLow: number;
  moduleLinesMedium: number;
  /** Cycle size (files) reported as High instead of Medium. */
  circularHighSize: number;
  /** Functions sharing one structure before it is reported. */
  duplicateMinGroupSize: number;
  /** Minimum syntax-node count for a function to be considered. */
  duplicateMinNodes: number;
}

export type SymbolKindForFacts = "FUNCTION" | "METHOD";

export interface FunctionFacts {
  /** Stable key of the Sprint 03 symbol this function belongs to. */
  symbolKey: string | null;
  location: SourceLocation;
  cyclomatic: number;
  maxNesting: number;
  parameterCount: number;
  lineSpan: number;
  nodeCount: number;
  /** Structural fingerprint (identifier/literal-insensitive), if eligible. */
  structureHash: string | null;
}

export type SecurityIndicatorKind =
  | "DYNAMIC_CODE_EVALUATION"
  | "SHELL_COMMAND_EXECUTION"
  | "HTML_INJECTION_SINK"
  | "HARDCODED_CREDENTIAL"
  | "TLS_VERIFICATION_DISABLED"
  | "WEAK_HASH_ALGORITHM";

export interface SecuritySite {
  indicator: SecurityIndicatorKind;
  location: SourceLocation;
  /** Already redacted where required. Never contains a credential value. */
  excerpt: string;
  /** Machine-readable facts about the match (no secret values). */
  detail: Record<string, JsonPrimitive>;
}

export interface FileFacts {
  path: string;
  contentHash: string;
  lineCount: number;
  /** Number of top-level statements (0 means no executable/declarative code). */
  statementCount: number;
  syntaxErrorCount: number;
  functions: FunctionFacts[];
  securitySites: SecuritySite[];
}

export interface AnalysisInfo {
  id: string;
  snapshotId: string;
  repositoryId: string;
  /** COMPLETED or PARTIAL; findings are never run on other states. */
  status: "COMPLETED" | "PARTIAL";
  snapshotCompleteness: string | null;
  /** True only for COMPLETED analyses over COMPLETE snapshots. */
  complete: boolean;
}

export interface RuleContext {
  analysis: AnalysisInfo;
  records: AnalysisRecords;
  thresholds: Thresholds;
  /** Source facts by path, for files whose source could be verified. */
  facts: ReadonlyMap<string, FileFacts>;
  /** Analysed files whose source facts could not be produced, with reason. */
  factsMissing: ReadonlyMap<string, string>;
}

export type RuleRunStatus = "COMPLETED" | "SKIPPED" | "FAILED";

export interface RuleRunRecord {
  ruleId: string;
  ruleVersion: string;
  status: RuleRunStatus;
  /** Why the rule was skipped or failed (never internal detail). */
  reason: string | null;
  findingCount: number;
  /** Findings dropped because their evidence or severity was invalid. */
  rejectedCount: number;
  /** Duplicate fingerprints dropped within this run. */
  duplicateCount: number;
  limitations: string[];
  /** Hash of the thresholds this rule uses, for comparison compatibility. */
  configHash: string;
}

export interface EvidenceRecord extends RawEvidence {
  ordinal: number;
}

export interface FindingRecord {
  fingerprint: string;
  ruleId: string;
  ruleVersion: string;
  category: FindingCategory;
  severity: FindingSeverity;
  certainty: FindingCertainty;
  title: string;
  description: string;
  recommendation: string;
  subjectPath: string;
  subjectKey: string;
  symbolKey: string | null;
  primaryLine: number | null;
  measurements: Record<string, JsonPrimitive> | null;
  evidence: EvidenceRecord[];
}

export type FindingsRunOutcome = "COMPLETED" | "PARTIAL";

export interface FindingsEngineResult {
  outcome: FindingsRunOutcome;
  findings: FindingRecord[];
  ruleRuns: RuleRunRecord[];
  /** Run-level limitations (partial analysis, missing facts). */
  limitations: string[];
}
