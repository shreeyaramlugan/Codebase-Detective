// tests/fixtures/ai/fakes.ts
//
// In-memory AIStore and EvidenceReader for assistant tests. The store mirrors
// the production semantics that matter: owner scoping, single-flight lock,
// atomic usage reservation, per-message provenance.
import { DEFAULT_LIMITS } from "../../../features/ai/assistant/config";
import type {
  AssistantLimits,
  SnapshotScope,
} from "@/features/ai/assistant/contracts";
import type {
  AIProvider,
  AIRequest,
  AIResponse,
} from "@/features/ai/providers/ai-provider";
import type { EvidenceReader } from "@/lib/ai/ai.reader";
import type { AIDeps } from "@/lib/ai/ai.service";
import type {
  AIStore,
  ConversationRow,
  MessageRow,
  SnapshotOption,
  UsageRecordInput,
} from "@/lib/ai/ai.store";

export function makeScope(over: Partial<SnapshotScope> = {}): SnapshotScope {
  return {
    repositoryId: "repo1",
    repositoryName: "acme/app",
    snapshotId: "snap1",
    analysisId: "an1",
    commitSha: "aaaaaaa1111111",
    completeness: "COMPLETE",
    analysisStatus: "COMPLETED",
    findingsRunId: null,
    ...over,
  };
}

export class FakeStore implements AIStore {
  /** repositoryId -> owner */
  repos = new Map<string, string>([["repo1", "u1"]]);
  /** analysis scopes by analysisId */
  scopes = new Map<string, SnapshotScope>([
    ["an1", makeScope()],
    [
      "an2",
      makeScope({ snapshotId: "snap2", analysisId: "an2", commitSha: "bbbbbbb2222222" }),
    ],
  ]);
  conversations = new Map<string, ConversationRow>();
  messages: MessageRow[] = [];
  locks = new Map<string, Date>();
  usageDays = new Map<string, { requestCount: number; tokenCount: number }>();
  usageRecords: UsageRecordInput[] = [];
  private seq = new Map<string, number>();
  private n = 0;

  async repositoryExists(userId: string, repositoryId: string) {
    return this.repos.get(repositoryId) === userId;
  }

  async resolveScope(
    userId: string,
    repositoryId: string,
    sel: { snapshotId?: string; analysisId?: string },
  ) {
    if (this.repos.get(repositoryId) !== userId) return null;
    const all = [...this.scopes.values()].filter(
      (s) => s.repositoryId === repositoryId,
    );
    if (sel.analysisId) return all.find((s) => s.analysisId === sel.analysisId) ?? null;
    if (sel.snapshotId) return all.find((s) => s.snapshotId === sel.snapshotId) ?? null;
    return all[all.length - 1] ?? null;
  }

  async listSnapshotOptions(userId: string, repositoryId: string) {
    if (this.repos.get(repositoryId) !== userId) return [];
    return [...this.scopes.values()]
      .filter((s) => s.repositoryId === repositoryId)
      .map(
        (s): SnapshotOption => ({
          snapshotId: s.snapshotId,
          analysisId: s.analysisId,
          commitSha: s.commitSha,
          completeness: s.completeness,
          analysisStatus: s.analysisStatus,
          committedAt: null,
          createdAt: new Date(0),
        }),
      );
  }

