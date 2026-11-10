// features/research/engine/config.ts
//
// Research limits. Env-overridable but clamped, like the Sprint 06 limits.
import type { ResearchLimits } from "./contracts";

export const DEFAULT_RESEARCH_LIMITS: ResearchLimits = {
  maxQueriesPerRun: 4,
  maxSourcesPerQuery: 5,
  maxSourcesPerRun: 12,
  maxPassagesPerSource: 3,
  maxPassageChars: 600,
  maxSynthesisContextChars: 20_000,
  maxOutputTokens: 3_000,
  discoveryDeadlineMs: 25_000,
  providerTimeoutMs: 8_000,
  dailyRunLimit: 10,
  dailySynthesisLimit: 10,
  dailyTokenLimit: 150_000,
  dailyProviderRequestLimit: 200,
  officialCacheDays: 7,
  scholarlyCacheDays: 30,
  datedAfterYears: 5,
};

const BOUNDS: Record<keyof ResearchLimits, [number, number]> = {
  maxQueriesPerRun: [1, 8],
  maxSourcesPerQuery: [1, 10],
  maxSourcesPerRun: [1, 30],
  maxPassagesPerSource: [1, 6],
  maxPassageChars: [200, 1_200],
  maxSynthesisContextChars: [4_000, 60_000],
  maxOutputTokens: [500, 6_000],
  discoveryDeadlineMs: [5_000, 55_000],
  providerTimeoutMs: [2_000, 20_000],
  dailyRunLimit: [1, 200],
  dailySynthesisLimit: [1, 200],
  dailyTokenLimit: [1_000, 3_000_000],
  dailyProviderRequestLimit: [10, 5_000],
  officialCacheDays: [0, 90],
  scholarlyCacheDays: [0, 365],
  datedAfterYears: [1, 20],
};

const ENV: Record<keyof ResearchLimits, string> = {
  maxQueriesPerRun: "RESEARCH_MAX_QUERIES",
  maxSourcesPerQuery: "RESEARCH_MAX_SOURCES_PER_QUERY",
  maxSourcesPerRun: "RESEARCH_MAX_SOURCES",
  maxPassagesPerSource: "RESEARCH_MAX_PASSAGES",
  maxPassageChars: "RESEARCH_MAX_PASSAGE_CHARS",
  maxSynthesisContextChars: "RESEARCH_MAX_CONTEXT_CHARS",
  maxOutputTokens: "RESEARCH_MAX_OUTPUT_TOKENS",
  discoveryDeadlineMs: "RESEARCH_DISCOVERY_DEADLINE_MS",
  providerTimeoutMs: "RESEARCH_PROVIDER_TIMEOUT_MS",
  dailyRunLimit: "RESEARCH_DAILY_RUN_LIMIT",
  dailySynthesisLimit: "RESEARCH_DAILY_SYNTHESIS_LIMIT",
  dailyTokenLimit: "RESEARCH_DAILY_TOKEN_LIMIT",
  dailyProviderRequestLimit: "RESEARCH_DAILY_PROVIDER_REQUEST_LIMIT",
  officialCacheDays: "RESEARCH_OFFICIAL_CACHE_DAYS",
  scholarlyCacheDays: "RESEARCH_SCHOLARLY_CACHE_DAYS",
  datedAfterYears: "RESEARCH_DATED_AFTER_YEARS",
};

export function resolveResearchLimits(
  env: Record<string, string | undefined> = process.env,
): ResearchLimits {
  const limits = { ...DEFAULT_RESEARCH_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof ResearchLimits>) {
    const raw = env[ENV[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value)) continue;
    const [min, max] = BOUNDS[key];
    limits[key] = Math.min(max, Math.max(min, value));
  }
  return limits;
}

export interface ResearchRuntimeOptions {
  /** Contact address sent to Crossref/OpenAlex "polite pool". Optional; env only. */
  contactEmail: string | null;
}

export function resolveRuntimeOptions(
  env: Record<string, string | undefined> = process.env,
): ResearchRuntimeOptions {
  const email = env.RESEARCH_CONTACT_EMAIL?.trim();
  return {
    contactEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
  };
}
