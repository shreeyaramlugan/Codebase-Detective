// features/research/engine/contracts.ts
//
// Sprint 07 research-engine contracts. The Sprint 01 stubs in
// features/research/{providers,citations,retrieval} are left untouched; this
// engine supersedes them with a richer, provenance-preserving model.
export const RESEARCH_ENGINE_VERSION = "1.0.0";

export type SourceKind = "OFFICIAL_DOCUMENTATION" | "SCHOLARLY";

/**
 * Classification of a source. SCHOLARLY classes are inferred from the
 * publication type reported by Crossref/OpenAlex; the platform does not verify
 * peer review itself (see classificationBasis).
 */
export type SourceClass =
  | "OFFICIAL"
  | "PEER_REVIEWED"
  | "PREPRINT"
  | "OTHER_SCHOLARLY";

/** What the platform actually holds for a source. Never implies more. */
export type ContentLevel = "FULL_TEXT" | "ABSTRACT" | "METADATA_ONLY";

export type Availability = "AVAILABLE" | "UNAVAILABLE" | "UNVERIFIED";

export interface SourceRecord {
  /** Stable identity: doi:<doi> | url:<canonical url> hashed (see identity.ts). */
  sourceKey: string;
  kind: SourceKind;
  sourceClass: SourceClass;
  /** How sourceClass was decided, shown to the user. */
  classificationBasis: string;
  title: string;
  publisher: string;
  authors: string[];
  container: string | null;
  canonicalUrl: string;
  doi: string | null;
  /** Provider identifiers, e.g. { openalex: "W123" }. */
  externalIds: Record<string, string>;
  publishedAt: string | null;
  /** Last-updated date reported by the source itself, if any. */
  updatedAt: string | null;
  contentLevel: ContentLevel;
  availability: Availability;
  /** True only when the DOI was returned by a provider (never model-supplied). */
  doiFromProvider: boolean;
  /** Provider that produced this record. */
  provider: string;
  retrievedAt: string;
  /** Abstract or short page summary, <= EXCERPT_CACHE_CHARS. Never full text. */
  excerpt: string;
  contentHash: string | null;
  /** Open-access flag from the provider (scholarly only). */
  openAccess: boolean | null;
  license: string | null;
  citedByCount: number | null;
}

export interface Passage {
  ordinal: number;
  text: string;
  /** Where in the source the passage comes from (e.g. "abstract", "section: Cycles"). */
  locator: string;
  queryOrdinal: number;
}

export interface SourceEvaluation {
  relevance: number; // 0..1
  authority: number; // 0..1
  freshness: "CURRENT" | "DATED" | "UNKNOWN";
  score: number; // 0..1 overall, used for ranking only
  notes: string[];
}

export interface EvaluatedSource {
  record: SourceRecord;
  evaluation: SourceEvaluation;
  passages: Passage[];
  /** Query ordinals that surfaced this source. */
  queryOrdinals: number[];
  /** True when metadata/excerpt came from the reuse cache rather than a fetch. */
  reused: boolean;
}

export interface QueryPlan {
  ordinal: number;
  text: string;
  /** Short natural-language reason shown with the sources it retrieves. */
  rationale: string;
  targets: Array<"OFFICIAL_DOCUMENTATION" | "CROSSREF" | "OPENALEX">;
}

export type ProviderName = "official-docs" | "crossref" | "openalex";

export interface ProviderDiagnostic {
  provider: ProviderName;
  queryOrdinal: number;
  status: "OK" | "EMPTY" | "RATE_LIMITED" | "TIMEOUT" | "UNAVAILABLE" | "SKIPPED";
  returned: number;
  durationMs: number;
  /** Safe, user-displayable note. Never contains headers, URLs with secrets or raw bodies. */
  note: string | null;
}

export interface ResearchLimits {
  maxQueriesPerRun: number;
  maxSourcesPerQuery: number;
  maxSourcesPerRun: number;
  maxPassagesPerSource: number;
  maxPassageChars: number;
  maxSynthesisContextChars: number;
  maxOutputTokens: number;
  discoveryDeadlineMs: number;
  providerTimeoutMs: number;
  dailyRunLimit: number;
  dailySynthesisLimit: number;
  dailyTokenLimit: number;
  dailyProviderRequestLimit: number;
  /** Re-fetch a cached source only when older than this many days. */
  officialCacheDays: number;
  scholarlyCacheDays: number;
  /** Official docs older than this are labelled DATED. */
  datedAfterYears: number;
}

export const EXCERPT_CACHE_CHARS = 4_000;
