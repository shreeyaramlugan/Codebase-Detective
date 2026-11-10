// lib/research/research.prisma-store.ts
//
// Prisma implementation of ResearchStore. Every query is scoped by the owning
// user; another user's rows are indistinguishable from missing ones.
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { prismaAIStore } from "@/lib/ai/ai.prisma-store";
import type { SourceRecord } from "@/features/research/engine/contracts";

import type {
  RecommendationRow,
  ResearchStore,
  RunRow,
  RunSourceRow,
} from "./research.store";

const json = (value: unknown) => value as Prisma.InputJsonValue;

function toRun(r: {
  [k: string]: unknown;
}): RunRow {
  return r as unknown as RunRow;
}

function toRecommendation(r: Record<string, unknown>): RecommendationRow {
  return r as unknown as RecommendationRow;
}

export const prismaResearchStore: ResearchStore = {
  async repositoryExists(userId, repositoryId) {
    const row = await prisma.repository.findFirst({
      where: { id: repositoryId, ownerId: userId },
      select: { id: true },
    });
    return row !== null;
  },

  resolveScope(userId, repositoryId, selector) {
    return prismaAIStore.resolveScope(userId, repositoryId, selector);
  },

  async findFinding(userId, findingId) {
    const f = await prisma.finding.findFirst({
      where: { id: findingId, run: { repository: { ownerId: userId } } },
      include: {
        evidence: { orderBy: { ordinal: "asc" }, take: 6 },
        run: { select: { repositoryId: true, analysisId: true, analysis: { select: { snapshotId: true } } } },
      },
    });
    if (!f) return null;
    return {
      id: f.id,
      fingerprint: f.fingerprint,
      ruleId: f.ruleId,
      severity: f.severity,
      certainty: f.certainty,
      title: f.title,
      description: f.description,
      subjectPath: f.subjectPath,
      primaryLine: f.primaryLine,
      measurements: f.measurements,
      evidence: f.evidence.map((e) => ({
        message: e.message,
        filePath: e.filePath,
        startLine: e.startLine,
        endLine: e.endLine,
      })),
      repositoryId: f.run.repositoryId,
      analysisId: f.run.analysisId,
      snapshotId: f.run.analysis.snapshotId,
    };
  },

  async createRun(draft, lockUntil) {
    const row = await prisma.researchRun.create({
      data: {
        ...draft,
        queries: json(draft.queries),
        busyUntil: lockUntil,
        status: "DISCOVERING",
      },
    });
    return toRun(row);
  },

  async findRun(userId, runId) {
    const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
    return row ? toRun(row) : null;
  },

  async listRuns(userId, repositoryId, opts) {
    const rows = await prisma.researchRun.findMany({
      where: {
        userId,
        repositoryId,
        archivedAt: opts.archived ? { not: null } : null,
        ...(opts.findingFingerprint ? { findingFingerprint: opts.findingFingerprint } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: opts.limit,
    });
    return rows.map(toRun);
  },

  async updateRun(userId, runId, patch) {
    const result = await prisma.researchRun.updateMany({ where: { id: runId, userId }, data: patch });
    if (result.count === 0) return null;
    const row = await prisma.researchRun.findFirst({ where: { id: runId, userId } });
    return row ? toRun(row) : null;
  },

  async deleteRun(userId, runId) {
    const result = await prisma.researchRun.deleteMany({ where: { id: runId, userId } });
    return result.count === 1;
  },

  async acquireLock(runId, now, until, requireStatus) {
    const result = await prisma.researchRun.updateMany({
      where: {
        id: runId,
        ...(requireStatus ? { status: requireStatus } : {}),
        OR: [{ busyUntil: null }, { busyUntil: { lt: now } }],
      },
      data: { busyUntil: until },
    });
    return result.count === 1;
  },

  async releaseLock(runId) {
    await prisma.researchRun.updateMany({ where: { id: runId }, data: { busyUntil: null } });
  },

  async saveDiscovery(runId, data) {
    await prisma.$transaction([
      prisma.researchRunSource.createMany({
        data: data.sources.map((s) => ({
          runId,
          sourceKey: s.sourceKey,
          position: s.position,
          record: json(s.record),
          evaluation: json(s.evaluation),
          passages: json(s.passages),
          queryOrdinals: json(s.queryOrdinals),
          reused: s.reused,
          included: s.record.availability !== "UNAVAILABLE" && s.record.contentLevel !== "METADATA_ONLY",
        })),
      }),
      prisma.researchRun.updateMany({
        where: { id: runId, status: "DISCOVERING" },
        data: {
          status: "AWAITING_REVIEW",
          diagnostics: json(data.diagnostics),
          discarded: json(data.discarded),
          partial: data.partial,
        },
      }),
    ]);
  },

  async failRun(runId, errorCode) {
    await prisma.researchRun.updateMany({
      where: { id: runId, status: { in: ["DISCOVERING", "SYNTHESIZING"] } },
      data: { status: "FAILED", errorCode },
    });
  },

  async listRunSources(userId, runId) {
    const rows = await prisma.researchRunSource.findMany({
      where: { runId, run: { userId } },
      orderBy: { position: "asc" },
    });
    return rows as unknown as RunSourceRow[];
  },

  async setIncluded(userId, runId, included) {
    return prisma.$transaction(async (tx) => {
      const run = await tx.researchRun.findFirst({
        where: { id: runId, userId, status: "AWAITING_REVIEW" },
        select: { id: true },
      });
      if (!run) return false;
      for (const [sourceKey, value] of Object.entries(included)) {
        await tx.researchRunSource.updateMany({ where: { runId, sourceKey }, data: { included: value } });
      }
      return true;
    });
  },

  async saveSynthesis(runId, data) {
    await prisma.$transaction([
      prisma.researchRecommendation.createMany({
        data: data.recommendations.map((r) => ({
          runId,
          ordinal: r.ordinal,
          title: r.title,
          concise: r.concise,
          detail: r.detail,
          basis: r.basis,
          repositoryCitations: json(r.repositoryCitations),
          sourceCitations: json(r.sourceCitations),
        })),
      }),
      prisma.researchRun.updateMany({
        where: { id: runId, status: { in: ["AWAITING_REVIEW", "SYNTHESIZING"] } },
        data: {
          status: "COMPLETED",
          synthesis: json(data.synthesis),
          provider: data.provider,
          model: data.model,
          totalTokens: data.totalTokens,
          completedAt: new Date(),
        },
      }),
    ]);
  },

  async listRecommendations(userId, runId) {
    const rows = await prisma.researchRecommendation.findMany({
      where: { runId, run: { userId } },
      orderBy: { ordinal: "asc" },
    });
    return rows.map((r) => toRecommendation(r as unknown as Record<string, unknown>));
  },

  async findRecommendation(userId, id) {
    const row = await prisma.researchRecommendation.findFirst({ where: { id, run: { userId } } });
    return row ? toRecommendation(row as unknown as Record<string, unknown>) : null;
  },

  async updateRecommendation(userId, id, patch, now) {
    const result = await prisma.researchRecommendation.updateMany({
      where: { id, run: { userId } },
      data: { ...patch, ...(patch.status ? { statusChangedAt: now } : {}) },
    });
    if (result.count === 0) return null;
    const row = await prisma.researchRecommendation.findFirst({ where: { id, run: { userId } } });
    return row ? toRecommendation(row as unknown as Record<string, unknown>) : null;
  },

  async findCachedSource(userId, canonicalUrl, now) {
    const row = await prisma.researchSource.findFirst({
      where: { userId, canonicalUrl, expiresAt: { gt: now } },
    });
    return row ? (row.record as unknown as SourceRecord) : null;
  },

  async cacheSources(userId, entries) {
    for (const { record, expiresAt } of entries) {
      await prisma.researchSource.upsert({
        where: { userId_sourceKey: { userId, sourceKey: record.sourceKey } },
        create: {
          userId,
          sourceKey: record.sourceKey,
          canonicalUrl: record.canonicalUrl,
          record: json(record),
          retrievedAt: new Date(record.retrievedAt),
          expiresAt,
        },
        update: {
          canonicalUrl: record.canonicalUrl,
          record: json(record),
          retrievedAt: new Date(record.retrievedAt),
          expiresAt,
        },
      });
    }
  },

  async getUsage(userId, day) {
    const row = await prisma.researchUsageDay.findUnique({ where: { userId_day: { userId, day } } });
    return {
      runCount: row?.runCount ?? 0,
      synthesisCount: row?.synthesisCount ?? 0,
      tokenCount: row?.tokenCount ?? 0,
      providerRequestCount: row?.providerRequestCount ?? 0,
    };
  },

  async reserve(userId, day, counter, limit, tokenLimit) {
    await prisma.researchUsageDay.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day },
      update: {},
    });
    // Conditional atomic increment: only one concurrent caller takes the last slot.
    const where: Prisma.ResearchUsageDayWhereInput = { userId, day };
    where[counter] = { lt: limit };
    if (tokenLimit !== undefined) where.tokenCount = { lt: tokenLimit };
    const data: Prisma.ResearchUsageDayUpdateManyMutationInput = {};
    data[counter] = { increment: 1 };
    const result = await prisma.researchUsageDay.updateMany({ where, data });
    return result.count === 1;
  },

  async recordUsage(userId, day, record) {
    const { runId, ...audit } = record;
    void runId;
    await prisma.$transaction([
      prisma.aIUsageRecord.create({ data: { userId, ...audit } }),
      ...(record.totalTokens
        ? [
            prisma.researchUsageDay.updateMany({
              where: { userId, day },
              data: { tokenCount: { increment: record.totalTokens } },
            }),
          ]
        : []),
    ]);
  },
};
