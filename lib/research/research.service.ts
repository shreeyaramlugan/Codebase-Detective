// lib/research/research.service.ts
//
// Research run lifecycle: start (discovery) -> review sources -> synthesise ->
// manage recommendations. Owner scoped, snapshot bound, provider independent.
// Retrieval and synthesis are separate steps: nothing is sent to the AI
// provider until the user has reviewed the sources and asked for synthesis.
import { AIProviderError, type AIProvider } from "@/features/ai/providers/ai-provider";
import { nextResetAt, usageDay } from "@/features/ai/assistant/config";
import { assembleContext } from "@/features/ai/assistant/context";
import type { EvidenceCandidate, EvidenceItem, SnapshotScope } from "@/features/ai/assistant/contracts";
import { extractTerms } from "@/features/ai/assistant/question";
import { isSensitivePath } from "@/features/ai/assistant/redact";
import { RESEARCH_ENGINE_VERSION, type EvaluatedSource, type ResearchLimits } from "@/features/research/engine/contracts";
import { runDiscovery } from "@/features/research/engine/discovery";
import {
  canTransition,
  isRecommendationStatus,
  validateNote,
  type RecommendationStatus,
} from "@/features/research/engine/lifecycle";
import type { SourceProvider } from "@/features/research/engine/providers/types";
import {
  ManualQuestionError,
  isResearchSupported,
  planFindingQueries,
  planManualQueries,
  validateManualQuestion,
} from "@/features/research/engine/queries";
import { synthesise } from "@/features/research/engine/synthesis";

import type { EvidenceReader } from "@/lib/ai/ai.reader";
import { ResearchError } from "./research.errors";
import type {
  RecommendationRow,
  ResearchFinding,
  ResearchStore,
  RunRow,
  RunSourceRow,
} from "./research.store";

export interface ResearchDeps {
  store: ResearchStore;
  reader: EvidenceReader;
  /** Source providers (documentation, Crossref, OpenAlex); injected for tests. */
  providers: SourceProvider[];
  provider: () => AIProvider;
  limits: ResearchLimits;
  synthesisTimeoutMs?: number;
  now?: () => Date;
  clock?: () => number;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_TITLE = 120;
export const RUN_LIST_LIMIT = 100;
const LOCK_SLACK_MS = 10_000;

const now = (d: ResearchDeps) => (d.now ?? (() => new Date()))();

export function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new ResearchError(`${name} is invalid.`, "INVALID_INPUT");
  }
  return value;
}

export function normaliseTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new ResearchError("title must be text.", "INVALID_INPUT");
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t || t.length > MAX_TITLE || CONTROL.test(t)) {
    throw new ResearchError(`title must be 1-${MAX_TITLE} printable characters.`, "INVALID_INPUT");
  }
  return t;
}

/* ------------------------------------------------------------------ views */

