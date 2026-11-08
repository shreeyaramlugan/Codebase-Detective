// lib/findings/findings.runner.ts
//
// Orchestrates one findings run end to end:
//   authorise + load analysis -> create run -> load persisted records ->
//   read hash-verified sources -> build facts -> run rules -> persist atomically.
//
// Findings are derived only from the persisted Sprint 03 records of the chosen
// analysis (plus syntax facts from that snapshot's hash-verified content).
// Every call creates a NEW run; previous runs are never modified. A failure
// after the run exists is recorded on that run so it stays inspectable.
import type { AnalysisRecords } from "@/features/code-intelligence/contracts";
import { resolveThresholds, ThresholdError } from "@/features/findings/config";
import {
  FINDINGS_ENGINE_VERSION,
  RULE_CATALOGUE_VERSION,
  type AnalysisInfo,
  type FindingsEngineResult,
} from "@/features/findings/contracts";
import { runRules } from "@/features/findings/engine/run-rules";
import {
  buildFacts,
  type LoadedSource,
} from "@/features/findings/facts/build-facts";
import { RULE_CATALOGUE } from "@/features/findings/rules";
import { ANALYSIS_LIMITS } from "@/features/code-intelligence/contracts";
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";

import { FindingsError } from "./findings.errors";
import type { FindingsStore } from "./findings.store";

export interface AnalysisHeader {
  id: string;
  snapshotId: string;
  repositoryId: string;
  status: string;
  snapshotCompleteness: string | null;
}

export interface SourceRef {
  path: string;
  storageKey: string | null;
  contentHash: string | null;
}

export interface FindingsReader {
  /** Must scope the lookup to the owning user. */
  findOwnedAnalysis(
    userId: string,
    analysisId: string,
  ): Promise<AnalysisHeader | null>;
  loadRecords(analysisId: string): Promise<AnalysisRecords>;
  listSourceRefs(snapshotId: string): Promise<SourceRef[]>;
}

export interface FindingsRunDependencies {
  reader: FindingsReader;
  storage: SourceStorage;
  store: FindingsStore;
}

export interface FindingsRunResult {
  runId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  errorCode: string | null;
}

const READ_CONCURRENCY = 8;
export const MAX_COVERAGE_ENTRIES = 5_000;

export function summariseFindings(result: FindingsEngineResult) {
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byCertainty: Record<string, number> = {};
  const byRule: Record<string, number> = {};

  for (const finding of result.findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    byCertainty[finding.certainty] = (byCertainty[finding.certainty] ?? 0) + 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
  }

  return {
    total: result.findings.length,
    bySeverity,
    byCategory,
    byCertainty,
    byRule,
    rulesCompleted: result.ruleRuns.filter((r) => r.status === "COMPLETED")
      .length,
    rulesSkipped: result.ruleRuns.filter((r) => r.status === "SKIPPED").length,
    rulesFailed: result.ruleRuns.filter((r) => r.status === "FAILED").length,
  };
}

async function loadSources(
  deps: FindingsRunDependencies,
  records: AnalysisRecords,
  refs: SourceRef[],
): Promise<Map<string, LoadedSource>> {
  const refByPath = new Map(refs.map((ref) => [ref.path, ref]));
  const sources = new Map<string, LoadedSource>();

  const wanted = records.files.filter(
    (file) =>
      file.scriptKind !== null &&
      (file.status === "ANALYSED" || file.status === "ANALYSED_WITH_ERRORS") &&
      file.sizeBytes <= ANALYSIS_LIMITS.MAX_FILE_BYTES,
  );

  let next = 0;

  const worker = async () => {
    while (next < wanted.length) {
      const file = wanted[next++];
      const ref = refByPath.get(file.path);
      if (!ref?.storageKey || !ref.contentHash) continue;

      try {
        // The adapter verifies the content hash on every read.
        const buffer = await deps.storage.get(ref.storageKey, ref.contentHash);
        sources.set(file.path, {
          content: buffer.toString("utf8"),
          contentHash: ref.contentHash,
        });
      } catch {
        // Left out of the map: reported as "source not available".
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, wanted.length) }, worker),
  );

  return sources;
}

export async function runFindingsForAnalysis(
  deps: FindingsRunDependencies,
  request: { userId: string; analysisId: string; thresholds?: unknown },
): Promise<FindingsRunResult> {
  let thresholds;
  try {
    thresholds = resolveThresholds(request.thresholds ?? {});
  } catch (error) {
    if (error instanceof ThresholdError) {
      throw new FindingsError(error.message, "INVALID_INPUT");
    }
    throw error;
  }

  const analysis = await deps.reader.findOwnedAnalysis(
    request.userId,
    request.analysisId,
  );

  if (!analysis) throw new FindingsError("Analysis not found.", "NOT_FOUND");

  // Findings are never produced from an unfinished or failed analysis.
  if (analysis.status !== "COMPLETED" && analysis.status !== "PARTIAL") {
    throw new FindingsError(
      "This analysis has not finished, so findings cannot be generated.",
      "ANALYSIS_NOT_READY",
    );
  }

  const run = await deps.store.createRun({
    analysisId: analysis.id,
    repositoryId: analysis.repositoryId,
    requestedById: request.userId,
    engineVersion: FINDINGS_ENGINE_VERSION,
    catalogueVersion: RULE_CATALOGUE_VERSION,
    thresholds,
  });

  try {
    await deps.store.markProcessing(run.id);

    const records = await deps.reader.loadRecords(analysis.id);
    const refs = await deps.reader.listSourceRefs(analysis.snapshotId);
    const sources = await loadSources(deps, records, refs);
    const facts = buildFacts(records, sources);

    const info: AnalysisInfo = {
      id: analysis.id,
      snapshotId: analysis.snapshotId,
      repositoryId: analysis.repositoryId,
      status: analysis.status,
      snapshotCompleteness: analysis.snapshotCompleteness,
      complete:
        analysis.status === "COMPLETED" &&
        analysis.snapshotCompleteness === "COMPLETE",
    };

    const result = runRules(RULE_CATALOGUE, {
      analysis: info,
      records,
      thresholds,
      facts: facts.facts,
      factsMissing: facts.missing,
    });

    const missing = [...facts.missing.entries()].sort((a, b) =>
      a[0].localeCompare(b[0]),
    );

    await deps.store.persistResults(run.id, {
      status: result.outcome,
      result,
      stats: summariseFindings(result),
      coverage: {
        factsMissing: Object.fromEntries(
          missing.slice(0, MAX_COVERAGE_ENTRIES),
        ),
        truncated: missing.length > MAX_COVERAGE_ENTRIES,
      },
    });

    return { runId: run.id, status: result.outcome, errorCode: null };
  } catch (error) {
    // Internal detail stays in the server log; the stored message is generic.
    console.error("Findings run failed:", error);

    try {
      await deps.store.markFailed(run.id, {
        errorCode: "FINDINGS_RUN_FAILED",
        errorMessage: "The findings run could not be completed.",
      });
    } catch (markError) {
      console.error("Could not record findings failure:", markError);
    }

    return {
      runId: run.id,
      status: "FAILED",
      errorCode: "FINDINGS_RUN_FAILED",
    };
  }
}
