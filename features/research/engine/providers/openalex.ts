// features/research/engine/providers/openalex.ts
//
// OpenAlex works API. Abstracts arrive as an inverted index and are rebuilt;
// open-access status and licence come straight from the record.
import type { QueryPlan, SourceRecord, SourceClass } from "../contracts";
import { EXCERPT_CACHE_CHARS } from "../contracts";
import { fetchBounded, type FetchLike } from "../http";
import { canonicalUrl, contentHash, doiUrl, normaliseDoi, sourceKey } from "../identity";
import { MinIntervalLimiter } from "../rate-limit";
import { failure } from "./crossref";
import type {
  DiscoveredSource,
  DiscoveryContext,
  ProviderResult,
  SourceProvider,
} from "./types";

const ENDPOINT = "https://api.openalex.org/works";

interface OpenAlexWork {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  display_name?: unknown;
  publication_date?: unknown;
  type?: unknown;
  authorships?: unknown;
  primary_location?: {
    landing_page_url?: unknown;
    version?: unknown;
    source?: { display_name?: unknown; type?: unknown; host_organization_name?: unknown } | null;
  } | null;
  open_access?: { is_oa?: unknown } | null;
  best_oa_location?: { license?: unknown } | null;
  abstract_inverted_index?: unknown;
  cited_by_count?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function rebuildAbstract(index: unknown): string {
  if (!index || typeof index !== "object") return "";
  const words: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (typeof p === "number" && p >= 0 && p < 10_000) words.push([p, word]);
  }
  return words.sort((a, b) => a[0] - b[0]).map(([, w]) => w).join(" ");
}

export function classifyOpenAlex(work: OpenAlexWork): { sourceClass: SourceClass; basis: string } {
  const type = str(work.type);
  const sourceType = str(work.primary_location?.source?.type);
  const version = str(work.primary_location?.version);
  if (type === "preprint" || (sourceType === "repository" && version === "submittedVersion")) {
    return { sourceClass: "PREPRINT", basis: `OpenAlex type ${type ?? "unknown"} / repository submitted version` };
  }
  if ((type === "article" || type === "review") && (sourceType === "journal" || sourceType === "conference")) {
    return {
      sourceClass: "PEER_REVIEWED",
      basis: `OpenAlex ${type} in a ${sourceType}; peer review is inferred from the venue type, not verified`,
    };
  }
  return { sourceClass: "OTHER_SCHOLARLY", basis: `OpenAlex type ${type ?? "unknown"}` };
}

export function parseOpenAlexWork(work: OpenAlexWork, retrievedAt: string): DiscoveredSource | null {
  const title = str(work.title) ?? str(work.display_name);
  const openalexId = str(work.id);
  if (!title || !openalexId) return null;
  const doi = normaliseDoi(str(work.doi));
  const landing = str(work.primary_location?.landing_page_url);
  const url = canonicalUrl(landing ?? (doi ? doiUrl(doi) : openalexId));
  if (!url) return null;

  const abstract = rebuildAbstract(work.abstract_inverted_index).slice(0, EXCERPT_CACHE_CHARS);
  const authors = Array.isArray(work.authorships)
    ? work.authorships
        .map((a) => str((a as { author?: { display_name?: unknown } }).author?.display_name))
        .filter((n): n is string => !!n)
        .slice(0, 12)
    : [];
  const { sourceClass, basis } = classifyOpenAlex(work);
  const isOa = typeof work.open_access?.is_oa === "boolean" ? work.open_access.is_oa : null;
  const date = str(work.publication_date);

  const record: SourceRecord = {
    sourceKey: sourceKey({ doi, canonicalUrl: url }),
    kind: "SCHOLARLY",
    sourceClass,
    classificationBasis: basis,
    title,
    publisher:
      str(work.primary_location?.source?.host_organization_name) ??
      str(work.primary_location?.source?.display_name) ??
      "Unknown publisher",
    authors,
    container: str(work.primary_location?.source?.display_name),
    canonicalUrl: url,
    doi,
    externalIds: { openalex: openalexId, ...(doi ? { doi } : {}) },
    publishedAt: date && !Number.isNaN(Date.parse(date)) ? date : null,
    updatedAt: null,
    contentLevel: abstract ? "ABSTRACT" : "METADATA_ONLY",
    availability: "UNVERIFIED",
    doiFromProvider: doi !== null,
    provider: "openalex",
    retrievedAt,
    excerpt: abstract,
    contentHash: abstract ? contentHash(abstract) : null,
    openAccess: isOa,
    license: str(work.best_oa_location?.license),
    citedByCount: typeof work.cited_by_count === "number" ? work.cited_by_count : null,
  };
  return { record, sections: abstract ? [{ heading: "abstract", text: abstract }] : [], reused: false };
}

export interface OpenAlexOptions {
  fetchImpl: FetchLike;
  contactEmail: string | null;
  limiter?: MinIntervalLimiter;
}

export class OpenAlexProvider implements SourceProvider {
  readonly name = "openalex" as const;
  private readonly limiter: MinIntervalLimiter;
  constructor(private readonly options: OpenAlexOptions) {
    this.limiter = options.limiter ?? new MinIntervalLimiter(250);
  }

  async discover(query: QueryPlan, ctx: DiscoveryContext): Promise<ProviderResult> {
    const started = Date.now();
    const params = new URLSearchParams({
      search: query.text,
      "per-page": String(ctx.limits.maxSourcesPerQuery),
      select:
        "id,doi,title,display_name,publication_date,type,authorships,primary_location,open_access,best_oa_location,abstract_inverted_index,cited_by_count",
    });
    if (this.options.contactEmail) params.set("mailto", this.options.contactEmail);
    try {
      await ctx.countRequest();
      await this.limiter.acquire();
      const body = await fetchBounded(`${ENDPOINT}?${params}`, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: ctx.limits.providerTimeoutMs,
        maxBytes: 3_000_000,
        accept: "application/json",
        hostAllowed: (u) => u.hostname === "api.openalex.org",
      });
      const json = JSON.parse(body.text) as { results?: unknown };
      const results = Array.isArray(json.results) ? (json.results as OpenAlexWork[]) : [];
      const retrievedAt = ctx.now().toISOString();
      const sources = results
        .map((w) => parseOpenAlexWork(w, retrievedAt))
        .filter((s): s is DiscoveredSource => s !== null);
      return {
        sources,
        diagnostic: {
          provider: this.name,
          queryOrdinal: query.ordinal,
          status: sources.length ? "OK" : "EMPTY",
          returned: sources.length,
          durationMs: Date.now() - started,
          note: null,
        },
      };
    } catch (error) {
      return failure(this.name, query, error, started);
    }
  }
}
