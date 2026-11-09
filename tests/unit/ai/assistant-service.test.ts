// tests/unit/ai/assistant-service.test.ts
import { describe, expect, it } from "vitest";

import { AIProviderError } from "../../../features/ai/providers/ai-provider";
import { AIError } from "../../../lib/ai/ai.errors";
import type { SnapshotScope } from "../../../features/ai/assistant/contracts";
import type { EvidenceReader } from "../../../lib/ai/ai.reader";
import {
  createConversation,
  deleteConversation,
  getConversation,
  getUsage,
  listConversations,
  listMessages,
  normaliseTitle,
  sendMessage,
  updateConversation,
} from "@/lib/ai/ai.service";

import {
  EmptyReader,
  FakeStore,
  jsonReply,
  makeDeps,
  ScriptedProvider,
} from "../../fixtures/ai/fakes";

class LoginReader extends EmptyReader implements EvidenceReader {
  async findSymbols(): ReturnType<EvidenceReader["findSymbols"]> {
    return [
      { id: "s1", stableKey: "k1", name: "login", kind: "FUNCTION", qualifiedName: "login", path: "src/login.ts", parentName: null, isExported: true, isDefaultExport: false, startLine: 1, endLine: 3 },
    ];
  }
  async readSource(): ReturnType<EvidenceReader["readSource"]> { return "export function login() {\n  return 1;\n}"; }
}

const good = () =>
  new ScriptedProvider(() =>
    jsonReply({
      answerable: true,
      limitations: [],
      sections: [{ type: "fact", text: "login is a function.", citations: [{ evidence: "E2", startLine: 1, endLine: 1 }] }],
    }),
  );

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AIError) return e.code;
    throw e;
  }
  return "OK";
}

async function setup(provider = good(), limits = {}) {
  const deps = makeDeps({ reader: new LoginReader(), provider }, limits);
  const conv = await createConversation(deps, "u1", "repo1", {});
  return { deps, conv, provider };
}

describe("conversation lifecycle", () => {
  it("creates against the newest analysed snapshot and lists it", async () => {
    const { deps, conv } = await setup();
    expect(conv.snapshotId).toBe("snap2");
    const list = await listConversations(deps, "u1", "repo1", false);
    expect(list.conversations.length).toBe(1);
    expect(list.snapshots.length).toBe(2);
  });

  it("renames, archives, restores and deletes", async () => {
    const { deps, conv } = await setup();
    const renamed = await updateConversation(deps, "u1", conv.id, { title: "  Auth  flow " });
    expect(renamed.title).toBe("Auth flow");
    await updateConversation(deps, "u1", conv.id, { archived: true });
    expect((await listConversations(deps, "u1", "repo1", false)).conversations.length).toBe(0);
    expect((await listConversations(deps, "u1", "repo1", true)).conversations.length).toBe(1);
    expect(await code(sendMessage(deps, "u1", conv.id, { question: "hi" }))).toBe("INVALID_INPUT");
    const restored = await updateConversation(deps, "u1", conv.id, { archived: false });
    expect(restored.archived).toBe(false);
    await deleteConversation(deps, "u1", conv.id);
    expect(await code(getConversation(deps, "u1", conv.id))).toBe("NOT_FOUND");
  });

  it("validates titles and update bodies", async () => {
    const { deps, conv } = await setup();
    expect(() => normaliseTitle("")).toThrow(AIError);
    expect(() => normaliseTitle("x".repeat(121))).toThrow(AIError);
    expect(await code(updateConversation(deps, "u1", conv.id, {}))).toBe("INVALID_INPUT");
    expect(await code(updateConversation(deps, "u1", conv.id, { archived: "yes" }))).toBe("INVALID_INPUT");
    expect(await code(updateConversation(deps, "u1", conv.id, { userId: "u2" } as never))).toBe("INVALID_INPUT");
    expect(await code(getConversation(deps, "u1", "../etc"))).toBe("INVALID_INPUT");
  });
});

describe("ownership isolation", () => {
  it("treats another user's repository and conversation as missing", async () => {
    const { deps, conv } = await setup();
    expect(await code(listConversations(deps, "u2", "repo1", false))).toBe("NOT_FOUND");
    expect(await code(createConversation(deps, "u2", "repo1", {}))).toBe("NOT_FOUND");
    expect(await code(getConversation(deps, "u2", conv.id))).toBe("NOT_FOUND");
    expect(await code(updateConversation(deps, "u2", conv.id, { title: "x" }))).toBe("NOT_FOUND");
    expect(await code(listMessages(deps, "u2", conv.id))).toBe("NOT_FOUND");
    expect(await code(sendMessage(deps, "u2", conv.id, { question: "hi" }))).toBe("NOT_FOUND");
    expect(await code(deleteConversation(deps, "u2", conv.id))).toBe("NOT_FOUND");
    expect(deps.store.conversations.has(conv.id)).toBe(true);
  });

  it("rejects a snapshot from another repository", async () => {
    const { deps } = await setup();
    expect(await code(createConversation(deps, "u1", "repo1", { snapshotId: "other-snap" }))).toBe("NOT_FOUND");
  });
});

