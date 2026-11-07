// lib/analysis/analysis.runner.ts
//
// Orchestrates one analysis run end to end:
//   authorise + load snapshot -> create run -> read verified sources ->
//   analyse (pure engine) -> build + validate graph -> persist atomically.
//
// Every call creates a NEW run. A failure after the run exists is recorded on
// that run (status FAILED, error code, diagnostics) so it stays inspectable;
// previous runs are never touched.
import {
  ENGINE_VERSION,
  type DiagnosticRecord,
} from "@/features/code-intelligence/contracts";
import { analyzeSnapshotSources } from "@/features/code-intelligence/engine/analyze-snapshot";
import { buildGraph } from "@/features/code-intelligence/graph/build-graph";
import { validateGraph } from "@/features/code-intelligence/graph/validate-graph";
import { PARSER_VERSION } from "@/features/code-intelligence/parser/source-parser";
import type { SourceStorage } from "@/lib/ingestion/storage/storage.types";

import type { AnalysisStore } from "./analysis.store";
import {
  loadSnapshotSources,
  requireReadySnapshot,
  type SnapshotSourceReader,
} from "./snapshot-source";

export interface AnalysisRunDependencies {
  reader: SnapshotSourceReader;
  storage: SourceStorage;
  store: AnalysisStore;
}

export interface AnalysisRunResult {
  analysisId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  errorCode: string | null;
}

class GraphValidationError extends Error {
  constructor(public readonly issues: { code: string; message: string }[]) {
    super(`Graph validation failed: ${issues[0]?.message ?? "unknown issue"}`);
    this.name = "GraphValidationError";
  }
}

export async function runSnapshotAnalysis(
  deps: AnalysisRunDependencies,
  request: { userId: string; snapshotId: string },
): Promise<AnalysisRunResult> {
  // Throws NOT_FOUND / SNAPSHOT_NOT_READY before any run is created.
  const snapshot = await requireReadySnapshot(
    deps.reader,
    request.userId,
    request.snapshotId,
  );

  const run = await deps.store.createRun({
    snapshotId: snapshot.id,
    repositoryId: snapshot.repositoryId,
    requestedById: request.userId,
    commitSha: snapshot.commitSha,
    snapshotCompleteness: snapshot.completeness,
    engineVersion: ENGINE_VERSION,
    parserVersion: PARSER_VERSION,
  });

  try {
    await deps.store.markProcessing(run.id);

    const loaded = await loadSnapshotSources(
      deps.reader,
      deps.storage,
      snapshot,
    );
    const { records, stats } = analyzeSnapshotSources(loaded.input);

    const graph = buildGraph(records, {
      analysisId: run.id,
      snapshotId: snapshot.id,
      commitSha: snapshot.commitSha,
      snapshotCompleteness: snapshot.completeness,
      engineVersion: ENGINE_VERSION,
      parserVersion: PARSER_VERSION,
    });

    const issues = validateGraph(graph);
    if (issues.length > 0) throw new GraphValidationError(issues);

    // PARTIAL means the engine finished but not everything could be fully
    // analysed. It is never reported as COMPLETED.
    const partial =
      snapshot.completeness !== "COMPLETE" ||
      stats.filesFailed > 0 ||
      stats.filesSkipped > 0 ||
      stats.filesWithSyntaxErrors > 0;

    await deps.store.persistResults(run.id, {
      status: partial ? "PARTIAL" : "COMPLETED",
      records,
      graph,
      stats: { ...stats, snapshotExclusions: loaded.snapshotExclusions },
    });

    return {
      analysisId: run.id,
      status: partial ? "PARTIAL" : "COMPLETED",
      errorCode: null,
    };
  } catch (error) {
    const errorCode =
      error instanceof GraphValidationError
        ? "GRAPH_VALIDATION_FAILED"
        : error instanceof Error && error.name === "EngineConsistencyError"
          ? "ENGINE_CONSISTENCY_ERROR"
          : "ANALYSIS_FAILED";

    // Internal detail stays in the server log; the stored message is generic
    // so storage paths or driver errors are never exposed through the API.
    console.error("Code analysis failed:", error);

    const diagnostics: DiagnosticRecord[] = [
      {
        severity: "ERROR",
        source: error instanceof GraphValidationError ? "GRAPH" : "ENGINE",
        code: errorCode,
        message:
          error instanceof GraphValidationError
            ? error.message
            : "The analysis could not be completed.",
        path: null,
        line: null,
        column: null,
        details:
          error instanceof GraphValidationError
            ? { issues: error.issues.slice(0, 20) }
            : null,
      },
    ];

    try {
      await deps.store.markFailed(run.id, {
        errorCode,
        errorMessage: diagnostics[0].message,
        diagnostics,
        stats: null,
      });
    } catch (markError) {
      console.error("Failed to record analysis failure:", markError);
    }

    return { analysisId: run.id, status: "FAILED", errorCode };
  }
}
