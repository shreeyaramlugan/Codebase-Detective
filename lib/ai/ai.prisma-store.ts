// lib/ai/ai.prisma-store.ts
//
// Prisma implementation of AIStore. Every query is scoped by the owning user.
import { Prisma } from "@prisma/client";

import type { SnapshotScope } from "@/features/ai/assistant/contracts";
import { prisma } from "@/lib/db/prisma";

import type {
  AIStore,
  ConversationRow,
  MessageRow,
  SnapshotOption,
} from "./ai.store";

const USABLE = ["COMPLETED", "PARTIAL"] as const;

const conversationSelect = {
  id: true,
  userId: true,
  repositoryId: true,
  snapshotId: true,
  analysisId: true,
  title: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const analysisInclude = {
  repository: { select: { fullName: true } },
  snapshot: { select: { commitSha: true, createdAt: true, committedAt: true } },
} as const;

type AnalysisWithContext = Prisma.CodeAnalysisGetPayload<{
  include: typeof analysisInclude;
}>;

async function toScope(analysis: AnalysisWithContext): Promise<SnapshotScope> {
  const run = await prisma.findingsRun.findFirst({
    where: { analysisId: analysis.id, status: { in: [...USABLE] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return {
    repositoryId: analysis.repositoryId,
    repositoryName: analysis.repository.fullName,
    snapshotId: analysis.snapshotId,
    analysisId: analysis.id,
    commitSha: analysis.snapshot.commitSha,
    completeness: analysis.snapshotCompleteness,
    analysisStatus: analysis.status,
    findingsRunId: run?.id ?? null,
  };
}

export const prismaAIStore: AIStore = {
  async repositoryExists(userId, repositoryId) {
    const row = await prisma.repository.findFirst({
      where: { id: repositoryId, ownerId: userId },
      select: { id: true },
    });
    return row !== null;
  },

  async resolveScope(userId, repositoryId, selector) {
    const where: Prisma.CodeAnalysisWhereInput = {
      repositoryId,
      repository: { ownerId: userId },
      status: { in: [...USABLE] },
      ...(selector.analysisId ? { id: selector.analysisId } : {}),
      ...(selector.snapshotId ? { snapshotId: selector.snapshotId } : {}),
    };
    const analysis = await prisma.codeAnalysis.findFirst({
      where,
      include: analysisInclude,
      orderBy: selector.analysisId
        ? { createdAt: "desc" }
        : [{ snapshot: { createdAt: "desc" } }, { createdAt: "desc" }],
    });
    return analysis ? toScope(analysis) : null;
  },

  async listSnapshotOptions(userId, repositoryId): Promise<SnapshotOption[]> {
    const analyses = await prisma.codeAnalysis.findMany({
      where: {
        repositoryId,
        repository: { ownerId: userId },
        status: { in: [...USABLE] },
      },
      include: analysisInclude,
      orderBy: [{ snapshot: { createdAt: "desc" } }, { createdAt: "desc" }],
      take: 200,
    });
    // Newest usable analysis per snapshot.
    const seen = new Set<string>();
    const options: SnapshotOption[] = [];
    for (const a of analyses) {
      if (seen.has(a.snapshotId)) continue;
      seen.add(a.snapshotId);
      options.push({
        snapshotId: a.snapshotId,
        analysisId: a.id,
        commitSha: a.snapshot.commitSha,
        completeness: a.snapshotCompleteness,
        analysisStatus: a.status,
        committedAt: a.snapshot.committedAt,
        createdAt: a.snapshot.createdAt,
      });
    }
    return options;
  },

  async createConversation(input): Promise<ConversationRow> {
    return prisma.aIConversation.create({
      data: input,
      select: conversationSelect,
    });
  },

  async listConversations(userId, repositoryId, archived, limit) {
    return prisma.aIConversation.findMany({
      where: {
        userId,
        repositoryId,
        archivedAt: archived ? { not: null } : null,
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: conversationSelect,
    });
  },

  async findConversation(userId, conversationId) {
    return prisma.aIConversation.findFirst({
      where: { id: conversationId, userId },
      select: conversationSelect,
    });
  },

  async updateConversation(userId, conversationId, patch) {
    const result = await prisma.aIConversation.updateMany({
      where: { id: conversationId, userId },
      data: patch,
    });
    if (result.count === 0) return null;
    return prisma.aIConversation.findFirst({
      where: { id: conversationId, userId },
      select: conversationSelect,
    });
  },

  async deleteConversation(userId, conversationId) {
    const result = await prisma.aIConversation.deleteMany({
      where: { id: conversationId, userId },
    });
    return result.count > 0;
  },

  async listMessages(userId, conversationId, page): Promise<MessageRow[]> {
    const rows = await prisma.aIMessage.findMany({
      where: {
        conversationId,
        conversation: { userId },
        sequence: { gt: page.afterSequence },
      },
      orderBy: { sequence: "asc" },
      take: page.limit,
    });
    return rows as unknown as MessageRow[];
  },

  async acquireLock(conversationId, now, until) {
    const result = await prisma.aIConversation.updateMany({
      where: {
        id: conversationId,
        OR: [{ busyUntil: null }, { busyUntil: { lt: now } }],
      },
      data: { busyUntil: until },
    });
    return result.count === 1;
  },

  async releaseLock(conversationId) {
    await prisma.aIConversation.updateMany({
      where: { id: conversationId },
      data: { busyUntil: null },
    });
  },

  async appendMessages(conversationId, drafts): Promise<MessageRow[]> {
    return prisma.$transaction(async (tx) => {
      const conversation = await tx.aIConversation.update({
        where: { id: conversationId },
        data: { lastSequence: { increment: drafts.length } },
        select: { lastSequence: true },
      });
      const first = conversation.lastSequence - drafts.length + 1;
      const created: MessageRow[] = [];
      for (const [index, draft] of drafts.entries()) {
        const row = await tx.aIMessage.create({
          data: {
            conversationId,
            sequence: first + index,
            role: draft.role,
            status: draft.status,
            content: draft.content,
            snapshotId: draft.snapshotId,
            analysisId: draft.analysisId,
            commitSha: draft.commitSha,
            findingsRunId: draft.findingsRunId,
            answer:
              draft.answer === null || draft.answer === undefined
                ? Prisma.JsonNull
                : (draft.answer as Prisma.InputJsonValue),
            retrieval:
              draft.retrieval === null || draft.retrieval === undefined
                ? Prisma.JsonNull
                : (draft.retrieval as Prisma.InputJsonValue),
            provider: draft.provider,
            model: draft.model,
            inputTokens: draft.inputTokens,
            outputTokens: draft.outputTokens,
            totalTokens: draft.totalTokens,
            errorCode: draft.errorCode,
          },
        });
        created.push(row as unknown as MessageRow);
      }
      return created;
    });
  },

  async getUsageDay(userId, day) {
    const row = await prisma.aIUsageDay.findUnique({
      where: { userId_day: { userId, day } },
      select: { requestCount: true, tokenCount: true },
    });
    return row ?? { requestCount: 0, tokenCount: 0 };
  },

  async reserveRequest(userId, day, limits) {
    await prisma.aIUsageDay.upsert({
      where: { userId_day: { userId, day } },
      create: { userId, day },
      update: {},
    });
    // Conditional atomic increment: only one concurrent request can take the
    // last slot.
    const result = await prisma.aIUsageDay.updateMany({
      where: {
        userId,
        day,
        requestCount: { lt: limits.requests },
        tokenCount: { lt: limits.tokens },
      },
      data: { requestCount: { increment: 1 } },
    });
    return result.count === 1;
  },

  async recordUsage(day, record) {
    await prisma.$transaction([
      prisma.aIUsageRecord.create({ data: record }),
      ...(record.totalTokens
        ? [
            prisma.aIUsageDay.updateMany({
              where: { userId: record.userId, day },
              data: { tokenCount: { increment: record.totalTokens } },
            }),
          ]
        : []),
    ]);
  },
};
