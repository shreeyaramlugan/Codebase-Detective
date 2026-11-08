// lib/findings/findings.service.ts
//
// Owner-scoped queries and commands for the Sprint 05 findings engine.
//
// Every query is anchored to a run/finding whose repository the user owns,
// with the owner in the WHERE clause, so another user's data is
// indistinguishable from missing data. Reads never recompute detection: they
// return what a run persisted. The final `db` parameter lets tests inject a
// fake client.
import type { PrismaClient } from "@prisma/client";

import {
  compareFindings,
  type ComparisonSide,
  type FindingsComparison,
} from "@/features/findings/compare/compare-findings";
import {
  FINDING_CATEGORIES,
  FINDING_CERTAINTIES,
  SEVERITY_ORDER,
  type FindingSeverity,
} from "@/features/findings/contracts";
import { RULE_CATALOGUE } from "@/features/findings/rules";
import { prisma } from "@/lib/db/prisma";

import { FindingsError } from "./findings.errors";

export type FindingsDb = Pick<
  PrismaClient,
  | "findingsRun"
  | "finding"
  | "findingRuleRun"
  | "findingReview"
  | "analysisFile"
>;

export const FINDINGS_PAGE_DEFAULT = 50;
export const FINDINGS_PAGE_MAX = 200;
export const MAX_SEARCH_LENGTH = 100;
const REVIEW_FILTER_LIMIT = 5_000;
const RUN_LIST_LIMIT = 50;

export const REVIEW_FILTERS = ["OPEN", "ACKNOWLEDGED", "DISMISSED"] as const;
export type ReviewFilter = (typeof REVIEW_FILTERS)[number];