describe("answering", () => {
  it("persists question and validated answer with provenance, and counts usage", async () => {
    const { deps, conv } = await setup();
    const { messages } = await sendMessage(deps, "u1", conv.id, { question: "Where is login defined?" });
    expect(messages.map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(messages[1].snapshotId).toBe("snap2");
    expect(messages[1].commitSha).toBe("bbbbbbb2222222");
    const answer = messages[1].answer as { status: string; references: unknown[] };
    expect(answer.status).toBe("ANSWERED");
    expect(answer.references.length).toBe(1);
    const usage = await getUsage(deps, "u1");
    expect(usage.requestsUsed).toBe(1);
    expect(usage.tokensUsed).toBe(100);
    expect(deps.store.usageRecords[0].status).toBe("SUCCEEDED");
    // auto title
    expect((await getConversation(deps, "u1", conv.id)).conversation.title).toBe("Where is login defined?");
    expect(deps.store.locks.size).toBe(0);
  });

  it("answers 'insufficient evidence' without spending the provider allowance", async () => {
    const provider = good();
    const deps = makeDeps({ reader: new EmptyReader(), provider });
    const conv = await createConversation(deps, "u1", "repo1", {});
    const { messages } = await sendMessage(deps, "u1", conv.id, { question: "zzzz?" });
    expect((messages[1].answer as { status: string }).status).toBe("INSUFFICIENT_EVIDENCE");
    expect(provider.calls.length).toBe(0);
    expect((await getUsage(deps, "u1")).requestsUsed).toBe(0);
  });

  it("rejects oversized and invalid questions before any work", async () => {
    const { deps, conv, provider } = await setup(good(), { maxQuestionChars: 50 });
    expect(await code(sendMessage(deps, "u1", conv.id, { question: "x".repeat(51) }))).toBe("INVALID_INPUT");
    expect(await code(sendMessage(deps, "u1", conv.id, { question: 5 }))).toBe("INVALID_INPUT");
    expect(provider.calls.length).toBe(0);
  });

  it("persists a failed message, keeps history and records usage on provider failure", async () => {
    const provider = new ScriptedProvider(() => {
      throw new AIProviderError("The AI provider took too long to respond.", "TIMEOUT", { retryable: true });
    });
    const { deps, conv } = await setup(provider);
    try {
      await sendMessage(deps, "u1", conv.id, { question: "Where is login?" });
      throw new Error("expected failure");
    } catch (e) {
      const err = e as AIError;
      expect(err.code).toBe("PROVIDER_ERROR");
      expect(err.options.status).toBe(504);
      expect(err.options.retryable).toBe(true);
    }
    const { messages } = await listMessages(deps, "u1", conv.id);
    expect(messages.map((m) => m.status)).toEqual(["COMPLETED", "FAILED"]);
    expect(messages[1].errorCode).toBe("TIMEOUT");
    expect(deps.store.usageRecords[0].status).toBe("FAILED");
    expect((await getUsage(deps, "u1")).requestsUsed).toBe(1);
    expect(deps.store.locks.size).toBe(0);
    // history still usable afterwards
    expect(await code(sendMessage(makeDeps({ store: deps.store, reader: new LoginReader(), provider: good() }), "u1", conv.id, { question: "again login" }))).toBe("OK");
  });

  it("rejects malformed provider output without displaying it", async () => {
    const provider = new ScriptedProvider(() => ({ content: "<script>", provider: "s", model: "m" }));
    const { deps, conv } = await setup(provider);
    expect(await code(sendMessage(deps, "u1", conv.id, { question: "login?" }))).toBe("PROVIDER_ERROR");
    const { messages } = await listMessages(deps, "u1", conv.id);
    expect(messages[1].content.includes("script")).toBe(false);
  });
});

describe("usage limits", () => {
  it("blocks once the daily allowance is used and explains the reset", async () => {
    const { deps, conv } = await setup(good(), { dailyRequestLimit: 1 });
    await sendMessage(deps, "u1", conv.id, { question: "login?" });
    try {
      await sendMessage(deps, "u1", conv.id, { question: "login again?" });
      throw new Error("expected limit");
    } catch (e) {
      const err = e as AIError;
      expect(err.code).toBe("LIMIT_EXCEEDED");
      expect(err.options.status).toBe(429);
      expect(typeof err.options.resetsAt).toBe("string");
    }
    expect((await listMessages(deps, "u1", conv.id)).messages.length).toBe(2);
  });

  it("blocks on the token allowance", async () => {
    const { deps, conv } = await setup(good(), { dailyTokenLimit: 1_000 });
    deps.store.usageDays.set(`u1|${new Date().toISOString().slice(0, 10)}`, { requestCount: 1, tokenCount: 1_000 });
    expect(await code(sendMessage(deps, "u1", conv.id, { question: "login?" }))).toBe("LIMIT_EXCEEDED");
  });

  it("cannot be bypassed by concurrent requests on separate conversations", async () => {
    const deps = makeDeps({ reader: new LoginReader(), provider: good() }, { dailyRequestLimit: 1 });
    const a = await createConversation(deps, "u1", "repo1", {});
    const b = await createConversation(deps, "u1", "repo1", {});
    const results = await Promise.all([
      code(sendMessage(deps, "u1", a.id, { question: "login?" })),
      code(sendMessage(deps, "u1", b.id, { question: "login?" })),
    ]);
    expect(results.filter((r) => r === "OK").length).toBe(1);
    expect(results.filter((r) => r === "LIMIT_EXCEEDED").length).toBe(1);
  });

  it("rejects concurrent messages in one conversation", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const provider = new ScriptedProvider(async () => {
      await gate;
      return jsonReply({ answerable: true, limitations: [], sections: [{ type: "fact", text: "ok", citations: [{ evidence: "E2" }] }] });
    });
    const { deps, conv } = await setup(provider);
    const first = sendMessage(deps, "u1", conv.id, { question: "login?" });
    await new Promise((r) => setTimeout(r, 10));
    expect(await code(sendMessage(deps, "u1", conv.id, { question: "login 2?" }))).toBe("BUSY");
    release();
    await first;
    const { messages } = await listMessages(deps, "u1", conv.id);
    expect(messages.map((m) => m.sequence)).toEqual([1, 2]);
  });
});

