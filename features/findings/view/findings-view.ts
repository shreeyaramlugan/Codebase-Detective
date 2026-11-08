// features/findings/view/findings-view.ts
//
// Pure view-model helpers for the findings dashboard: labels, tones, filter
// serialisation and source navigation. No React, no network.
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import { isSafeRepositoryPath } from "@/features/explorer/navigation/explorer-url";
import {
  FINDING_CATEGORIES,
  FINDING_CERTAINTIES,
  SEVERITY_ORDER,
  type FindingCategory,
  type FindingCertainty,
  type FindingSeverity,
} from "../contracts";

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent";

export const SEVERITY_LABELS: Record<FindingSeverity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Info",
};

export function severityTone(severity: string): Tone {
  switch (severity) {
    case "CRITICAL":
    case "HIGH":
      return "bad";
    case "MEDIUM":
      return "warn";
    case "LOW":
      return "info";
    default:
      return "neutral";
  }
}

export const CATEGORY_LABELS: Record<FindingCategory, string> = {
  DEPENDENCY: "Dependency",
  COMPLEXITY: "Complexity",
  STRUCTURE: "Structure",
  SECURITY: "Security indicator",
};

export const CERTAINTY_LABELS: Record<FindingCertainty, string> = {
  CONFIRMED: "Confirmed fact",
  MEASURED: "Measured",
  INDICATOR: "Indicator only",
};

/** What each certainty does and does not claim. Shown beside every finding. */
export const CERTAINTY_EXPLANATIONS: Record<FindingCertainty, string> = {
  CONFIRMED:
    "A recorded fact of the analysis, such as an import that did not resolve.",
  MEASURED:
    "A measurement that exceeds a configured threshold. Thresholds are conventions, not defects.",
  INDICATOR:
    "A static pattern worth reviewing. It is not a confirmed vulnerability: reachability and exploitability are not analysed.",
};

export function certaintyTone(certainty: string): Tone {
  return certainty === "INDICATOR"
    ? "warn"
    : certainty === "CONFIRMED"
      ? "good"
      : "info";
}

export function labelFor(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}

export const STATUS_LABELS: Record<string, string> = {
  NEW: "New",
  PERSISTENT: "Persistent",
  RESOLVED: "Resolved",
  UNVERIFIED: "Unverified",
  NOT_COMPARABLE: "Not comparable",
};

export function statusTone(status: string): Tone {
  switch (status) {
    case "NEW":
      return "bad";
    case "RESOLVED":
      return "good";
    case "UNVERIFIED":
    case "NOT_COMPARABLE":
      return "warn";
    default:
      return "neutral";
  }
}

export const REVIEW_LABELS: Record<string, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  DISMISSED: "Dismissed",
};

export interface FindingsFilterState {
  severities: string[];
  categories: string[];
  certainties: string[];
  review: string;
  q: string;
}

export const EMPTY_FILTERS: FindingsFilterState = {
  severities: [],
  categories: [],
  certainties: [],
  review: "",
  q: "",
};

export function hasActiveFilters(filters: FindingsFilterState): boolean {
  return (
    filters.severities.length > 0 ||
    filters.categories.length > 0 ||
    filters.certainties.length > 0 ||
    filters.review !== "" ||
    filters.q.trim() !== ""
  );
}

/** Only allow-listed values ever reach the query string. */
export function findingsQuery(
  filters: FindingsFilterState,
  cursor: string | null = null,
  limit = 50,
): string {
  const params = new URLSearchParams();
  const pick = (values: string[], allowed: readonly string[]) =>
    values.filter((value) => allowed.includes(value));

  const severities = pick(filters.severities, SEVERITY_ORDER);
  const categories = pick(filters.categories, FINDING_CATEGORIES);
  const certainties = pick(filters.certainties, FINDING_CERTAINTIES);

  if (severities.length) params.set("severity", severities.join(","));
  if (categories.length) params.set("category", categories.join(","));
  if (certainties.length) params.set("certainty", certainties.join(","));
  if (["OPEN", "ACKNOWLEDGED", "DISMISSED"].includes(filters.review)) {
    params.set("review", filters.review);
  }
  const q = filters.q.trim().slice(0, 100);
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function toggle(values: string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

export interface EvidenceLike {
  filePath: string;
  startLine: number | null;
}

/**
 * Navigation patch that opens the evidence in the explorer's source viewer.
 * Returns null when the path is not safe, so a bad value never becomes a link.
 */
export function sourceNavigation(
  evidence: EvidenceLike,
): Partial<ExplorerState> | null {
  if (!isSafeRepositoryPath(evidence.filePath)) return null;
  const line =
    evidence.startLine !== null &&
    Number.isInteger(evidence.startLine) &&
    evidence.startLine >= 1
      ? evidence.startLine
      : null;
  return { view: "files", file: evidence.filePath, line, finding: null };
}

export function formatLocation(evidence: {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (evidence.startLine === null) return evidence.filePath;
  return evidence.endLine !== null && evidence.endLine !== evidence.startLine
    ? `${evidence.filePath}:${evidence.startLine}-${evidence.endLine}`
    : `${evidence.filePath}:${evidence.startLine}`;
}

export interface RunStateView {
  tone: Tone;
  title: string;
  message: string | null;
}

/** The headline a run gets. Partial runs never read as "all clear". */
export function describeRun(
  run: {
    status: string;
    limitations: string[];
    errorMessage: string | null;
  },
  total: number,
): RunStateView {
  if (run.status === "FAILED") {
    return {
      tone: "bad",
      title: "Findings run failed",
      message: run.errorMessage ?? "The run could not be completed.",
    };
  }
  if (run.status === "PENDING" || run.status === "PROCESSING") {
    return { tone: "info", title: "Findings run in progress", message: null };
  }
  if (run.status === "PARTIAL") {
    return {
      tone: "warn",
      title:
        total === 0
          ? "No findings, but the run was incomplete"
          : "Findings from an incomplete run",
      message:
        run.limitations[0] ??
        "Some evidence was unavailable, so absence of findings is not a clean result.",
    };
  }
  return {
    tone: total === 0 ? "good" : "info",
    title:
      total === 0 ? "No findings for the rules in this run" : "Run complete",
    message:
      total === 0
        ? "The deterministic rules found nothing. This does not prove the code is free of issues."
        : null,
  };
}
