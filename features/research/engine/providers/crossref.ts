// features/research/engine/providers/crossref.ts
//
// Crossref REST API. Provides bibliographic metadata and (sometimes) abstracts.
// Everything recorded comes from the response; nothing is invented. Peer review
// is *inferred* from the Crossref work type and labelled as such.
import type { QueryPlan, SourceRecord, SourceClass } from "../contracts";
import { EXCERPT_CACHE_CHARS } from "../contracts";
import { stripTags } from "../html";
import { ResearchHttpError, fetchBounded, type FetchLike } from "../http";
import { canonicalUrl, contentHash, doiUrl, normaliseDoi, sourceKey } from "../identity";
import { MinIntervalLimiter } from "../rate-limit";
import {
  emptyDiagnostic,
  type DiscoveredSource,
  type DiscoveryContext,
  type ProviderResult,
  type SourceProvider,
} from "./types";

const ENDPOINT = "https://api.crossref.org/works";

interface CrossrefItem {
  DOI?: unknown;
  title?: unknown;
  author?: unknown;
  issued?: { "date-parts"?: unknown };
  type?: unknown;
  subtype?: unknown;
  "container-title"?: unknown;
  abstract?: unknown;
  publisher?: unknown;
  URL?: unknown;
  license?: unknown;
  "is-referenced-by-count"?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const first = (v: unknown): string | null => (Array.isArray(v) ? str(v[0]) : str(v));

function issuedDate(item: CrossrefItem): string | null {
  const parts = item.issued?.["date-parts"];
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return null;
  const [y, m, d] = parts[0] as unknown[];
  if (typeof y !== "number" || y < 1900 || y > 2100) return null;
  const mm = typeof m === "number" && m >= 1 && m <= 12 ? String(m).padStart(2, "0") : "01";
  const dd = typeof d === "number" && d >= 1 && d <= 31 ? String(d).padStart(2, "0") : "01";
  return `${y}-${mm}-${dd}`;
}

export function classifyCrossref(
  type: string | null,
  subtype: string | null,
): { sourceClass: SourceClass; basis: string } {
  if (type === "posted-content" || subtype === "preprint") {
    return { sourceClass: "PREPRINT", basis: "Crossref type posted-content/preprint" };
  }
  if (type === "journal-article" || type === "proceedings-article") {
    return {
      sourceClass: "PEER_REVIEWED",
      basis: `Crossref type ${type}; peer review is inferred from the publication type, not verified`,
    };
  }
  return { sourceClass: "OTHER_SCHOLARLY", basis: `Crossref type ${type ?? "unknown"}` };
}

export function parseCrossrefItem(
  item: CrossrefItem,
  retrievedAt: string,
): DiscoveredSource | null {
  const doi = normaliseDoi(str(item.DOI));
  const title = first(item.title);
  if (!doi || !title) return null;

  const url = canonicalUrl(str(item.URL) ?? doiUrl(doi)) ?? doiUrl(doi);
  const abstract = str(item.abstract) ? stripTags(String(item.abstract)).replace(/^abstract\s*/i, "") : "";
  const authors = Array.isArray(item.author)
    ? item.author
        .map((a) => {
          const rec = a as { given?: unknown; family?: unknown; name?: unknown };
          return str(rec.name) ?? [str(rec.given), str(rec.family)].filter(Boolean).join(" ");
        })
        .filter((n): n is string => !!n)
        .slice(0, 12)
    : [];
  const { sourceClass, basis } = classifyCrossref(str(item.type), str(item.subtype));
  const licenseUrl = Array.isArray(item.license)
    ? str((item.license[0] as { URL?: unknown } | undefined)?.URL)
    : null;
  const excerpt = abstract.slice(0, EXCERPT_CACHE_CHARS);

  const record: SourceRecord = {
    sourceKey: sourceKey({ doi, canonicalUrl: url }),
    kind: "SCHOLARLY",
    sourceClass,
    classificationBasis: basis,
    title: stripTags(title),
    publisher: str(item.publisher) ?? "Unknown publisher",
    authors,
    container: first(item["container-title"]),
    canonicalUrl: url,
    doi,
    externalIds: { doi },
    publishedAt: issuedDate(item),
    updatedAt: null,
    contentLevel: excerpt ? "ABSTRACT" : "METADATA_ONLY",
    availability: "UNVERIFIED", // landing page was not fetched
    doiFromProvider: true,
    provider: "crossref",
    retrievedAt,
    excerpt,
    contentHash: excerpt ? contentHash(excerpt) : null,
    openAccess: null,
    license: licenseUrl,
    citedByCount:
      typeof item["is-referenced-by-count"] === "number" ? (item["is-referenced-by-count"] as number) : null,
  };
  return {
    record,
    sections: excerpt ? [{ heading: "abstract", text: excerpt }] : [],
    reused: false,
  };
}

export interface CrossrefOptions {
  fetchImpl: FetchLike;
  contactEmail: string | null;
  limiter?: MinIntervalLimiter;
}

export class CrossrefProvider implements SourceProvider {
  readonly name = "crossref" as const;
  private readonly limiter: MinIntervalLimiter;
  constructor(private readonly options: CrossrefOptions) {
    // Crossref asks for polite, low-rate use; one request per second.
    this.limiter = options.limiter ?? new MinIntervalLimiter(1_000);
  }

  async discover(query: QueryPlan, ctx: DiscoveryContext): Promise<ProviderResult> {
    const started = Date.now();
    const params = new URLSearchParams({
      "query.bibliographic": query.text,
      rows: String(ctx.limits.maxSourcesPerQuery),
      select: "DOI,title,author,issued,type,subtype,container-title,abstract,publisher,URL,license,is-referenced-by-count",
    });
    if (this.options.contactEmail) params.set("mailto", this.options.contactEmail);

    try {
      await ctx.countRequest();
      await this.limiter.acquire();
      const body = await fetchBounded(`${ENDPOINT}?${params}`, {
        fetchImpl: this.options.fetchImpl,
        timeoutMs: ctx.limits.providerTimeoutMs,
        maxBytes: 2_000_000,
        accept: "application/json",
        hostAllowed: (u) => u.hostname === "api.crossref.org",
      });
      const json = JSON.parse(body.text) as { message?: { items?: unknown } };
      const items = Array.isArray(json.message?.items) ? (json.message!.items as CrossrefItem[]) : [];
      const retrievedAt = ctx.now().toISOString();
      const sources = items
        .map((item) => parseCrossrefItem(item, retrievedAt))
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

export function failure(
  provider: "crossref" | "openalex" | "official-docs",
  query: QueryPlan,
  error: unknown,
  started: number,
): ProviderResult {
  const code = error instanceof ResearchHttpError ? error.code : "UNAVAILABLE";
  const status =
    code === "RATE_LIMITED" ? "RATE_LIMITED" : code === "TIMEOUT" ? "TIMEOUT" : "UNAVAILABLE";
  const note =
    status === "RATE_LIMITED"
      ? "The provider is rate limiting requests; try again later."
      : status === "TIMEOUT"
        ? "The provider took too long to respond."
        : "The provider could not be reached or returned an unreadable response.";
  return {
    sources: [],
    diagnostic: { ...emptyDiagnostic(provider, query, status, note), durationMs: Date.now() - started },
  };
}
