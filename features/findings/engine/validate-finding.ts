// features/findings/engine/validate-finding.ts
//
// Every finding a rule returns is validated before it is accepted. Invalid
// findings are rejected (and counted), never repaired or guessed.
import type { AnalysisRecords } from "@/features/code-intelligence/contracts";

import type {
  EvidenceRecord,
  FindingRecord,
  RawEvidence,
  RawFinding,
  RuleDefinition,
} from "../contracts";
import { createFindingFingerprint } from "../identity";

export const MAX_EVIDENCE_PER_FINDING = 25;
export const MAX_TEXT = 500;

export interface ValidationIndex {
  filePaths: ReadonlySet<string>;
  symbolKeys: ReadonlySet<string>;
  lineCounts: ReadonlyMap<string, number>;
}

export function buildValidationIndex(
  records: AnalysisRecords,
): ValidationIndex {
  return {
    filePaths: new Set(records.files.map((file) => file.path)),
    symbolKeys: new Set(records.symbols.map((symbol) => symbol.key)),
    lineCounts: new Map(
      records.files.map((file) => [file.path, file.lineCount] as const),
    ),
  };
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function validateEvidence(
  evidence: RawEvidence,
  index: ValidationIndex,
): string | null {
  if (!index.filePaths.has(evidence.filePath)) {
    return `evidence file "${evidence.filePath}" is not part of the analysis`;
  }

  if (
    evidence.symbolKey !== null &&
    !index.symbolKeys.has(evidence.symbolKey)
  ) {
    return "evidence references an unknown symbol";
  }

  if (evidence.location) {
    const { startLine, endLine, startColumn, endColumn } = evidence.location;
    const lines = index.lineCounts.get(evidence.filePath) ?? 0;

    if (
      ![startLine, endLine, startColumn, endColumn].every(
        (n) => Number.isInteger(n) && n >= 1,
      ) ||
      endLine < startLine ||
      (endLine === startLine && endColumn < startColumn)
    ) {
      return "evidence location is malformed";
    }

    // lineCount can be one short of an editor's count when a file ends with a
    // newline; allow that single trailing line.
    if (endLine > lines + 1) {
      return "evidence location is outside the file";
    }
  }

  if (!evidence.message.trim()) return "evidence has no explanation";

  return null;
}

export type FindingValidation =
  { ok: true; finding: FindingRecord } | { ok: false; reason: string };

export function validateFinding(
  rule: RuleDefinition,
  raw: RawFinding,
  index: ValidationIndex,
  recommendation: string = rule.recommendation,
): FindingValidation {
  if (!rule.severities.includes(raw.severity)) {
    return {
      ok: false,
      reason: `severity ${raw.severity} is not permitted for ${rule.id}`,
    };
  }

  if (!rule.certainties.includes(raw.certainty)) {
    return {
      ok: false,
      reason: `certainty ${raw.certainty} is not permitted for ${rule.id}`,
    };
  }

  if (!raw.title.trim() || !raw.description.trim() || !raw.subjectKey.trim()) {
    return { ok: false, reason: "finding is missing required text" };
  }

  if (!index.filePaths.has(raw.subjectPath)) {
    return { ok: false, reason: "subject file is not part of the analysis" };
  }

  if (raw.symbolKey !== null && !index.symbolKeys.has(raw.symbolKey)) {
    return { ok: false, reason: "finding references an unknown symbol" };
  }

  if (raw.evidence.length === 0) {
    return { ok: false, reason: "finding has no evidence" };
  }

  const evidence: EvidenceRecord[] = [];

  for (const item of raw.evidence.slice(0, MAX_EVIDENCE_PER_FINDING)) {
    const problem = validateEvidence(item, index);
    if (problem) return { ok: false, reason: problem };
    evidence.push({
      ...item,
      excerpt: item.excerpt === null ? null : clip(item.excerpt, 200),
      message: clip(item.message),
      ordinal: evidence.length,
    });
  }

  return {
    ok: true,
    finding: {
      fingerprint: createFindingFingerprint({
        ruleId: rule.id,
        subjectPath: raw.subjectPath,
        subjectKey: raw.subjectKey,
      }),
      ruleId: rule.id,
      ruleVersion: rule.version,
      category: rule.category,
      severity: raw.severity,
      certainty: raw.certainty,
      title: clip(raw.title, 200),
      description: clip(raw.description, 1000),
      recommendation,
      subjectPath: raw.subjectPath,
      subjectKey: raw.subjectKey,
      symbolKey: raw.symbolKey,
      primaryLine: raw.primaryLine,
      measurements: raw.measurements,
      evidence,
    },
  };
}
