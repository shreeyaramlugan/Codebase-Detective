// features/research/engine/providers/types.ts
import type {
  ProviderDiagnostic,
  ProviderName,
  QueryPlan,
  ResearchLimits,
  SourceRecord,
} from "../contracts";

export interface DiscoveryContext {
  limits: ResearchLimits;
  now: () => Date;
  /** Counts one outbound provider request against the daily allowance. */
  countRequest: () => Promise<void>;
  /**
   * Fresh cached record (within the cache window) for a canonical URL, so the
   * page need not be fetched again. Returns null when absent or stale.
   */
  findCached: (canonicalUrl: string) => Promise<SourceRecord | null>;
}

/** A raw discovered source before evaluation, optionally with page-derived sections. */
export interface DiscoveredSource {
  record: SourceRecord;
  /** Readable sections for passage extraction (docs pages, abstracts). */
  sections: Array<{ heading: string; text: string }>;
  reused: boolean;
}

export interface ProviderResult {
  sources: DiscoveredSource[];
  diagnostic: ProviderDiagnostic;
}

/** Research providers are abstracted so new sources need no engine changes. */
export interface SourceProvider {
  readonly name: ProviderName;
  discover(query: QueryPlan, ctx: DiscoveryContext): Promise<ProviderResult>;
}

export function emptyDiagnostic(
  provider: ProviderName,
  query: QueryPlan,
  status: ProviderDiagnostic["status"],
  note: string | null,
): ProviderDiagnostic {
  return { provider, queryOrdinal: query.ordinal, status, returned: 0, durationMs: 0, note };
}
