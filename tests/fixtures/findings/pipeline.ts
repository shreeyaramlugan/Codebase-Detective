// tests/fixtures/findings/pipeline.ts
//
// Runs the Sprint 03 engine on an in-memory project, then the findings engine
// on its output, exactly as the production runner does (minus persistence).
import { createHash } from "node:crypto";

import {
  analyze,
  type Project,
} from "@/tests/fixtures/code-intelligence/projects";
import type { AnalysisRecords } from "@/features/code-intelligence/contracts";
import { resolveThresholds } from "@/features/findings/config";
import type {
  AnalysisInfo,
  FindingsEngineResult,
  RuleDefinition,
  Thresholds,
} from "@/features/findings/contracts";
import { runRules } from "@/features/findings/engine/run-rules";
import {
  buildFacts,
  type LoadedSource,
} from "@/features/findings/facts/build-facts";
import { RULE_CATALOGUE } from "@/features/findings/rules";

export function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface PipelineOptions {
  completeness?: string | null;
  thresholds?: Partial<Thresholds>;
  rules?: readonly RuleDefinition[];
  /** Paths whose source is withheld from the facts pass. */
  withhold?: string[];
  /** Replace content for a path (to simulate a stale or corrupt read). */
  override?: Record<string, string>;
}

export function runPipeline(project: Project, options: PipelineOptions = {}) {
  const completeness =
    options.completeness === undefined ? "COMPLETE" : options.completeness;
  const { records } = analyze(project, { completeness });
  return runOnRecords(records, project, options, completeness);
}

export function runOnRecords(
  records: AnalysisRecords,
  project: Project,
  options: PipelineOptions,
  completeness: string | null,
): {
  result: FindingsEngineResult;
  records: AnalysisRecords;
  facts: ReturnType<typeof buildFacts>;
  analysis: AnalysisInfo;
} {
  const sources = new Map<string, LoadedSource>();

  for (const file of records.files) {
    if (options.withhold?.includes(file.path)) continue;
    const content = options.override?.[file.path] ?? project[file.path];
    if (content === undefined) continue;
    sources.set(file.path, { content, contentHash: sha(content) });
  }

  const facts = buildFacts(records, sources);
  const analysis: AnalysisInfo = {
    id: "analysis-1",
    snapshotId: "snapshot-1",
    repositoryId: "repo-1",
    status: completeness === "COMPLETE" ? "COMPLETED" : "PARTIAL",
    snapshotCompleteness: completeness,
    complete: completeness === "COMPLETE",
  };

  const result = runRules(options.rules ?? RULE_CATALOGUE, {
    analysis,
    records,
    thresholds: resolveThresholds(options.thresholds),
    facts: facts.facts,
    factsMissing: facts.missing,
  });

  return { result, records, facts, analysis };
}

export function ids(result: FindingsEngineResult): string[] {
  return result.findings.map((f) => f.ruleId);
}
