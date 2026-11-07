// features/explorer/overview-state.ts
//
// Turns "which snapshot / analysis is selected" into one explicit state, so
// partial, failed, running and empty situations are never silently shown as
// a healthy repository.

export type OverviewStateKind =
  | "no_snapshot"
  | "snapshot_not_ready"
  | "no_analysis"
  | "analysis_running"
  | "analysis_failed"
  | "ready_partial"
  | "ready";

export interface OverviewState {
  kind: OverviewStateKind;
  title: string;
  message: string;
  /** Files, symbols, graph and search have persisted data to show. */
  explorable: boolean;
  tone: "info" | "error" | "success" | "loading";
}

export interface OverviewStateInput {
  snapshot: { status: string; completeness: string | null } | null;
  analysis: {
    status: string;
    snapshotCompleteness: string | null;
    errorMessage: string | null;
  } | null;
}

export function deriveOverviewState(input: OverviewStateInput): OverviewState {
  const { snapshot, analysis } = input;

  if (!snapshot) {
    return {
      kind: "no_snapshot",
      title: "No source snapshot yet",
      message:
        "Ingest this repository from the dashboard to create a snapshot that can be analysed.",
      explorable: false,
      tone: "info",
    };
  }

  if (snapshot.status !== "COMPLETED") {
    const failed = snapshot.status === "FAILED";
    return {
      kind: "snapshot_not_ready",
      title: failed ? "Snapshot failed" : "Snapshot is still being created",
      message: failed
        ? "No usable source files were stored for this commit, so it cannot be explored."
        : "Source ingestion has not finished for this commit.",
      explorable: false,
      tone: failed ? "error" : "loading",
    };
  }

  if (!analysis) {
    return {
      kind: "no_analysis",
      title: "This snapshot has not been analysed",
      message:
        "Run an analysis for this snapshot to explore its files, symbols and dependencies.",
      explorable: false,
      tone: "info",
    };
  }

  if (analysis.status === "PENDING" || analysis.status === "PROCESSING") {
    return {
      kind: "analysis_running",
      title: "Analysis in progress",
      message: "Results will appear here when the analysis finishes.",
      explorable: false,
      tone: "loading",
    };
  }

  if (analysis.status === "FAILED") {
    return {
      kind: "analysis_failed",
      title: "Analysis failed",
      message:
        analysis.errorMessage ??
        "The analysis did not complete, so no results are available for it.",
      explorable: false,
      tone: "error",
    };
  }

  if (
    analysis.status === "PARTIAL" ||
    analysis.snapshotCompleteness === "PARTIAL"
  ) {
    return {
      kind: "ready_partial",
      title: "Results are partial",
      message:
        "Some files were skipped, could not be retrieved or could not be analysed. Missing files are marked in the file explorer, and relationships involving them may be absent.",
      explorable: true,
      tone: "info",
    };
  }

  return {
    kind: "ready",
    title: "Analysis complete",
    message: "All eligible files were analysed.",
    explorable: true,
    tone: "success",
  };
}
