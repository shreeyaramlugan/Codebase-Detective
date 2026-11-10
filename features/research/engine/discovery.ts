// features/research/engine/discovery.ts
//
// Discovery orchestration: runs each query against its target providers,
// merges duplicates (DOI wins over URL), evaluates, extracts passages and
// applies the per-run limits. One provider failing never fails the run; it is
// reported in diagnostics and the run becomes PARTIAL. No automatic retries.
import type {
  EvaluatedSource,
  ProviderDiagnostic,
  QueryPlan,
  ResearchLimits,
  SourceRecord,
} from "./contracts";
import {
  MIN_SCHOLARLY_RELEVANCE,
  buildPassages,
  compareEvaluated,
  evaluateSource,
} from "./evaluate";
import type {
  DiscoveredSource,
  DiscoveryContext,
  SourceProvider,
} from "./providers/types";

export interface DiscoveryInput {
  plans: QueryPlan[];
  providers: SourceProvider[];
  limits: ResearchLimits;
  now: () => Date;
  countRequest: () => Promise<void>;
  findCached: DiscoveryContext["findCached"];
  /** Epoch ms after which remaining queries are skipped. */
  deadlineAt: number;
  clock?: () => number;
}

export interface QueryOutcome {
  ordinal: number;
  status: "COMPLETED" | "PARTIAL" | "FAILED" | "SKIPPED";
  resultCount: number;
}

export interface DiscoveryOutput {
  sources: EvaluatedSource[];
  diagnostics: ProviderDiagnostic[];
  queries: QueryOutcome[];
  partial: boolean;
  /** Sources discarded because of limits or low relevance (for transparency). */
  discarded: { lowRelevance: number; overLimit: number };
}

const TARGET_PROVIDER: Record<QueryPlan["targets"][number], SourceProvider["name"]> = {
  OFFICIAL_DOCUMENTATION: "official-docs",
  CROSSREF: "crossref",
  OPENALEX: "openalex",
};

/** Merge two records of the same source; keeps identity, prefers richer content. */
export function mergeRecords(a: SourceRecord, b: SourceRecord): SourceRecord {
  const richer = b.excerpt.length > a.excerpt.length ? b : a;
  return {
    ...a,
    excerpt: richer.excerpt,
    contentHash: richer.contentHash ?? a.contentHash,
    contentLevel:
      a.contentLevel === "FULL_TEXT" || b.contentLevel === "FULL_TEXT"
        ? "FULL_TEXT"
        : a.contentLevel === "ABSTRACT" || b.contentLevel === "ABSTRACT"
          ? "ABSTRACT"
          : "METADATA_ONLY",
    externalIds: { ...b.externalIds, ...a.externalIds },
    doi: a.doi ?? b.doi,
    doiFromProvider: a.doiFromProvider || b.doiFromProvider,
    openAccess: a.openAccess ?? b.openAccess,
    license: a.license ?? b.license,
    citedByCount: Math.max(a.citedByCount ?? 0, b.citedByCount ?? 0) || null,
    authors: a.authors.length ? a.authors : b.authors,
    publishedAt: a.publishedAt ?? b.publishedAt,
  };
}

export async function runDiscovery(input: DiscoveryInput): Promise<DiscoveryOutput> {
  const clock = input.clock ?? (() => Date.now());
  const byName = new Map(input.providers.map((p) => [p.name, p]));
  const ctx: DiscoveryContext = {
    limits: input.limits,
    now: input.now,
    countRequest: input.countRequest,
    findCached: input.findCached,
  };

  const diagnostics: ProviderDiagnostic[] = [];
  const queries: QueryOutcome[] = [];
  const merged = new Map<
    string,
    { source: DiscoveredSource; queryOrdinals: number[]; firstQuery: QueryPlan }
  >();

  for (const plan of input.plans.slice(0, input.limits.maxQueriesPerRun)) {
    if (clock() > input.deadlineAt) {
      queries.push({ ordinal: plan.ordinal, status: "SKIPPED", resultCount: 0 });
      diagnostics.push({
        provider: "official-docs",
        queryOrdinal: plan.ordinal,
        status: "SKIPPED",
        returned: 0,
        durationMs: 0,
        note: "Skipped: the research time budget was used up.",
      });
      continue;
    }

    const targets = plan.targets
      .map((t) => byName.get(TARGET_PROVIDER[t]))
      .filter((p): p is SourceProvider => !!p);
    const results = await Promise.all(
      targets.map(async (provider) => {
        try {
          return await provider.discover(plan, ctx);
        } catch {
          return {
            sources: [] as DiscoveredSource[],
            diagnostic: {
              provider: provider.name,
              queryOrdinal: plan.ordinal,
              status: "UNAVAILABLE" as const,
              returned: 0,
              durationMs: 0,
              note: "The provider failed unexpectedly.",
            },
          };
        }
      }),
    );

    let count = 0;
    let failed = 0;
    for (const result of results) {
      diagnostics.push(result.diagnostic);
      if (["RATE_LIMITED", "TIMEOUT", "UNAVAILABLE"].includes(result.diagnostic.status)) failed += 1;
      for (const found of result.sources) {
        count += 1;
        const key = found.record.sourceKey;
        const existing = merged.get(key);
        if (existing) {
          existing.source = {
            record: mergeRecords(existing.source.record, found.record),
            sections: existing.source.sections.length >= found.sections.length ? existing.source.sections : found.sections,
            reused: existing.source.reused && found.reused,
          };
          if (!existing.queryOrdinals.includes(plan.ordinal)) existing.queryOrdinals.push(plan.ordinal);
        } else {
          merged.set(key, { source: found, queryOrdinals: [plan.ordinal], firstQuery: plan });
        }
      }
    }
    queries.push({
      ordinal: plan.ordinal,
      status: failed === 0 ? "COMPLETED" : failed === results.length ? "FAILED" : "PARTIAL",
      resultCount: count,
    });
  }

  let lowRelevance = 0;
  const evaluated: EvaluatedSource[] = [];
  for (const { source, queryOrdinals, firstQuery } of merged.values()) {
    const evaluation = evaluateSource(source.record, firstQuery.text, input.now(), input.limits);
    if (
      source.record.kind === "SCHOLARLY" &&
      evaluation.relevance < MIN_SCHOLARLY_RELEVANCE
    ) {
      lowRelevance += 1;
      continue;
    }
    evaluated.push({
      record: source.record,
      evaluation,
      passages: buildPassages(source.sections, firstQuery.text, firstQuery.ordinal, input.limits),
      queryOrdinals: queryOrdinals.sort((a, b) => a - b),
      reused: source.reused,
    });
  }

  evaluated.sort(compareEvaluated);
  const kept = evaluated.slice(0, input.limits.maxSourcesPerRun);

  return {
    sources: kept,
    diagnostics,
    queries,
    partial: queries.some((q) => q.status !== "COMPLETED"),
    discarded: { lowRelevance, overLimit: evaluated.length - kept.length },
  };
}
