// features/ai/assistant/view.ts
//
// Client-safe helpers: citation navigation into the Sprint 04 explorer and
// small display labels. Navigation carries the *analysis* id (which is bound
// to exactly one snapshot) so a citation always opens the snapshot it cites.
import type { Citation } from "./contracts";

export function citationHref(repositoryId: string, c: Citation): string | null {
  if (!c.path) return null;
  const params = new URLSearchParams({
    view: "files",
    analysis: c.analysisId,
    file: c.path,
  });
  if (c.startLine !== null) params.set("line", String(c.startLine));
  return `/dashboard/repositories/${encodeURIComponent(repositoryId)}?${params}`;
}

export const CERTAINTY_LABELS: Record<string, string> = {
  CONFIRMED: "Confirmed",
  POSSIBLE: "Possible",
  AMBIGUOUS: "Ambiguous",
  UNRESOLVED: "Unresolved",
  INDICATOR: "Indicator",
  NOT_APPLICABLE: "Reference",
};

export const SECTION_LABELS = {
  ESTABLISHED: "Supported by evidence",
  POSSIBLE: "Possible - not confirmed",
  NOT_SUPPORTED: "Not directly supported",
} as const;