describe("explicit snapshot switching", () => {
  it("never switches silently and preserves historical provenance", async () => {
    const { deps, conv } = await setup();
    // start on the OLDER snapshot explicitly
    const pinned = await createConversation(deps, "u1", "repo1", { snapshotId: "snap1" });
    expect(pinned.snapshotId).toBe("snap1");
    await sendMessage(deps, "u1", pinned.id, { question: "login?" });
    // a newer snapshot exists, yet the conversation keeps using snap1
    await sendMessage(deps, "u1", pinned.id, { question: "login again?" });
    let msgs = (await listMessages(deps, "u1", pinned.id)).messages;
    expect(msgs.every((m) => m.snapshotId === "snap1")).toBe(true);

    const switched = await updateConversation(deps, "u1", pinned.id, { snapshotId: "snap2" });
    expect(switched.snapshotId).toBe("snap2");
    expect(switched.analysisId).toBe("an2");
    await sendMessage(deps, "u1", pinned.id, { question: "login on new?" });

    msgs = (await listMessages(deps, "u1", pinned.id)).messages;
    expect(msgs.map((m) => `${m.role}:${m.snapshotId}`)).toEqual([
      "USER:snap1", "ASSISTANT:snap1", "USER:snap1", "ASSISTANT:snap1",
      "SYSTEM:snap2", "USER:snap2", "ASSISTANT:snap2",
    ]);
    expect(msgs[4].content.includes("switched")).toBe(true);
    expect(conv.id).not.toBe(pinned.id);
  });

  it("refuses to answer, and does not substitute, when the snapshot is unavailable", async () => {
    const { deps, conv } = await setup();
    deps.store.scopes.delete("an2");
    expect(await code(sendMessage(deps, "u1", conv.id, { question: "login?" }))).toBe("CONTEXT_UNAVAILABLE");
    expect((await getConversation(deps, "u1", conv.id)).context).toBe(null);
  });

  it("rejects switching to a snapshot without a usable analysis", async () => {
    const { deps, conv } = await setup();
    expect(await code(updateConversation(deps, "u1", conv.id, { snapshotId: "missing" }))).toBe("NOT_FOUND");
  });
});

describe("deletion", () => {
  it("removes messages but keeps usage rows so limits cannot be reset", async () => {
    const { deps, conv } = await setup();
    await sendMessage(deps, "u1", conv.id, { question: "login?" });
    await deleteConversation(deps, "u1", conv.id);
    expect(deps.store.messages.length).toBe(0);
    expect(deps.store.usageRecords.length).toBe(1);
    expect((await getUsage(deps, "u1")).requestsUsed).toBe(1);
  });
});

describe("store type", () => {
  it("fake store satisfies the port", () => {
    const s: FakeStore = new FakeStore();
    expect(typeof s.reserveRequest).toBe("function");
  });
});
