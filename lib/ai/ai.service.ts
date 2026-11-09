// lib/ai/ai.service.ts
//
// Conversation lifecycle and question answering. Everything is owner-scoped,
// bound to one snapshot/analysis, and independent of Gemini (the provider is
// injected). Nothing here reads storage directly: evidence arrives through the
// EvidenceReader port.
import { AIProviderError, type AIProvider } from "@/features/ai/providers/ai-provider";
import {
  classifyQuestion,
  extractTerms,
  QuestionError,
  validateQuestion,
} from "@/features/ai/assistant/question";
import { nextResetAt, usageDay } from "@/features/ai/assistant/config";
import type {
  AssistantAnswer,
  AssistantLimits,
  SnapshotScope,
} from "@/features/ai/assistant/contracts";
import { produceAnswer } from "@/features/ai/assistant/orchestrate";

import { AIError } from "./ai.errors";
import type { EvidenceReader } from "./ai.reader";
import { retrieveEvidence } from "./ai.retrieval";
import type {
  AIStore,
  ConversationRow,
  MessageDraft,
  MessageRow,
} from "./ai.store";

export interface AIDeps {
  store: AIStore;
  reader: EvidenceReader;
  provider: () => AIProvider;
  limits: AssistantLimits;
  now?: () => Date;
}

export const DEFAULT_TITLE = "New conversation";
export const MAX_TITLE = 120;
export const CONVERSATION_LIST_LIMIT = 100;
export const MESSAGE_PAGE_DEFAULT = 50;
export const MESSAGE_PAGE_MAX = 200;
const LOCK_SLACK_MS = 10_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const clock = (deps: AIDeps) => (deps.now ?? (() => new Date()))();

export function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AIError(`${name} is invalid.`, "INVALID_INPUT");
  }
  return value;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function normaliseTitle(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AIError("title must be text.", "INVALID_INPUT");
  }
  const title = raw.trim().replace(/\s+/g, " ");
  if (!title || title.length > MAX_TITLE || CONTROL.test(title)) {
    throw new AIError(
      `title must be 1-${MAX_TITLE} printable characters.`,
      "INVALID_INPUT",
    );
  }
  return title;
}

export function titleFromQuestion(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}

// --- views ------------------------------------------------------------------