export function toRunView(row: RunRow) {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    snapshotId: row.snapshotId,
    analysisId: row.analysisId,
    commitSha: row.commitSha,
    trigger: row.trigger,
    findingId: row.findingId,
    findingFingerprint: row.findingFingerprint,
    ruleId: row.ruleId,
    question: row.question,
    title: row.title,
    status: row.status,
    queries: row.queries,
    diagnostics: row.diagnostics ?? [],
    discarded: row.discarded,
    partial: row.partial,
    synthesis: row.synthesis,
    provider: row.provider,
    model: row.model,
    totalTokens: row.totalTokens,
    errorCode: row.errorCode,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export function toSourceView(row: RunSourceRow) {
  return {
    sourceKey: row.sourceKey,
    position: row.position,
    included: row.included,
    reused: row.reused,
    evaluation: row.evaluation,
    passages: row.passages,
    queryOrdinals: row.queryOrdinals,
    // Everything the person needs to judge the source; never full text.
    kind: row.record.kind,
    sourceClass: row.record.sourceClass,
    classificationBasis: row.record.classificationBasis,
    title: row.record.title,
    publisher: row.record.publisher,
    authors: row.record.authors,
    container: row.record.container,
    canonicalUrl: row.record.canonicalUrl,
    doi: row.record.doiFromProvider ? row.record.doi : null,
    publishedAt: row.record.publishedAt,
    updatedAt: row.record.updatedAt,
    contentLevel: row.record.contentLevel,
    availability: row.record.availability,
    provider: row.record.provider,
    retrievedAt: row.record.retrievedAt,
    openAccess: row.record.openAccess,
    license: row.record.license,
  };
}

export function toRecommendationView(row: RecommendationRow) {
  return {
    id: row.id,
    runId: row.runId,
    ordinal: row.ordinal,
    title: row.title,
    concise: row.concise,
    detail: row.detail,
    basis: row.basis,
    repositoryCitations: row.repositoryCitations,
    sourceCitations: row.sourceCitations,
    status: row.status,
    note: row.note,
    statusChangedAt: row.statusChangedAt?.toISOString() ?? null,
  };
}

/* ------------------------------------------------------- repository evidence */

const CERTAINTY: Record<string, EvidenceCandidate["certainty"]> = {
  CONFIRMED: "CONFIRMED",
  MEASURED: "CONFIRMED",
  INDICATOR: "INDICATOR",
};

function findingCandidates(finding: ResearchFinding): EvidenceCandidate[] {
  const evidenceLines = finding.evidence.map((e) => `- ${e.filePath}${e.startLine ? `:${e.startLine}` : ""}: ${e.message}`);
  return [
    {
      kind: "finding",
      certainty: CERTAINTY[finding.certainty] ?? "INDICATOR",
      path: finding.subjectPath,
      startLine: finding.primaryLine,
      endLine: finding.primaryLine,
      symbolKey: null,
      title: `${finding.ruleId}: ${finding.title}`,
      text: [`Severity: ${finding.severity}; certainty: ${finding.certainty}`, finding.description, ...evidenceLines].join("\n"),
      score: 100,
    },
  ];
}

async function sourceCandidate(
  reader: EvidenceReader,
  scope: SnapshotScope,
  path: string,
  line: number | null,
): Promise<EvidenceCandidate[]> {
  if (isSensitivePath(path)) return [];
  const text = await reader.readSource(scope, path).catch(() => null);
  if (!text) return [];
  const lines = text.split("\n");
  const centre = line ?? 1;
  const start = Math.max(1, centre - 12);
  const end = Math.min(lines.length, centre + 12);
  return [
    {
      kind: "source",
      certainty: "NOT_APPLICABLE",
      path,
      startLine: start,
      endLine: end,
      symbolKey: null,
      title: path,
      text: lines.slice(start - 1, end).join("\n"),
      score: 90,
    },
  ];
}

async function manualCandidates(
  reader: EvidenceReader,
  scope: SnapshotScope,
  question: string,
): Promise<EvidenceCandidate[]> {
  const terms = extractTerms(question);
  if (terms.length === 0) return [];
  const out: EvidenceCandidate[] = [];
  const findings = await reader.findFindings(scope, { terms, paths: [], top: false, limit: 3 }).catch(() => []);
  for (const f of findings) {
    out.push({
      kind: "finding",
      certainty: CERTAINTY[f.certainty] ?? "INDICATOR",
      path: f.subjectPath,
      startLine: f.primaryLine,
      endLine: f.primaryLine,
      symbolKey: null,
      title: `${f.ruleId}: ${f.title}`,
      text: `Severity: ${f.severity}; certainty: ${f.certainty}\n${f.description}`,
      score: 60,
    });
  }
  const symbols = await reader.findSymbols(scope, terms, 4).catch(() => []);
  for (const s of symbols) {
    out.push({
      kind: "symbol",
      certainty: "CONFIRMED",
      path: s.path,
      startLine: s.startLine,
      endLine: s.endLine,
      symbolKey: s.stableKey,
      title: `${s.kind} ${s.qualifiedName}`,
      text: `${s.kind} ${s.qualifiedName} in ${s.path} (lines ${s.startLine}-${s.endLine})`,
      score: 40,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ runs */

export interface StartRunInput {
  findingId?: unknown;
  question?: unknown;
  snapshotId?: unknown;
  analysisId?: unknown;
}

export async function startRun(deps: ResearchDeps, userId: string, repositoryId: string, input: StartRunInput) {
  requireId(repositoryId, "repositoryId");
  const { store, limits } = deps;
  if (!(await store.repositoryExists(userId, repositoryId))) {
    throw new ResearchError("Repository not found.", "NOT_FOUND");
  }
  const hasFinding = input.findingId !== undefined && input.findingId !== null;
  const hasQuestion = input.question !== undefined && input.question !== null;
  if (hasFinding === hasQuestion) {
    throw new ResearchError("Provide either findingId or question.", "INVALID_INPUT");
  }

  let finding: ResearchFinding | null = null;
  let question: string;
  let plans;
  if (hasFinding) {
    finding = await store.findFinding(userId, requireId(input.findingId, "findingId"));
    if (!finding || finding.repositoryId !== repositoryId) {
      throw new ResearchError("Finding not found.", "NOT_FOUND");
    }
    if (!isResearchSupported(finding.ruleId)) {
      throw new ResearchError("Research is not available for this kind of finding.", "UNSUPPORTED");
    }
    plans = planFindingQueries(finding, limits);
    question = `Research for ${finding.ruleId}: ${finding.title}`;
  } else {
    try {
      question = validateManualQuestion(input.question);
    } catch (error) {
      if (error instanceof ManualQuestionError) throw new ResearchError(error.message, "INVALID_INPUT");
      throw error;
    }
    plans = planManualQueries(question, limits);
  }

  const selector = finding
    ? { analysisId: finding.analysisId }
    : input.analysisId !== undefined && input.analysisId !== null
      ? { analysisId: requireId(input.analysisId, "analysisId") }
      : input.snapshotId !== undefined && input.snapshotId !== null
        ? { snapshotId: requireId(input.snapshotId, "snapshotId") }
        : {};
  const scope = await store.resolveScope(userId, repositoryId, selector);
  if (!scope) {
    throw new ResearchError("This repository has no completed analysis to research against.", "CONTEXT_UNAVAILABLE");
  }

  const t = now(deps);
  const day = usageDay(t);
  if (!(await store.reserve(userId, day, "runCount", limits.dailyRunLimit))) {
    throw new ResearchError("The daily research limit has been reached.", "LIMIT_EXCEEDED", {
      resetsAt: nextResetAt(t).toISOString(),
    });
  }

  const deadline = limits.discoveryDeadlineMs;
  const run = await store.createRun(
    {
      userId,
      repositoryId,
      snapshotId: scope.snapshotId,
      analysisId: scope.analysisId,
      commitSha: scope.commitSha,
      findingsRunId: scope.findingsRunId,
      trigger: finding ? "FINDING" : "QUESTION",
      findingId: finding?.id ?? null,
      findingFingerprint: finding?.fingerprint ?? null,
      ruleId: finding?.ruleId ?? null,
      question,
      title: question.length <= 80 ? question : `${question.slice(0, 79)}…`,
      queries: plans,
      engineVersion: RESEARCH_ENGINE_VERSION,
    },
    new Date(t.getTime() + deadline + LOCK_SLACK_MS),
  );

  try {
    const clock = deps.clock ?? (() => Date.now());
    const out = await runDiscovery({
      plans,
      providers: deps.providers,
      limits,
      now: () => now(deps),
      deadlineAt: clock() + deadline,
      clock,
      countRequest: async () => {
        if (!(await store.reserve(userId, day, "providerRequestCount", limits.dailyProviderRequestLimit))) {
          throw new ResearchError("The daily provider request limit has been reached.", "LIMIT_EXCEEDED");
        }
      },
      findCached: (url) => store.findCachedSource(userId, url, now(deps)),
    });

    await store.saveDiscovery(run.id, {
      sources: out.sources.map((s, i) => ({
        sourceKey: s.record.sourceKey,
        position: i + 1,
        record: s.record,
        evaluation: s.evaluation,
        passages: s.passages,
        queryOrdinals: s.queryOrdinals,
        reused: s.reused,
      })),
      diagnostics: out.diagnostics,
      discarded: out.discarded,
      partial: out.partial,
    });
    const t2 = now(deps);
    await store
      .cacheSources(
        userId,
        out.sources
          .filter((s) => s.record.availability === "AVAILABLE" && !s.reused)
          .map((s) => ({
            record: s.record,
            expiresAt: new Date(
              t2.getTime() +
                (s.record.kind === "OFFICIAL_DOCUMENTATION" ? limits.officialCacheDays : limits.scholarlyCacheDays) * 86_400_000,
            ),
          })),
      )
      .catch(() => undefined);
  } catch (error) {
    await store.failRun(run.id, "DISCOVERY_FAILED").catch(() => undefined);
    if (error instanceof ResearchError) throw error;
    throw new ResearchError("Research could not be completed.", "PROVIDER_ERROR");
  } finally {
    await store.releaseLock(run.id).catch(() => undefined);
  }

  return getRun(deps, userId, run.id);
}

export async function listRuns(
  deps: ResearchDeps,
  userId: string,
  repositoryId: string,
  opts: { archived?: boolean; findingFingerprint?: string } = {},
) {
  requireId(repositoryId, "repositoryId");
  if (!(await deps.store.repositoryExists(userId, repositoryId))) {
    throw new ResearchError("Repository not found.", "NOT_FOUND");
  }
  const rows = await deps.store.listRuns(userId, repositoryId, {
    archived: opts.archived ?? false,
    findingFingerprint: opts.findingFingerprint,
    limit: RUN_LIST_LIMIT,
  });
  return { runs: rows.map(toRunView) };
}

async function requireRun(deps: ResearchDeps, userId: string, runId: string): Promise<RunRow> {
  requireId(runId, "runId");
  const run = await deps.store.findRun(userId, runId);
  if (!run) throw new ResearchError("Research run not found.", "NOT_FOUND");
  return run;
}

export async function getRun(deps: ResearchDeps, userId: string, runId: string) {
  const run = await requireRun(deps, userId, runId);
  const [sources, recommendations] = await Promise.all([
    deps.store.listRunSources(userId, runId),
    deps.store.listRecommendations(userId, runId),
  ]);
  return {
    run: toRunView(run),
    sources: sources.map(toSourceView),
    recommendations: recommendations.map(toRecommendationView),
  };
}

export async function updateRun(
  deps: ResearchDeps,
  userId: string,
  runId: string,
  patch: { title?: unknown; archived?: unknown },
) {
  await requireRun(deps, userId, runId);
  const update: { title?: string; archivedAt?: Date | null } = {};
  if (patch.title !== undefined) update.title = normaliseTitle(patch.title);
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== "boolean") throw new ResearchError("archived must be a boolean.", "INVALID_INPUT");
    update.archivedAt = patch.archived ? now(deps) : null;
  }
  if (Object.keys(update).length === 0) throw new ResearchError("Nothing to update.", "INVALID_INPUT");
  const row = await deps.store.updateRun(userId, runId, update);
  if (!row) throw new ResearchError("Research run not found.", "NOT_FOUND");
  return { run: toRunView(row) };
}

export async function deleteRun(deps: ResearchDeps, userId: string, runId: string) {
  requireId(runId, "runId");
  if (!(await deps.store.deleteRun(userId, runId))) {
    throw new ResearchError("Research run not found.", "NOT_FOUND");
  }
  return { deleted: true };
}

/* ----------------------------------------------------------- source review */

export async function reviewSources(
  deps: ResearchDeps,
  userId: string,
  runId: string,
  body: { included?: unknown },
) {
  const run = await requireRun(deps, userId, runId);
  if (run.status !== "AWAITING_REVIEW") {
    throw new ResearchError("Sources can only be reviewed before synthesis.", "INVALID_STATE");
  }
  const raw = body.included;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ResearchError("included must be an object of sourceKey -> boolean.", "INVALID_INPUT");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 50) throw new ResearchError("included is invalid.", "INVALID_INPUT");
  const known = new Set((await deps.store.listRunSources(userId, runId)).map((s) => s.sourceKey));
  const map: Record<string, boolean> = {};
  for (const [key, value] of entries) {
    if (typeof value !== "boolean" || !known.has(key)) {
      throw new ResearchError("included contains an unknown source or a non-boolean value.", "INVALID_INPUT");
    }
    map[key] = value;
  }
  if (!(await deps.store.setIncluded(userId, runId, map))) {
    throw new ResearchError("Sources can only be reviewed before synthesis.", "INVALID_STATE");
  }
  return getRun(deps, userId, runId);
}

/* --------------------------------------------------------------- synthesis */

export async function synthesiseRun(deps: ResearchDeps, userId: string, runId: string) {
  const run = await requireRun(deps, userId, runId);
  if (run.status !== "AWAITING_REVIEW") {
    throw new ResearchError(
      run.status === "COMPLETED" ? "This research run has already been synthesised." : "This run is not ready for synthesis.",
      "INVALID_STATE",
    );
  }
  const { store, limits } = deps;
  const t = now(deps);
  const timeoutMs = deps.synthesisTimeoutMs ?? 45_000;
  if (!(await store.acquireLock(run.id, t, new Date(t.getTime() + timeoutMs + LOCK_SLACK_MS), "AWAITING_REVIEW"))) {
    throw new ResearchError("This run is already being processed.", "BUSY", { retryable: true });
  }

  try {
    const scope = await store.resolveScope(userId, run.repositoryId, { analysisId: run.analysisId });
    if (!scope) throw new ResearchError("The analysis for this run is no longer available.", "CONTEXT_UNAVAILABLE");

    // Only sources the person kept are eligible. Review is the gate.
    const rows = await store.listRunSources(userId, run.id);
    const reviewed: EvaluatedSource[] = rows
      .filter((r) => r.included)
      .map((r) => ({
        record: r.record,
        evaluation: r.evaluation,
        passages: r.passages,
        queryOrdinals: r.queryOrdinals,
        reused: r.reused,
      }));

    let candidates: EvidenceCandidate[] = [];
    if (run.trigger === "FINDING" && run.findingId) {
      const finding = await store.findFinding(userId, run.findingId);
      if (finding) {
        candidates = [
          ...findingCandidates(finding),
          ...(await sourceCandidate(deps.reader, scope, finding.subjectPath, finding.primaryLine)),
        ];
      }
    } else {
      candidates = await manualCandidates(deps.reader, scope, run.question);
    }
    const repositoryEvidence: EvidenceItem[] = assembleContext(candidates, 8_000).items;

    const day = usageDay(t);
    const started = Date.now();
    let provider: string | null = null;
    let model = "unknown";
    try {
      const out = await synthesise({
        provider: deps.provider(),
        limits,
        timeoutMs,
        question: run.question,
        scope,
        repositoryEvidence,
        sources: reviewed,
        beforeProvider: async () => {
          // Reserve before contacting the provider; atomic and race safe.
          if (!(await store.reserve(userId, day, "synthesisCount", limits.dailySynthesisLimit, limits.dailyTokenLimit))) {
            throw new ResearchError("The daily research synthesis limit has been reached.", "LIMIT_EXCEEDED", {
              resetsAt: nextResetAt(t).toISOString(),
            });
          }
        },
      });
      provider = out.provider;
      model = out.model ?? model;
      if (out.providerCalled) {
        await store.recordUsage(userId, day, {
          runId: run.id,
          provider: out.provider ?? "unknown",
          model,
          status: "SUCCEEDED",
          inputTokens: out.usage?.inputTokens ?? null,
          outputTokens: out.usage?.outputTokens ?? null,
          totalTokens: out.usage?.totalTokens ?? null,
          errorCode: null,
          durationMs: Date.now() - started,
        });
      }
      const { recommendations, ...synthesis } = out.result;
      await store.saveSynthesis(run.id, {
        synthesis,
        recommendations,
        provider,
        model: out.model,
        totalTokens: out.usage?.totalTokens ?? null,
      });
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      if (error instanceof AIProviderError) {
        await store
          .recordUsage(userId, day, {
            runId: run.id,
            provider: "gemini",
            model,
            status: "FAILED",
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            errorCode: error.code,
            durationMs: Date.now() - started,
          })
          .catch(() => undefined);
        throw new ResearchError(
          error.message,
          error.code === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "PROVIDER_ERROR",
          { status: error.code === "TIMEOUT" ? 504 : undefined, retryable: error.retryable },
        );
      }
      throw error;
    }
  } finally {
    await store.releaseLock(run.id).catch(() => undefined);
  }
  return getRun(deps, userId, runId);
}

/* ---------------------------------------------------------- recommendations */

export async function updateRecommendation(
  deps: ResearchDeps,
  userId: string,
  recommendationId: string,
  patch: { status?: unknown; note?: unknown },
) {
  requireId(recommendationId, "recommendationId");
  const current = await deps.store.findRecommendation(userId, recommendationId);
  if (!current) throw new ResearchError("Recommendation not found.", "NOT_FOUND");
  const update: { status?: RecommendationStatus; note?: string | null } = {};
  if (patch.status !== undefined) {
    if (!isRecommendationStatus(patch.status)) throw new ResearchError("status is invalid.", "INVALID_INPUT");
    if (!canTransition(current.status, patch.status)) {
      throw new ResearchError(`A ${current.status.toLowerCase()} recommendation cannot become ${patch.status.toLowerCase()}.`, "INVALID_STATE");
    }
    update.status = patch.status;
  }
  if (patch.note !== undefined) {
    try {
      update.note = validateNote(patch.note);
    } catch {
      throw new ResearchError("note is invalid.", "INVALID_INPUT");
    }
  }
  if (Object.keys(update).length === 0) throw new ResearchError("Nothing to update.", "INVALID_INPUT");
  const row = await deps.store.updateRecommendation(userId, recommendationId, update, now(deps));
  if (!row) throw new ResearchError("Recommendation not found.", "NOT_FOUND");
  return { recommendation: toRecommendationView(row) };
}

/* ------------------------------------------------------------------- usage */

export async function getResearchUsage(deps: ResearchDeps, userId: string) {
  const t = now(deps);
  const usage = await deps.store.getUsage(userId, usageDay(t));
  const l = deps.limits;
  return {
    runs: { used: usage.runCount, limit: l.dailyRunLimit },
    syntheses: { used: usage.synthesisCount, limit: l.dailySynthesisLimit },
    tokens: { used: usage.tokenCount, limit: l.dailyTokenLimit },
    providerRequests: { used: usage.providerRequestCount, limit: l.dailyProviderRequestLimit },
    resetsAt: nextResetAt(t).toISOString(),
  };
}
