// features/ai/assistant/context.ts
//
// Builds the bounded evidence package sent to the provider. Ranking is
// deterministic; ids are assigned after ranking so identical inputs give
// identical prompts. Secrets are redacted here, once, for every kind.
import type {
  EvidenceCandidate,
  EvidenceItem,
  RetrievalSummary,
} from "./contracts";
import { redactSecrets } from "./redact";

const PER_ITEM_CHARS: Record<EvidenceCandidate["kind"], number> = {
  source: 3_200,
  document: 2_400,
  symbol: 900,
  dependency: 900,
  call: 900,
  finding: 1_400,
  repository: 1_200,
};

export interface ContextPackage {
  items: EvidenceItem[];
  summary: Omit<RetrievalSummary, "category" | "terms">;
  /** True when something other than repository metadata was retrieved. */
  substantive: boolean;
}

function compareCandidates(a: EvidenceCandidate, b: EvidenceCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const path = (a.path ?? "").localeCompare(b.path ?? "");
  if (path !== 0) return path;
  const line = (a.startLine ?? 0) - (b.startLine ?? 0);
  if (line !== 0) return line;
  const kind = a.kind.localeCompare(b.kind);
  if (kind !== 0) return kind;
  return a.title.localeCompare(b.title);
}

/** Truncates by whole lines so a cited line range always matches the text. */
function fit(candidate: EvidenceCandidate, cap: number): EvidenceCandidate {
  const { text: redacted } = redactSecrets(candidate.text);
  if (redacted.length <= cap) return { ...candidate, text: redacted };

  if (candidate.kind === "source" || candidate.kind === "document") {
    const kept: string[] = [];
    let size = 0;
    for (const line of redacted.split("\n")) {
      if (size + line.length + 1 > cap && kept.length > 0) break;
      kept.push(line.slice(0, cap));
      size += line.length + 1;
    }
    const first = candidate.startLine ?? 1;
    return {
      ...candidate,
      text: kept.join("\n"),
      endLine: first + kept.length - 1,
    };
  }
  return { ...candidate, text: `${redacted.slice(0, cap - 1)}…` };
}

export function assembleContext(
  candidates: EvidenceCandidate[],
  maxChars: number,
): ContextPackage {
  const ranked = [...candidates].sort(compareCandidates);
  const items: EvidenceItem[] = [];
  const seen = new Set<string>();
  let used = 0;
  let dropped = 0;
  let truncated = false;

  for (const candidate of ranked) {
    const fingerprint = [
      candidate.kind,
      candidate.path,
      candidate.startLine,
      candidate.endLine,
      candidate.title,
    ].join("|");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    const fitted = fit(candidate, PER_ITEM_CHARS[candidate.kind]);
    if (fitted.text !== candidate.text) truncated = true;
    const cost = fitted.text.length + fitted.title.length + 120;

    if (used + cost > maxChars) {
      dropped += 1;
      truncated = true;
      continue;
    }
    used += cost;
    items.push({ ...fitted, id: `E${items.length + 1}` });
  }

  return {
    items,
    substantive: items.some((item) => item.kind !== "repository"),
    summary: {
      evidenceCount: items.length,
      usedChars: used,
      truncated,
      droppedCount: dropped,
      evidenceIds: items.map((item) => item.id),
    },
  };
}