  async createConversation(input: {
    userId: string;
    repositoryId: string;
    snapshotId: string;
    analysisId: string;
    title: string;
  }) {
    const row: ConversationRow = {
      id: `c${++this.n}`,
      ...input,
      archivedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.conversations.set(row.id, row);
    return row;
  }

  async listConversations(
    userId: string,
    repositoryId: string,
    archived: boolean,
    limit: number,
  ) {
    return [...this.conversations.values()]
      .filter(
        (c) =>
          c.userId === userId &&
          c.repositoryId === repositoryId &&
          (c.archivedAt !== null) === archived,
      )
      .slice(0, limit);
  }

  async findConversation(userId: string, id: string) {
    const c = this.conversations.get(id);
    return c && c.userId === userId ? c : null;
  }

  async updateConversation(
    userId: string,
    id: string,
    patch: Partial<ConversationRow>,
  ) {
    const c = await this.findConversation(userId, id);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: new Date() });
    return c;
  }

  async deleteConversation(userId: string, id: string) {
    const c = await this.findConversation(userId, id);
    if (!c) return false;
    this.conversations.delete(id);
    this.messages = this.messages.filter((m) => m.conversationId !== id);
    for (const r of this.usageRecords) {
      if (r.conversationId === id) r.conversationId = "";
    }
    return true;
  }

  async listMessages(
    userId: string,
    conversationId: string,
    page: { limit: number; afterSequence: number },
  ) {
    if (!(await this.findConversation(userId, conversationId))) return [];
    return this.messages
      .filter(
        (m) => m.conversationId === conversationId && m.sequence > page.afterSequence,
      )
      .slice(0, page.limit);
  }

  async acquireLock(id: string, now: Date, until: Date) {
    const held = this.locks.get(id);
    if (held && held > now) return false;
    this.locks.set(id, until);
    return true;
  }

  async releaseLock(id: string) {
    this.locks.delete(id);
  }

  async appendMessages(
    conversationId: string,
    drafts: Array<Omit<MessageRow, "id" | "conversationId" | "sequence" | "createdAt">>,
  ) {
    return drafts.map((d) => {
      const sequence = (this.seq.get(conversationId) ?? 0) + 1;
      this.seq.set(conversationId, sequence);
      const row: MessageRow = {
        ...d,
        id: `m${++this.n}`,
        conversationId,
        sequence,
        createdAt: new Date(),
      };
      this.messages.push(row);
      return row;
    });
  }

  async getUsageDay(userId: string, day: string) {
    return this.usageDays.get(`${userId}|${day}`) ?? { requestCount: 0, tokenCount: 0 };
  }

  async reserveRequest(
    userId: string,
    day: string,
    limits: { requests: number; tokens: number },
  ) {
    const key = `${userId}|${day}`;
    const cur = this.usageDays.get(key) ?? { requestCount: 0, tokenCount: 0 };
    if (cur.requestCount >= limits.requests || cur.tokenCount >= limits.tokens) {
      return false;
    }
    this.usageDays.set(key, { ...cur, requestCount: cur.requestCount + 1 });
    return true;
  }

  async recordUsage(day: string, record: UsageRecordInput) {
    this.usageRecords.push(record);
    const key = `${record.userId}|${day}`;
    const cur = this.usageDays.get(key) ?? { requestCount: 0, tokenCount: 0 };
    this.usageDays.set(key, {
      ...cur,
      tokenCount: cur.tokenCount + (record.totalTokens ?? 0),
    });
  }
}

type R = EvidenceReader;

export class EmptyReader implements EvidenceReader {
  async overview(..._a: Parameters<R["overview"]>): ReturnType<R["overview"]> {
    return {
      files: 3,
      analysedFiles: 3,
      symbols: 0,
      dependencies: 0,
      unresolvedDependencies: 0,
      topLevel: ["src/"],
    };
  }
  async findFiles(..._a: Parameters<R["findFiles"]>): ReturnType<R["findFiles"]> { return []; }
  async listDocumentPaths(..._a: Parameters<R["listDocumentPaths"]>): ReturnType<R["listDocumentPaths"]> { return []; }
  async findSymbols(..._a: Parameters<R["findSymbols"]>): ReturnType<R["findSymbols"]> { return []; }
  async fileDependencies(..._a: Parameters<R["fileDependencies"]>): ReturnType<R["fileDependencies"]> { return { imports: [], importers: [] }; }
  async symbolCalls(..._a: Parameters<R["symbolCalls"]>): ReturnType<R["symbolCalls"]> { return []; }
  async findFindings(..._a: Parameters<R["findFindings"]>): ReturnType<R["findFindings"]> { return []; }
  async readSource(..._a: Parameters<R["readSource"]>): ReturnType<R["readSource"]> { return null; }
}

export class ScriptedProvider implements AIProvider {
  readonly name = "scripted";
  calls: AIRequest[] = [];
  constructor(private readonly reply: (req: AIRequest) => Promise<AIResponse> | AIResponse) {}
  async generate(request: AIRequest) {
    this.calls.push(request);
    return this.reply(request);
  }
}

export function jsonReply(body: unknown, totalTokens = 100): AIResponse {
  return {
    content: JSON.stringify(body),
    provider: "scripted",
    model: "scripted-1",
    usage: { inputTokens: totalTokens - 10, outputTokens: 10, totalTokens },
  };
}

export function makeDeps(
  over: Omit<Partial<AIDeps>, "provider"> & { provider?: AIProvider } = {},
  limits: Partial<AssistantLimits> = {},
): AIDeps & { store: FakeStore } {
  const store = (over.store as FakeStore) ?? new FakeStore();
  const provider = over.provider ?? new ScriptedProvider(() => jsonReply({ answerable: false, sections: [], limitations: [] }));
  return {
    store,
    reader: over.reader ?? new EmptyReader(),
    provider: () => provider,
    limits: { ...DEFAULT_LIMITS, ...limits },
    now: over.now,
  } as AIDeps & { store: FakeStore };
}
