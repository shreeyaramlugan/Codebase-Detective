// features/research/engine/evaluate.ts
//
// Source evaluation: relevance, authority and freshness, plus the plain-language
// notes shown to the user. Scores only rank sources; they never upgrade what a
// source is (a preprint stays a preprint, an abstract stays an abstract).
import type {
  EvaluatedSource,
  Passage,
  ResearchLimits,
  SourceEvaluation,
  SourceRecord,
} from "./contracts";
import { extractPassages, keywords } from "./html";

export const MIN_SCHOLARLY_RELEVANCE = 0.1;

export function relevanceOf(record: SourceRecord, queryText: string): number {
  const terms = keywords(queryText);
  if (terms.length === 0) return 0;
  const title = record.title.toLowerCase();
  const body = `${record.container ?? ""} ${record.excerpt}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 2;
    else if (body.includes(term)) score += 1;
  }
  return Math.min(1, score / (terms.length * 2));
}

const AUTHORITY: Record<SourceRecord["sourceClass"], number> = {
  OFFICIAL: 1,
  PEER_REVIEWED: 0.8,
  PREPRINT: 0.5,
  OTHER_SCHOLARLY: 0.4,
};

export function freshnessOf(
  record: SourceRecord,
  now: Date,
  datedAfterYears: number,
): SourceEvaluation["freshness"] {
  const date = record.updatedAt ?? record.publishedAt;
  if (!date) return "UNKNOWN";
  const time = Date.parse(date);
  if (Number.isNaN(time)) return "UNKNOWN";
  const ageYears = (now.getTime() - time) / (365.25 * 86_400_000);
  return ageYears > datedAfterYears ? "DATED" : "CURRENT";
}

export function evaluateSource(
  record: SourceRecord,
  queryText: string,
  now: Date,
  limits: Pick<ResearchLimits, "datedAfterYears">,
): SourceEvaluation {
  const relevance = relevanceOf(record, queryText);
  let authority = AUTHORITY[record.sourceClass];
  if (record.contentLevel === "METADATA_ONLY") authority -= 0.1;
  const freshness = freshnessOf(record, now, limits.datedAfterYears);
  const freshnessScore = freshness === "CURRENT" ? 1 : freshness === "UNKNOWN" ? 0.5 : 0.3;
  let score = 0.5 * relevance + 0.35 * authority + 0.15 * freshnessScore;
  if (record.availability === "UNAVAILABLE") score *= 0.2;

  const notes: string[] = [];
  if (record.availability === "UNAVAILABLE") notes.push("The page could not be retrieved; only its address is recorded.");
  if (record.sourceClass === "PREPRINT") notes.push("Preprint: not peer reviewed.");
  if (record.sourceClass === "OTHER_SCHOLARLY") notes.push("Scholarly material that is neither a journal/conference article nor a preprint.");
  if (record.sourceClass === "PEER_REVIEWED") notes.push("Classified as peer reviewed from its publication type; peer review itself was not verified.");
  if (record.kind === "SCHOLARLY") {
    if (record.contentLevel === "ABSTRACT") notes.push("Abstract only: the full text was not reviewed.");
    if (record.contentLevel === "METADATA_ONLY") notes.push("Metadata only: neither an abstract nor the full text was reviewed.");
  }
  if (freshness === "DATED") notes.push(`Dated: last reported ${record.updatedAt ?? record.publishedAt}.`);
  if (freshness === "UNKNOWN" && record.availability !== "UNAVAILABLE") notes.push("No publication or update date was reported.");

  return {
    relevance: round(relevance),
    authority: round(Math.max(0, authority)),
    freshness,
    score: round(score),
    notes,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function buildPassages(
  sections: Array<{ heading: string; text: string }>,
  queryText: string,
  queryOrdinal: number,
  limits: Pick<ResearchLimits, "maxPassagesPerSource" | "maxPassageChars">,
): Passage[] {
  return extractPassages(sections, queryText, limits.maxPassagesPerSource, limits.maxPassageChars).map(
    (p, index) => ({ ordinal: index + 1, text: p.text, locator: p.locator, queryOrdinal }),
  );
}

/** Ranking order: score, then authority, then key - fully deterministic. */
export function compareEvaluated(a: EvaluatedSource, b: EvaluatedSource): number {
  return (
    b.evaluation.score - a.evaluation.score ||
    b.evaluation.authority - a.evaluation.authority ||
    a.record.sourceKey.localeCompare(b.record.sourceKey)
  );
}
