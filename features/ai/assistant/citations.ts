// features/ai/assistant/citations.ts
//
// Citation validation and grounding. The model only *proposes* citations by
// evidence id; the platform decides whether they hold. A citation is accepted
// only if its evidence id was supplied in this request, and any line range
// lies inside the range that evidence actually covers. The model never
// certifies its own references. Certainty is derived here from the cited
// evidence, so a possible relationship cannot be presented as confirmed.
import type {
  AnswerSection,
  AssistantAnswer,
  Citation,
  EvidenceCertainty,
  EvidenceItem,
  SectionCertainty,
  SnapshotScope,
  SourceReference,
} from "./contracts";
import type { RawAnswer, RawCitation } from "./answer";

export const INSUFFICIENT_EVIDENCE_TEXT =
  "The platform cannot establish an answer to this question from the evidence available in the selected snapshot.";

const WEAK: EvidenceCertainty[] = [
  "POSSIBLE",
  "AMBIGUOUS",
  "UNRESOLVED",
  "INDICATOR",
];

const PATH_TOKEN =
  /(?:[A-Za-z0-9_@.-]+\/)*[A-Za-z0-9_@-][A-Za-z0-9_@.-]*\.(?:tsx?|jsx?|mjs|cjs|json|md|prisma|sql|css|ya?ml)\b/g;

function label(item: EvidenceItem, start: number | null, end: number | null) {
  if (item.path && start !== null && end !== null) {
    return start === end
      ? `${item.path}:${start}`
      : `${item.path}:${start}-${end}`;
  }
  return item.path ?? item.title;
}

function isLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function validateCitation(
  raw: RawCitation,
  byId: Map<string, EvidenceItem>,
  scope: SnapshotScope,
): Citation | null {
  const item = byId.get(raw.evidence);
  if (!item) return null; // fabricated or foreign evidence id

  let start = item.startLine;
  let end = item.endLine;

  const hasRange = raw.startLine !== undefined || raw.endLine !== undefined;
  if (hasRange) {
    if (start === null || end === null) return null; // nothing to range over
    const from = raw.startLine ?? raw.endLine;
    const to = raw.endLine ?? raw.startLine;
    if (!isLine(from) || !isLine(to) || from > to) return null;
    if (from < start || to > end) return null; // outside retrieved evidence
    start = from;
    end = to;
  }

  return {
    evidenceId: item.id,
    kind: item.kind,
    path: item.path,
    startLine: start,
    endLine: end,
    symbolKey: item.symbolKey,
    certainty: item.certainty,
    snapshotId: scope.snapshotId,
    analysisId: scope.analysisId,
    commitSha: scope.commitSha,
    label: label(item, start, end),
  };
}

function sectionCertainty(citations: Citation[]): SectionCertainty {
  if (citations.length === 0) return "NOT_SUPPORTED";
  return citations.some((c) => WEAK.includes(c.certainty))
    ? "POSSIBLE"
    : "ESTABLISHED";
}

/** Paths named in prose that no supplied evidence covers are fabrications. */
function mentionsUnknownPath(text: string, known: Set<string>): boolean {
  const names = new Set<string>();
  for (const path of known) {
    names.add(path.toLowerCase());
    names.add((path.split("/").pop() ?? path).toLowerCase());
  }
  for (const match of text.match(PATH_TOKEN) ?? []) {
    const lower = match.toLowerCase();
    const base = lower.split("/").pop() ?? lower;
    if (!names.has(lower) && !names.has(base)) return true;
  }
  return false;
}

export function insufficientAnswer(
  scope: SnapshotScope,
  limitations: string[] = [],
  extras: Partial<
    Pick<AssistantAnswer, "removedClaims" | "rejectedCitations">
  > = {},
): AssistantAnswer {
  return {
    status: "INSUFFICIENT_EVIDENCE",
    sections: [
      {
        type: "uncertainty",
        text: INSUFFICIENT_EVIDENCE_TEXT,
        certainty: "NOT_SUPPORTED",
        citations: [],
      },
    ],
    references: [],
    limitations: withCompleteness(scope, limitations),
    removedClaims: extras.removedClaims ?? 0,
    rejectedCitations: extras.rejectedCitations ?? 0,
    scope,
  };
}

function withCompleteness(scope: SnapshotScope, limitations: string[]) {
  const out = [...limitations];
  if (scope.completeness && scope.completeness !== "COMPLETE") {
    out.unshift(
      "The selected snapshot is incomplete, so this answer may not cover the whole repository.",
    );
  }
  return out;
}

export function validateAnswer(
  raw: RawAnswer,
  items: EvidenceItem[],
  scope: SnapshotScope,
): AssistantAnswer {
  const byId = new Map(items.map((item) => [item.id, item]));
  const knownPaths = new Set(
    items.map((item) => item.path).filter((p): p is string => !!p),
  );

  const sections: AnswerSection[] = [];
  let removedClaims = 0;
  let rejectedCitations = 0;

  for (const section of raw.sections) {
    const seen = new Set<string>();
    const citations: Citation[] = [];
    for (const proposed of section.citations) {
      const valid = validateCitation(proposed, byId, scope);
      if (!valid) {
        rejectedCitations += 1;
        continue;
      }
      const key = `${valid.evidenceId}:${valid.startLine}:${valid.endLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(valid);
    }

    if (
      section.type !== "uncertainty" &&
      mentionsUnknownPath(section.text, knownPaths)
    ) {
      removedClaims += 1;
      continue;
    }
    if (section.type === "fact" && citations.length === 0) {
      removedClaims += 1;
      continue;
    }

    sections.push({
      type: section.type,
      text: section.text,
      certainty:
        section.type === "uncertainty"
          ? "NOT_SUPPORTED"
          : sectionCertainty(citations),
      citations,
    });
  }

  const supported = sections.some(
    (s) => s.type !== "uncertainty" && s.citations.length > 0,
  );

  if (!raw.answerable || !supported) {
    const extra = sections
      .filter((s) => s.type === "uncertainty")
      .map((s) => s.text);
    return insufficientAnswer(scope, [...raw.limitations, ...extra], {
      removedClaims,
      rejectedCitations,
    });
  }

  const references = new Map<string, SourceReference>();
  sections.forEach((section, index) => {
    for (const citation of section.citations) {
      const key = `${citation.evidenceId}:${citation.startLine}:${citation.endLine}`;
      const existing = references.get(key);
      if (existing) existing.sections.push(index);
      else references.set(key, { ...citation, sections: [index] });
    }
  });

  return {
    status: "ANSWERED",
    sections,
    references: [...references.values()].sort(
      (a, b) =>
        (a.path ?? "￿").localeCompare(b.path ?? "￿") ||
        (a.startLine ?? 0) - (b.startLine ?? 0),
    ),
    limitations: withCompleteness(scope, raw.limitations),
    removedClaims,
    rejectedCitations,
    scope,
  };
}
