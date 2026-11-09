// lib/ai/ai.store.ts
//
// Persistence port for conversations, messages and usage. All methods that take
// a userId must scope their query by that owner; another user's rows are
// indistinguishable from missing ones.
import type { SnapshotScope } from "@/features/ai/assistant/contracts";

export interface ConversationRow {
  id: string;
  userId: string;
  repositoryId: string;
  snapshotId: string;
  analysisId: string;
  title: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  sequence: number;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  status: "COMPLETED" | "FAILED";
  content: string;
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  findingsRunId: string | null;
  answer: unknown;
  retrieval: unknown;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  errorCode: string | null;
  createdAt: Date;
}

export type MessageDraft = Omit<
  MessageRow,
  "id" | "conversationId" | "sequence" | "createdAt"
>;

export interface SnapshotOption {
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  completeness: string | null;
  analysisStatus: string;
  committedAt: Date | null;
  createdAt: Date;
}

export interface UsageDayRow {
  requestCount: number;
  tokenCount: number;
}

export interface UsageRecordInput {
  userId: string;
  conversationId: string;
  messageId: string | null;
  provider: string;
  model: string;
  status: "SUCCEEDED" | "FAILED";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  errorCode: string | null;
  durationMs: number;
}

export interface AIStore {
  /** Owned repository (or null). */
  repositoryExists(userId: string, repositoryId: string): Promise<boolean>;
  /**
   * Resolves the analysis context. With `snapshotId`: the latest usable
   * analysis of that owned snapshot. With `analysisId`: exactly that analysis.
   * With neither: the repository's newest snapshot that has a usable analysis.
   * Usable = COMPLETED or PARTIAL.
   */
  resolveScope(
    userId: string,
    repositoryId: string,
    selector: { snapshotId?: string; analysisId?: string },
  ): Promise<SnapshotScope | null>;
  listSnapshotOptions(
    userId: string,
    repositoryId: string,
  ): Promise<SnapshotOption[]>;

  createConversation(input: {
    userId: string;
    repositoryId: string;
    snapshotId: string;
    analysisId: string;
    title: string;
  }): Promise<ConversationRow>;
  listConversations(
    userId: string,
    repositoryId: string,
    archived: boolean,
    limit: number,
  ): Promise<ConversationRow[]>;
  findConversation(
    userId: string,
    conversationId: string,
  ): Promise<ConversationRow | null>;
  updateConversation(
    userId: string,
    conversationId: string,
    patch: {
      title?: string;
      archivedAt?: Date | null;
      snapshotId?: string;
      analysisId?: string;
    },
  ): Promise<ConversationRow | null>;
  /** True when a row was deleted. */
  deleteConversation(userId: string, conversationId: string): Promise<boolean>;
  listMessages(
    userId: string,
    conversationId: string,
    page: { limit: number; afterSequence: number },
  ): Promise<MessageRow[]>;

  /** Single-flight guard. True when the lock was taken. */
  acquireLock(conversationId: string, now: Date, until: Date): Promise<boolean>;
  releaseLock(conversationId: string): Promise<void>;
  /** Appends drafts with consecutive sequence numbers, atomically. */
  appendMessages(
    conversationId: string,
    drafts: MessageDraft[],
  ): Promise<MessageRow[]>;

  getUsageDay(userId: string, day: string): Promise<UsageDayRow>;
  /**
   * Atomically counts one request against today's allowance. False when the
   * request or token allowance is already used up (race-safe).
   */
  reserveRequest(
    userId: string,
    day: string,
    limits: { requests: number; tokens: number },
  ): Promise<boolean>;
  recordUsage(day: string, record: UsageRecordInput): Promise<void>;
}