function clamp(value: number | undefined, fallback: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface FindingsRunView {
  id: string;
  analysisId: string;
  snapshotId: string;
  repositoryId: string;
  commitSha: string;
  analysisStatus: string;
  snapshotCompleteness: string | null;
  status: string;
  engineVersion: string;
  catalogueVersion: string;
  thresholds: unknown;
  stats: unknown;
  limitations: string[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RuleRunView {
  ruleId: string;
  ruleVersion: string;
  status: string;
  reason: string | null;
  findingCount: number;
  rejectedCount: number;
  limitations: string[];
}

const RUN_SELECT = {
  id: true,
  analysisId: true,
  repositoryId: true,
  status: true,
  engineVersion: true,
  catalogueVersion: true,
  thresholds: true,
  stats: true,
  coverage: true,
  limitations: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  completedAt: true,
  analysis: {
    select: {
      snapshotId: true,
      commitSha: true,
      status: true,
      snapshotCompleteness: true,
    },
  },
} as const;

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function toRunView(row: any): FindingsRunView {
  return {
    id: row.id,
    analysisId: row.analysisId,
    snapshotId: row.analysis.snapshotId,
    repositoryId: row.repositoryId,
    commitSha: row.analysis.commitSha,
    analysisStatus: row.analysis.status,
    snapshotCompleteness: row.analysis.snapshotCompleteness,
    status: row.status,
    engineVersion: row.engineVersion,
    catalogueVersion: row.catalogueVersion,
    thresholds: row.thresholds,
    stats: row.stats,
    limitations: strings(row.limitations),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

async function requireOwnedRun(db: FindingsDb, userId: string, runId: string) {
  const run = await db.findingsRun.findFirst({
    where: { id: runId, repository: { ownerId: userId } },
    select: RUN_SELECT,
  });
  if (!run) throw new FindingsError("Findings run not found.", "NOT_FOUND");
  return run as any;
}

export async function listAnalysisFindingsRuns(
  userId: string,
  analysisId: string,
  db: FindingsDb = prisma,
): Promise<{ runs: FindingsRunView[] }> {
  const rows = await db.findingsRun.findMany({
    where: { analysisId, repository: { ownerId: userId } },
    orderBy: { createdAt: "desc" },
    take: RUN_LIST_LIMIT,
    select: RUN_SELECT,
  });
  return { runs: (rows as any[]).map(toRunView) };
}

/** Runs across every snapshot of a repository, for the comparison picker. */
export async function listRepositoryFindingsRuns(
  userId: string,
  repositoryId: string,
  db: FindingsDb = prisma,
): Promise<{ runs: FindingsRunView[] }> {
  const rows = await db.findingsRun.findMany({
    where: { repositoryId, repository: { ownerId: userId } },
    orderBy: { createdAt: "desc" },
    take: RUN_LIST_LIMIT,
    select: RUN_SELECT,
  });
  return { runs: (rows as any[]).map(toRunView) };
}

export async function getFindingsRun(
  userId: string,
  runId: string,
  db: FindingsDb = prisma,
): Promise<{ run: FindingsRunView; ruleRuns: RuleRunView[] }> {
  const run = await requireOwnedRun(db, userId, runId);
  const ruleRuns = await db.findingRuleRun.findMany({
    where: { runId: run.id },
    orderBy: { ruleId: "asc" },
  });

  return {
    run: toRunView(run),
    ruleRuns: (ruleRuns as any[]).map((row) => ({
      ruleId: row.ruleId,
      ruleVersion: row.ruleVersion,
      status: row.status,
      reason: row.reason,
      findingCount: row.findingCount,
      rejectedCount: row.rejectedCount,
      limitations: strings(row.limitations),
    })),
  };
}

// ---------------------------------------------------------------------------
// Findings list and detail
// ---------------------------------------------------------------------------

export interface FindingListItem {
  id: string;
  fingerprint: string;
  ruleId: string;
  category: string;
  severity: string;
  certainty: string;
  title: string;
  subjectPath: string;
  primaryLine: number | null;
  review: { status: string; reason: string | null } | null;
}

export interface FindingFilters {
  severities?: string[];
  categories?: string[];
  certainties?: string[];
  ruleIds?: string[];
  path?: string;
  q?: string;
  review?: ReviewFilter;
  limit?: number;
  cursor?: string | null;
}

export function normaliseFindingQuery(query: string | undefined) {
  const trimmed = (query ?? "").trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_SEARCH_LENGTH || trimmed.includes("\0")) {
    throw new FindingsError("q is invalid.", "INVALID_INPUT");
  }
  return trimmed;
}

function assertAllowed(
  name: string,
  values: string[] | undefined,
  allowed: readonly string[],
) {
  for (const value of values ?? []) {
    if (!allowed.includes(value)) {
      throw new FindingsError(`${name} is invalid.`, "INVALID_INPUT");
    }
  }
}

export async function listFindings(
  userId: string,
  runId: string,
  filters: FindingFilters = {},
  db: FindingsDb = prisma,
): Promise<{
  items: FindingListItem[];
  nextCursor: string | null;
  total: number;
}> {
  const run = await requireOwnedRun(db, userId, runId);

  assertAllowed("severity", filters.severities, SEVERITY_ORDER);
  assertAllowed("category", filters.categories, FINDING_CATEGORIES);
  assertAllowed("certainty", filters.certainties, FINDING_CERTAINTIES);
  assertAllowed(
    "rule",
    filters.ruleIds,
    RULE_CATALOGUE.map((rule) => rule.id),
  );

  const q = normaliseFindingQuery(filters.q);
  const limit = clamp(filters.limit, FINDINGS_PAGE_DEFAULT, FINDINGS_PAGE_MAX);

  const where: Record<string, unknown> = { runId: run.id };
  if (filters.severities?.length) where.severity = { in: filters.severities };
  if (filters.categories?.length) where.category = { in: filters.categories };
  if (filters.certainties?.length) {
    where.certainty = { in: filters.certainties };
  }
  if (filters.ruleIds?.length) where.ruleId = { in: filters.ruleIds };
  if (filters.path) {
    if (filters.path.length > 1024 || filters.path.includes("\0")) {
      throw new FindingsError("path is invalid.", "INVALID_INPUT");
    }
    where.subjectPath = { startsWith: filters.path };
  }
  if (q) {
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { subjectPath: { contains: q, mode: "insensitive" } },
      { ruleId: { contains: q, mode: "insensitive" } },
    ];
  }

  if (filters.review) {
    if (!(REVIEW_FILTERS as readonly string[]).includes(filters.review)) {
      throw new FindingsError("review is invalid.", "INVALID_INPUT");
    }
    // Reviews are keyed by repository + fingerprint, so the filter is applied
    // through the fingerprints of the repository's reviewed findings.
    const reviewed = await db.findingReview.findMany({
      where: {
        repositoryId: run.repositoryId,
        ...(filters.review === "OPEN" ? {} : { status: filters.review }),
      },
      select: { fingerprint: true },
      take: REVIEW_FILTER_LIMIT,
    });
    const fingerprints = (reviewed as any[]).map((row) => row.fingerprint);
    where.fingerprint =
      filters.review === "OPEN"
        ? { notIn: fingerprints }
        : { in: fingerprints };
  }

  const [rows, total] = await Promise.all([
    db.finding.findMany({
      where: where as any,
      orderBy: [
        { severity: "asc" },
        { ruleId: "asc" },
        { subjectPath: "asc" },
        { primaryLine: "asc" },
        { id: "asc" },
      ],
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        fingerprint: true,
        ruleId: true,
        category: true,
        severity: true,
        certainty: true,
        title: true,
        subjectPath: true,
        primaryLine: true,
      },
    }),
    db.finding.count({ where: where as any }),
  ]);

  const page = (rows as any[]).slice(0, limit);
  const reviews = page.length
    ? await db.findingReview.findMany({
        where: {
          repositoryId: run.repositoryId,
          fingerprint: { in: page.map((row) => row.fingerprint) },
        },
        select: { fingerprint: true, status: true, reason: true },
      })
    : [];
  const reviewByFingerprint = new Map(
    (reviews as any[]).map((row) => [row.fingerprint, row] as const),
  );

  return {
    items: page.map((row) => {
      const review = reviewByFingerprint.get(row.fingerprint);
      return {
        ...row,
        review: review
          ? { status: review.status, reason: review.reason }
          : null,
      };
    }),
    nextCursor:
      (rows as any[]).length > limit
        ? (page[page.length - 1].id as string)
        : null,
    total,
  };
}

export interface FindingDetail extends FindingListItem {
  runId: string;
  analysisId: string;
  snapshotId: string;
  repositoryId: string;
  ruleVersion: string;
  description: string;
  recommendation: string;
  subjectKey: string;
  symbolKey: string | null;
  measurements: unknown;
  evidence: Array<{
    ordinal: number;
    kind: string;
    filePath: string;
    symbolKey: string | null;
    startLine: number | null;
    startColumn: number | null;
    endLine: number | null;
    endColumn: number | null;
    excerpt: string | null;
    message: string;
    data: unknown;
  }>;
  rule: {
    id: string;
    name: string;
    description: string;
    evaluation: string;
  } | null;
  /** True for security indicators: not a confirmed vulnerability. */
  isIndicator: boolean;
}

async function requireOwnedFinding(
  db: FindingsDb,
  userId: string,
  findingId: string,
) {
  const finding = await db.finding.findFirst({
    where: { id: findingId, run: { repository: { ownerId: userId } } },
    include: {
      evidence: { orderBy: { ordinal: "asc" } },
      run: {
        select: {
          id: true,
          analysisId: true,
          repositoryId: true,
          analysis: { select: { snapshotId: true } },
        },
      },
    },
  });
  if (!finding) throw new FindingsError("Finding not found.", "NOT_FOUND");
  return finding as any;
}

export async function getFinding(
  userId: string,
  findingId: string,
  db: FindingsDb = prisma,
): Promise<FindingDetail> {
  const row = await requireOwnedFinding(db, userId, findingId);
  const review = await db.findingReview.findFirst({
    where: { repositoryId: row.run.repositoryId, fingerprint: row.fingerprint },
    select: { status: true, reason: true },
  });
  const rule = RULE_CATALOGUE.find((r) => r.id === row.ruleId) ?? null;

  return {
    id: row.id,
    fingerprint: row.fingerprint,
    runId: row.run.id,
    analysisId: row.run.analysisId,
    snapshotId: row.run.analysis?.snapshotId ?? "",
    repositoryId: row.run.repositoryId,
    ruleId: row.ruleId,
    ruleVersion: row.ruleVersion,
    category: row.category,
    severity: row.severity,
    certainty: row.certainty,
    title: row.title,
    description: row.description,
    recommendation: row.recommendation,
    subjectPath: row.subjectPath,
    subjectKey: row.subjectKey,
    symbolKey: row.symbolKey,
    primaryLine: row.primaryLine,
    measurements: row.measurements,
    evidence: row.evidence.map((e: any) => ({
      ordinal: e.ordinal,
      kind: e.kind,
      filePath: e.filePath,
      symbolKey: e.symbolKey,
      startLine: e.startLine,
      startColumn: e.startColumn,
      endLine: e.endLine,
      endColumn: e.endColumn,
      excerpt: e.excerpt,
      message: e.message,
      data: e.data,
    })),
    review: review ? { status: review.status, reason: review.reason } : null,
    rule: rule
      ? {
          id: rule.id,
          name: rule.name,
          description: rule.description,
          evaluation: rule.evaluation,
        }
      : null,
    isIndicator: row.certainty === "INDICATOR",
  };
}

// ---------------------------------------------------------------------------
// Review (triage) - never changes detection results
// ---------------------------------------------------------------------------

export const MAX_REVIEW_REASON = 500;

export async function setFindingReview(
  userId: string,
  findingId: string,
  input: {
    status: "ACKNOWLEDGED" | "DISMISSED" | null;
    reason?: string | null;
  },
  db: FindingsDb = prisma,
): Promise<{ review: { status: string; reason: string | null } | null }> {
  const finding = await requireOwnedFinding(db, userId, findingId);
  const where = {
    repositoryId_fingerprint: {
      repositoryId: finding.run.repositoryId,
      fingerprint: finding.fingerprint,
    },
  };

  if (input.status === null) {
    await db.findingReview.deleteMany({
      where: {
        repositoryId: finding.run.repositoryId,
        fingerprint: finding.fingerprint,
      },
    });
    return { review: null };
  }

  if (input.status !== "ACKNOWLEDGED" && input.status !== "DISMISSED") {
    throw new FindingsError("status is invalid.", "INVALID_INPUT");
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length > MAX_REVIEW_REASON || reason.includes("\0")) {
    throw new FindingsError("reason is invalid.", "INVALID_INPUT");
  }
  if (input.status === "DISMISSED" && reason.length === 0) {
    throw new FindingsError(
      "A reason is required to dismiss a finding.",
      "INVALID_INPUT",
    );
  }

  const saved = await db.findingReview.upsert({
    where,
    create: {
      repositoryId: finding.run.repositoryId,
      fingerprint: finding.fingerprint,
      status: input.status,
      reason: reason || null,
      reviewedById: userId,
    },
    update: {
      status: input.status,
      reason: reason || null,
      reviewedById: userId,
    },
    select: { status: true, reason: true },
  });

  return { review: { status: saved.status, reason: saved.reason } };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const FACT_RULE_IDS = new Set(
  RULE_CATALOGUE.filter((rule) => rule.usesSourceFacts).map((rule) => rule.id),
);

async function loadSide(
  db: FindingsDb,
  run: any,
): Promise<{ side: ComparisonSide; view: FindingsRunView }> {
  const [findings, ruleRuns, files] = await Promise.all([
    db.finding.findMany({
      where: { runId: run.id },
      select: {
        fingerprint: true,
        ruleId: true,
        ruleVersion: true,
        severity: true,
        subjectPath: true,
        subjectKey: true,
        title: true,
      },
    }),
    db.findingRuleRun.findMany({
      where: { runId: run.id },
      select: {
        ruleId: true,
        ruleVersion: true,
        status: true,
        configHash: true,
      },
    }),
    db.analysisFile.findMany({
      where: {
        analysisId: run.analysisId,
        status: { in: ["ANALYSED", "ANALYSED_WITH_ERRORS"] },
      },
      select: { path: true, contentHash: true },
    }),
  ]);

  const coverage = (run.coverage ?? {}) as {
    factsMissing?: Record<string, string>;
    truncated?: boolean;
  };

  return {
    view: toRunView(run),
    side: {
      analysisId: run.analysisId,
      complete:
        run.status === "COMPLETED" &&
        run.analysis.status === "COMPLETED" &&
        run.analysis.snapshotCompleteness === "COMPLETE",
      findings: findings as any[],
      ruleRuns: ruleRuns as any[],
      fileHashes: new Map(
        (files as any[]).map((f) => [f.path, f.contentHash] as const),
      ),
      factsMissing: new Map(Object.entries(coverage.factsMissing ?? {})),
      factsIncomplete: coverage.truncated === true,
      factRuleIds: FACT_RULE_IDS,
    },
  };
}

export interface FindingsComparisonView extends FindingsComparison {
  base: FindingsRunView;
  head: FindingsRunView;
}

export async function compareFindingsRuns(
  userId: string,
  baseRunId: string,
  headRunId: string,
  db: FindingsDb = prisma,
): Promise<FindingsComparisonView> {
  if (baseRunId === headRunId) {
    throw new FindingsError(
      "Choose two different runs to compare.",
      "INVALID_INPUT",
    );
  }

  const [baseRun, headRun] = await Promise.all([
    requireOwnedRun(db, userId, baseRunId),
    requireOwnedRun(db, userId, headRunId),
  ]);

  if (baseRun.repositoryId !== headRun.repositoryId) {
    throw new FindingsError(
      "Runs must belong to the same repository.",
      "INCOMPATIBLE_RUNS",
    );
  }

  for (const run of [baseRun, headRun]) {
    if (run.status !== "COMPLETED" && run.status !== "PARTIAL") {
      throw new FindingsError(
        "Both runs must have finished to be compared.",
        "INCOMPATIBLE_RUNS",
      );
    }
  }

  const [base, head] = await Promise.all([
    loadSide(db, baseRun),
    loadSide(db, headRun),
  ]);

  const comparison = compareFindings(base.side, head.side);

  const limitations = [...comparison.limitations];
  if (baseRun.engineVersion !== headRun.engineVersion) {
    limitations.push(
      "The runs used different engine versions; compare results with care.",
    );
  }

  return {
    ...comparison,
    limitations,
    base: base.view,
    head: head.view,
  };
}

// ---------------------------------------------------------------------------
// Analysis-scoped and snapshot-scoped entry points
// ---------------------------------------------------------------------------

/**
 * The run to show for an analysis: the requested one (which must belong to
 * that analysis and the caller) or the latest finished one. Findings from
 * different analyses are never mixed because every read is anchored to one run.
 */
async function resolveAnalysisRun(
  db: FindingsDb,
  userId: string,
  analysisId: string,
  runId?: string,
) {
  const run = await db.findingsRun.findFirst({
    where: {
      analysisId,
      repository: { ownerId: userId },
      ...(runId ? { id: runId } : { status: { in: ["COMPLETED", "PARTIAL"] } }),
    },
    orderBy: { createdAt: "desc" },
    select: RUN_SELECT,
  });
  if (!run) {
    throw new FindingsError(
      runId
        ? "Findings run not found."
        : "No findings have been generated for this analysis.",
      "NOT_FOUND",
    );
  }
  return run as any;
}

export async function listAnalysisFindings(
  userId: string,
  analysisId: string,
  options: { runId?: string; filters?: FindingFilters } = {},
  db: FindingsDb = prisma,
) {
  const run = await resolveAnalysisRun(db, userId, analysisId, options.runId);
  const page = await listFindings(userId, run.id, options.filters ?? {}, db);
  return { run: toRunView(run), ...page };
}

export async function getFindingEvidence(
  userId: string,
  findingId: string,
  db: FindingsDb = prisma,
) {
  const finding = await getFinding(userId, findingId, db);
  return {
    findingId: finding.id,
    runId: finding.runId,
    analysisId: finding.analysisId,
    snapshotId: finding.snapshotId,
    certainty: finding.certainty,
    isIndicator: finding.isIndicator,
    evidence: finding.evidence,
  };
}

/** The rules (and versions) a run used, with how each one finished. */
export async function getAnalysisRules(
  userId: string,
  analysisId: string,
  options: { runId?: string } = {},
  db: FindingsDb = prisma,
) {
  const run = await resolveAnalysisRun(db, userId, analysisId, options.runId);
  const { ruleRuns } = await getFindingsRun(userId, run.id, db);
  const catalogue = new Map(listRuleCatalogue().rules.map((r) => [r.id, r]));

  return {
    run: toRunView(run),
    rules: ruleRuns.map((ruleRun) => ({
      ...ruleRun,
      definition: catalogue.get(ruleRun.ruleId) ?? null,
    })),
  };
}

/**
 * History across the repository's runs. With `fingerprint`, the timeline of
 * one finding identity: the runs it was present in and its severity there.
 */
export async function getRepositoryFindingHistory(
  userId: string,
  repositoryId: string,
  options: { fingerprint?: string } = {},
  db: FindingsDb = prisma,
) {
  if (
    options.fingerprint !== undefined &&
    !/^fnd_[0-9a-f]{32}$/.test(options.fingerprint)
  ) {
    throw new FindingsError("fingerprint is invalid.", "INVALID_INPUT");
  }

  const { runs } = await listRepositoryFindingsRuns(userId, repositoryId, db);

  if (!options.fingerprint) return { runs, timeline: null };

  const rows = await db.finding.findMany({
    where: {
      fingerprint: options.fingerprint,
      run: { repositoryId, repository: { ownerId: userId } },
    },
    select: { id: true, runId: true, severity: true, ruleVersion: true },
  });
  const byRun = new Map((rows as any[]).map((row) => [row.runId, row]));

  return {
    runs,
    timeline: runs
      .slice()
      .reverse()
      .map((run) => {
        const hit = byRun.get(run.id);
        return {
          runId: run.id,
          commitSha: run.commitSha,
          createdAt: run.createdAt,
          runStatus: run.status,
          present: hit !== undefined,
          findingId: hit?.id ?? null,
          severity: hit?.severity ?? null,
          ruleVersion: hit?.ruleVersion ?? null,
        };
      }),
  };
}

async function latestRunForSnapshot(
  db: FindingsDb,
  userId: string,
  snapshotId: string,
) {
  const run = await db.findingsRun.findFirst({
    where: {
      analysis: { snapshotId },
      repository: { ownerId: userId },
      status: { in: ["COMPLETED", "PARTIAL"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return run as { id: string } | null;
}

/**
 * Compares the latest finished findings run of two snapshots. A snapshot with
 * no findings run is reported as missing: earlier findings are never marked
 * resolved because a newer run does not exist.
 */
export async function compareSnapshotFindings(
  userId: string,
  baseSnapshotId: string,
  headSnapshotId: string,
  db: FindingsDb = prisma,
): Promise<FindingsComparisonView> {
  if (baseSnapshotId === headSnapshotId) {
    throw new FindingsError(
      "Choose two different snapshots to compare.",
      "INVALID_INPUT",
    );
  }

  const [base, head] = await Promise.all([
    latestRunForSnapshot(db, userId, baseSnapshotId),
    latestRunForSnapshot(db, userId, headSnapshotId),
  ]);

  if (!base || !head) {
    throw new FindingsError(
      !head
        ? "The newer snapshot has no findings run yet, so nothing can be compared."
        : "The earlier snapshot has no findings run yet, so nothing can be compared.",
      "ANALYSIS_NOT_READY",
    );
  }

  return compareFindingsRuns(userId, base.id, head.id, db);
}

// ---------------------------------------------------------------------------
// Rule catalogue (documentation endpoint)
// ---------------------------------------------------------------------------

export function listRuleCatalogue() {
  return {
    rules: RULE_CATALOGUE.map((rule) => ({
      id: rule.id,
      name: rule.name,
      version: rule.version,
      category: rule.category,
      severities: rule.severities,
      severityPolicy: rule.severityPolicy,
      certainties: rule.certainties,
      requiresCompleteAnalysis: rule.requiresCompleteAnalysis,
      thresholdKeys: rule.thresholdKeys,
      description: rule.description,
      evaluation: rule.evaluation,
      evidenceRequirement: rule.evidenceRequirement,
      recommendation: rule.recommendation,
    })),
  };
}

export type { FindingSeverity };
