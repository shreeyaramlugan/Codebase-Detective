// features/findings/engine/run-rules.ts
//
// Runs a rule catalogue against one analysis. The engine:
//  - isolates rule failures (one rule throwing never loses the others),
//  - skips rules that need a complete analysis when it is partial, reporting
//    "insufficient evidence" instead of silently producing a clean result,
//  - validates every finding and enforces each rule's severity/certainty set,
//  - de-duplicates by fingerprint and sorts deterministically.
import {
  FINDINGS_ENGINE_VERSION,
  severityRank,
  type FindingRecord,
  type FindingsEngineResult,
  type RuleContext,
  type RuleDefinition,
  type RuleRunRecord,
} from "../contracts";
import { ruleConfigHash } from "../config";
import { buildValidationIndex, validateFinding } from "./validate-finding";

export const MAX_FINDINGS_PER_RULE = 5_000;

export function assertValidCatalogue(rules: readonly RuleDefinition[]): void {
  const seen = new Set<string>();

  for (const rule of rules) {
    if (!/^[A-Z]{3}\d{3}$/.test(rule.id)) {
      throw new Error(`Invalid rule id "${rule.id}".`);
    }
    if (seen.has(rule.id)) {
      throw new Error(`Duplicate rule id "${rule.id}".`);
    }
    seen.add(rule.id);
    if (!/^\d+\.\d+\.\d+$/.test(rule.version)) {
      throw new Error(`Rule ${rule.id} has an invalid version.`);
    }
    if (rule.severities.length === 0 || rule.certainties.length === 0) {
      throw new Error(`Rule ${rule.id} declares no severity or certainty.`);
    }
  }
}

export function compareFindingOrder(
  a: FindingRecord,
  b: FindingRecord,
): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.subjectPath.localeCompare(b.subjectPath) ||
    (a.primaryLine ?? 0) - (b.primaryLine ?? 0) ||
    a.subjectKey.localeCompare(b.subjectKey)
  );
}

export function runRules(
  rules: readonly RuleDefinition[],
  context: RuleContext,
): FindingsEngineResult {
  assertValidCatalogue(rules);

  const index = buildValidationIndex(context.records);
  const ordered = [...rules].sort((a, b) => a.id.localeCompare(b.id));
  const accepted = new Map<string, FindingRecord>();
  const ruleRuns: RuleRunRecord[] = [];
  const limitations: string[] = [];

  if (!context.analysis.complete) {
    limitations.push(
      "The analysis is partial. Rules that need a complete analysis were not run, and absence of findings must not be read as absence of issues.",
    );
  }

  if (context.factsMissing.size > 0) {
    limitations.push(
      `Source facts were unavailable for ${context.factsMissing.size} file(s); complexity, structure and security rules did not cover them.`,
    );
  }

  for (const rule of ordered) {
    const run: RuleRunRecord = {
      ruleId: rule.id,
      ruleVersion: rule.version,
      status: "COMPLETED",
      reason: null,
      findingCount: 0,
      rejectedCount: 0,
      duplicateCount: 0,
      limitations: [],
      configHash: ruleConfigHash(rule, context.thresholds),
    };

    if (rule.requiresCompleteAnalysis && !context.analysis.complete) {
      run.status = "SKIPPED";
      run.reason =
        "Insufficient evidence: this rule needs a complete analysis of a complete snapshot.";
      ruleRuns.push(run);
      continue;
    }

    let evaluation;

    try {
      evaluation = rule.evaluate(context);
    } catch {
      run.status = "FAILED";
      run.reason = "The rule failed while evaluating this analysis.";
      ruleRuns.push(run);
      continue;
    }

    if (evaluation.kind === "insufficient") {
      run.status = "SKIPPED";
      run.reason = `Insufficient evidence: ${evaluation.reason}`;
      ruleRuns.push(run);
      continue;
    }

    run.limitations = evaluation.limitations ?? [];

    const batch = evaluation.findings.slice(0, MAX_FINDINGS_PER_RULE);

    if (evaluation.findings.length > batch.length) {
      run.limitations.push(
        `Output truncated at ${MAX_FINDINGS_PER_RULE} findings.`,
      );
    }

    for (const raw of batch) {
      const result = validateFinding(rule, raw, index);

      if (!result.ok) {
        run.rejectedCount += 1;
        continue;
      }

      if (accepted.has(result.finding.fingerprint)) {
        run.duplicateCount += 1;
        continue;
      }

      accepted.set(result.finding.fingerprint, result.finding);
      run.findingCount += 1;
    }

    if (run.rejectedCount > 0) {
      run.limitations.push(
        `${run.rejectedCount} candidate finding(s) were rejected because their evidence or severity was invalid.`,
      );
    }

    ruleRuns.push(run);
  }

  const incomplete =
    !context.analysis.complete ||
    ruleRuns.some((run) => run.status !== "COMPLETED") ||
    context.factsMissing.size > 0;

  for (const run of ruleRuns) {
    if (run.status !== "COMPLETED") {
      limitations.push(`${run.ruleId}: ${run.reason}`);
    }
  }

  return {
    outcome: incomplete ? "PARTIAL" : "COMPLETED",
    findings: [...accepted.values()].sort(compareFindingOrder),
    ruleRuns,
    limitations,
  };
}

export { FINDINGS_ENGINE_VERSION };