export interface ConversationView {
  id: string;
  repositoryId: string;
  snapshotId: string;
  analysisId: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toConversationView(row: ConversationRow): ConversationView {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    snapshotId: row.snapshotId,
    analysisId: row.analysisId,
    title: row.title,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface MessageView {
  id: string;
  sequence: number;
  role: MessageRow["role"];
  status: MessageRow["status"];
  content: string;
  answer: unknown;
  /** Provenance of this message; independent of the conversation's current context. */
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  provider: string | null;
  model: string | null;
  totalTokens: number | null;
  errorCode: string | null;
  createdAt: string;
}

export function toMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    sequence: row.sequence,
    role: row.role,
    status: row.status,
    content: row.content,
    answer: row.answer ?? null,
    snapshotId: row.snapshotId,
    analysisId: row.analysisId,
    commitSha: row.commitSha,
    provider: row.provider,
    model: row.model,
    totalTokens: row.totalTokens,
    errorCode: row.errorCode,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requireConversation(
  deps: AIDeps,
  userId: string,
  conversationId: string,
): Promise<ConversationRow> {
  const row = await deps.store.findConversation(
    userId,
    requireId(conversationId, "conversationId"),
  );
  if (!row) throw new AIError("Conversation not found.", "NOT_FOUND");
  return row;
}

// --- conversations -----------------------------------------------------------

export async function createConversation(
  deps: AIDeps,
  userId: string,
  repositoryId: string,
  input: { snapshotId?: unknown; title?: unknown },
): Promise<ConversationView> {
  requireId(repositoryId, "repositoryId");
  if (!(await deps.store.repositoryExists(userId, repositoryId))) {
    throw new AIError("Repository not found.", "NOT_FOUND");
  }
  const snapshotId =
    input.snapshotId === undefined || input.snapshotId === null
      ? undefined
      : requireId(input.snapshotId, "snapshotId");
  const title =
    input.title === undefined || input.title === null
      ? DEFAULT_TITLE
      : normaliseTitle(input.title);

  const scope = await deps.store.resolveScope(userId, repositoryId, {
    snapshotId,
  });
  if (!scope) {
    throw new AIError(
      snapshotId
        ? "That snapshot has no completed analysis."
        : "Analyse a snapshot of this repository before asking questions.",
      snapshotId ? "NOT_FOUND" : "CONTEXT_UNAVAILABLE",
    );
  }

  const row = await deps.store.createConversation({
    userId,
    repositoryId,
    snapshotId: scope.snapshotId,
    analysisId: scope.analysisId,
    title,
  });
  return toConversationView(row);
}

export async function listConversations(
  deps: AIDeps,
  userId: string,
  repositoryId: string,
  archived: boolean,
) {
  requireId(repositoryId, "repositoryId");
  if (!(await deps.store.repositoryExists(userId, repositoryId))) {
    throw new AIError("Repository not found.", "NOT_FOUND");
  }
  const [rows, snapshots] = await Promise.all([
    deps.store.listConversations(
      userId,
      repositoryId,
      archived,
      CONVERSATION_LIST_LIMIT,
    ),
    deps.store.listSnapshotOptions(userId, repositoryId),
  ]);
  return {
    conversations: rows.map(toConversationView),
    snapshots: snapshots.map((s) => ({
      snapshotId: s.snapshotId,
      analysisId: s.analysisId,
      commitSha: s.commitSha,
      completeness: s.completeness,
      analysisStatus: s.analysisStatus,
      committedAt: s.committedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
  };
}

export async function getConversation(
  deps: AIDeps,
  userId: string,
  conversationId: string,
) {
  const row = await requireConversation(deps, userId, conversationId);
  const scope = await deps.store.resolveScope(userId, row.repositoryId, {
    analysisId: row.analysisId,
  });
  return {
    conversation: toConversationView(row),
    // null = the analysed snapshot is no longer available; never substituted.
    context: scope
      ? {
          snapshotId: scope.snapshotId,
          analysisId: scope.analysisId,
          commitSha: scope.commitSha,
          completeness: scope.completeness,
          analysisStatus: scope.analysisStatus,
        }
      : null,
  };
}

export interface UpdateInput {
  title?: unknown;
  archived?: unknown;
  snapshotId?: unknown;
}

export async function updateConversation(
  deps: AIDeps,
  userId: string,
  conversationId: string,
  input: UpdateInput,
): Promise<ConversationView> {
  const current = await requireConversation(deps, userId, conversationId);
  const patch: Parameters<AIStore["updateConversation"]>[2] = {};
  const keys = Object.keys(input).filter(
    (k) => (input as Record<string, unknown>)[k] !== undefined,
  );
  if (keys.length === 0) {
    throw new AIError("Nothing to update.", "INVALID_INPUT");
  }
  if (keys.some((k) => !["title", "archived", "snapshotId"].includes(k))) {
    throw new AIError("Unsupported field.", "INVALID_INPUT");
  }

  if (input.title !== undefined) patch.title = normaliseTitle(input.title);
  if (input.archived !== undefined) {
    if (typeof input.archived !== "boolean") {
      throw new AIError("archived must be true or false.", "INVALID_INPUT");
    }
    patch.archivedAt = input.archived ? clock(deps) : null;
  }

  let switchDraft: MessageDraft | null = null;
  if (input.snapshotId !== undefined) {
    const snapshotId = requireId(input.snapshotId, "snapshotId");
    if (snapshotId !== current.snapshotId) {
      if (current.archivedAt && input.archived !== false) {
        throw new AIError("Restore the conversation first.", "INVALID_INPUT");
      }
      const target = await deps.store.resolveScope(userId, current.repositoryId, {
        snapshotId,
      });
      if (!target) {
        throw new AIError(
          "That snapshot has no completed analysis.",
          "NOT_FOUND",
        );
      }
      const from = await deps.store.resolveScope(userId, current.repositoryId, {
        analysisId: current.analysisId,
      });
      patch.snapshotId = target.snapshotId;
      patch.analysisId = target.analysisId;
      switchDraft = {
        role: "SYSTEM",
        status: "COMPLETED",
        content: `Snapshot context switched from ${from?.commitSha.slice(0, 7) ?? "an unavailable snapshot"} to ${target.commitSha.slice(0, 7)}. Later answers use only the new snapshot.`,
        snapshotId: target.snapshotId,
        analysisId: target.analysisId,
        commitSha: target.commitSha,
        findingsRunId: target.findingsRunId,
        answer: null,
        retrieval: null,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        errorCode: null,
      };
    }
  }

  // A switch must not interleave with an in-flight answer.
  const now = clock(deps);
  let locked = false;
  if (switchDraft) {
    locked = await deps.store.acquireLock(
      current.id,
      now,
      new Date(now.getTime() + LOCK_SLACK_MS),
    );
    if (!locked) {
      throw new AIError(
        "A question is being answered. Try again in a moment.",
        "BUSY",
      );
    }
  }
  try {
    const row = await deps.store.updateConversation(userId, current.id, patch);
    if (!row) throw new AIError("Conversation not found.", "NOT_FOUND");
    if (switchDraft) await deps.store.appendMessages(current.id, [switchDraft]);
    return toConversationView(row);
  } finally {
    if (locked) await deps.store.releaseLock(current.id);
  }
}

export async function deleteConversation(
  deps: AIDeps,
  userId: string,
  conversationId: string,
): Promise<{ deleted: true }> {
  const ok = await deps.store.deleteConversation(
    userId,
    requireId(conversationId, "conversationId"),
  );
  if (!ok) throw new AIError("Conversation not found.", "NOT_FOUND");
  return { deleted: true };
}

export async function listMessages(
  deps: AIDeps,
  userId: string,
  conversationId: string,
  page: { limit?: number; after?: number } = {},
) {
  await requireConversation(deps, userId, conversationId);
  const limit = Math.min(
    MESSAGE_PAGE_MAX,
    Math.max(1, page.limit ?? MESSAGE_PAGE_DEFAULT),
  );
  const rows = await deps.store.listMessages(userId, conversationId, {
    limit: limit + 1,
    afterSequence: Math.max(0, page.after ?? 0),
  });
  const slice = rows.slice(0, limit);
  return {
    messages: slice.map(toMessageView),
    nextAfter: rows.length > limit ? slice[slice.length - 1].sequence : null,
  };
}

// --- usage ------------------------------------------------------------------

export async function getUsage(deps: AIDeps, userId: string) {
  const now = clock(deps);
  const used = await deps.store.getUsageDay(userId, usageDay(now));
  return {
    day: usageDay(now),
    requestsUsed: used.requestCount,
    requestLimit: deps.limits.dailyRequestLimit,
    tokensUsed: used.tokenCount,
    tokenLimit: deps.limits.dailyTokenLimit,
    resetsAt: nextResetAt(now).toISOString(),
    limits: {
      maxQuestionChars: deps.limits.maxQuestionChars,
      maxOutputTokens: deps.limits.maxOutputTokens,
    },
  };
}

function limitError(deps: AIDeps, now: Date) {
  const resetsAt = nextResetAt(now).toISOString();
  return new AIError(
    "The daily AI allowance has been used. It resets at 00:00 UTC.",
    "LIMIT_EXCEEDED",
    { status: 429, resetsAt },
  );
}

// --- answering ----------------------------------------------------------------

function answerText(answer: AssistantAnswer): string {
  return answer.sections.map((s) => s.text).join("\n\n");
}

const PROVIDER_STATUS: Record<AIProviderError["code"], number> = {
  NOT_CONFIGURED: 503,
  TIMEOUT: 504,
  RATE_LIMITED: 503,
  PROVIDER_UNAVAILABLE: 502,
  BLOCKED: 502,
  MALFORMED_RESPONSE: 502,
};

export async function sendMessage(
  deps: AIDeps,
  userId: string,
  conversationId: string,
  input: { question?: unknown },
) {
  const conversation = await requireConversation(deps, userId, conversationId);

  let question: string;
  try {
    question = validateQuestion(input.question, deps.limits.maxQuestionChars);
  } catch (error) {
    if (error instanceof QuestionError) {
      throw new AIError(error.message, "INVALID_INPUT");
    }
    throw error;
  }
  if (conversation.archivedAt) {
    throw new AIError(
      "Restore the conversation before asking a new question.",
      "INVALID_INPUT",
    );
  }

  // The conversation's own snapshot - never a newer one.
  const scope = await deps.store.resolveScope(userId, conversation.repositoryId, {
    analysisId: conversation.analysisId,
  });
  if (!scope) {
    throw new AIError(
      "The snapshot for this conversation is no longer available. Switch to another snapshot to continue.",
      "CONTEXT_UNAVAILABLE",
    );
  }

  const startedAt = clock(deps);
  const day = usageDay(startedAt);
  const used = await deps.store.getUsageDay(userId, day);
  if (
    used.requestCount >= deps.limits.dailyRequestLimit ||
    used.tokenCount >= deps.limits.dailyTokenLimit
  ) {
    throw limitError(deps, startedAt);
  }

  const until = new Date(
    startedAt.getTime() + deps.limits.requestTimeoutMs + LOCK_SLACK_MS,
  );
  if (!(await deps.store.acquireLock(conversation.id, startedAt, until))) {
    throw new AIError(
      "This conversation is already answering a question.",
      "BUSY",
    );
  }

  const base = {
    snapshotId: scope.snapshotId,
    analysisId: scope.analysisId,
    commitSha: scope.commitSha,
    findingsRunId: scope.findingsRunId,
  };
  const userDraft: MessageDraft = {
    ...base,
    role: "USER",
    status: "COMPLETED",
    content: question,
    answer: null,
    retrieval: null,
    provider: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    errorCode: null,
  };

  try {
    const category = classifyQuestion(question);
    const terms = extractTerms(question);
    const candidates = await retrieveEvidence(deps.reader, {
      scope,
      terms,
      category,
    });

    let reserved = false;
    let providerName = "unknown";
    let result;
    try {
      const provider = deps.provider();
      providerName = provider.name;
      result = await produceAnswer({
        provider,
        limits: deps.limits,
        question,
        category,
        terms,
        scope,
        candidates,
        beforeProvider: async () => {
          // Atomic: concurrent requests cannot slip past the daily allowance.
          if (
            !(await deps.store.reserveRequest(userId, day, {
              requests: deps.limits.dailyRequestLimit,
              tokens: deps.limits.dailyTokenLimit,
            }))
          ) {
            throw limitError(deps, startedAt);
          }
          reserved = true;
        },
      });
    } catch (error) {
      if (error instanceof AIProviderError) {
        const durationMs = clock(deps).getTime() - startedAt.getTime();
        const [userRow, failedRow] = await deps.store.appendMessages(
          conversation.id,
          [
            userDraft,
            {
              ...userDraft,
              role: "ASSISTANT",
              status: "FAILED",
              content: error.message,
              provider: providerName,
              errorCode: error.code,
            },
          ],
        );
        if (reserved) {
          await deps.store.recordUsage(day, {
            userId,
            conversationId: conversation.id,
            messageId: failedRow.id,
            provider: providerName,
            model: "unknown",
            status: "FAILED",
            inputTokens: null,
            outputTokens: null,
            totalTokens: null,
            errorCode: error.code,
            durationMs,
          });
        }
        if (error.detail) console.error("AI provider failure:", error.code, error.detail);
        throw new AIError(error.message, "PROVIDER_ERROR", {
          status: PROVIDER_STATUS[error.code],
          retryable: error.retryable,
          data: {
            code: error.code,
            messages: [toMessageView(userRow), toMessageView(failedRow)],
          },
        });
      }
      throw error;
    }

    const usage = result.usage;
    const [userRow, assistantRow] = await deps.store.appendMessages(
      conversation.id,
      [
        userDraft,
        {
          ...base,
          role: "ASSISTANT",
          status: "COMPLETED",
          content: answerText(result.answer),
          answer: result.answer,
          retrieval: result.retrieval,
          provider: result.provider,
          model: result.model,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          totalTokens: usage?.totalTokens ?? null,
          errorCode: null,
        },
      ],
    );

    if (result.providerCalled) {
      await deps.store.recordUsage(day, {
        userId,
        conversationId: conversation.id,
        messageId: assistantRow.id,
        provider: result.provider ?? "unknown",
        model: result.model ?? "unknown",
        status: "SUCCEEDED",
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        errorCode: null,
        durationMs: clock(deps).getTime() - startedAt.getTime(),
      });
    }

    if (conversation.title === DEFAULT_TITLE) {
      await deps.store.updateConversation(userId, conversation.id, {
        title: titleFromQuestion(question),
      });
    }

    return {
      messages: [toMessageView(userRow), toMessageView(assistantRow)],
    };
  } finally {
    await deps.store.releaseLock(conversation.id);
  }
}

export type { SnapshotScope };
