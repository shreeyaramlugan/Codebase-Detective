// components/ai/AssistantPanel.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AssistantAnswer,
  Citation,
  SourceReference,
} from "@/features/ai/assistant/contracts";
import {
  CERTAINTY_LABELS,
  SECTION_LABELS,
  citationHref,
} from "@/features/ai/assistant/view";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import type {
  ConversationView,
  MessageView,
} from "@/lib/ai/ai.service";

import {
  Badge,
  EmptyState,
  ErrorBox,
  Panel,
  Spinner,
  formatDate,
  inputClass,
} from "@/components/explorer/ui";
import { readApiError, useApi } from "@/components/explorer/useApi";

type Props = {
  repositoryId: string;
  analysisId: string;
  state: ExplorerState;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

interface SnapshotOptionView {
  snapshotId: string;
  analysisId: string;
  commitSha: string;
  completeness: string | null;
  analysisStatus: string;
  createdAt: string;
}
interface ListResponse {
  conversations: ConversationView[];
  snapshots: SnapshotOptionView[];
}
interface ConversationResponse {
  conversation: ConversationView;
  context: {
    snapshotId: string;
    analysisId: string;
    commitSha: string;
    completeness: string | null;
    analysisStatus: string;
  } | null;
}
interface MessagesResponse {
  messages: MessageView[];
  nextAfter: number | null;
}
interface UsageResponse {
  requestsUsed: number;
  requestLimit: number;
  tokensUsed: number;
  tokenLimit: number;
  resetsAt: string;
  limits: { maxQuestionChars: number };
}

const short = (sha: string) => sha.slice(0, 7);

function certaintyTone(c: string): "good" | "warn" | "bad" | "neutral" {
  if (c === "CONFIRMED") return "good";
  if (c === "POSSIBLE" || c === "AMBIGUOUS" || c === "INDICATOR") return "warn";
  if (c === "UNRESOLVED") return "bad";
  return "neutral";
}

async function call<T>(
  url: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as T;
}

export default function AssistantPanel({
  repositoryId,
  analysisId,
  state,
  onNavigate,
}: Props) {
  const [archived, setArchived] = useState(false);
  const base = `/api/repositories/${encodeURIComponent(repositoryId)}/ai/conversations`;
  const list = useApi<ListResponse>(`${base}?archived=${archived}`);
  const usage = useApi<UsageResponse>("/api/ai/usage");
  const [actionError, setActionError] = useState<string | null>(null);
  const [newSnapshot, setNewSnapshot] = useState("");

  const act = useCallback(
    async (run: () => Promise<void>) => {
      setActionError(null);
      try {
        await run();
        list.reload();
      } catch (cause) {
        setActionError(
          cause instanceof Error ? cause.message : "That action failed.",
        );
      }
    },
    [list],
  );

  const selected = state.conversation;

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Panel
        title={archived ? "Archived conversations" : "Conversations"}
        action={
          <button
            type="button"
            onClick={() => setArchived((v) => !v)}
            className="text-xs text-stone-400 hover:text-stone-200"
          >
            {archived ? "Show active" : "Show archive"}
          </button>
        }
      >
        {!archived && (
          <div className="space-y-2 border-b border-stone-800 p-3">
            <label className="block text-[11px] text-stone-500" htmlFor="ai-new-snapshot">
              Snapshot for the new conversation
            </label>
            <select
              id="ai-new-snapshot"
              className={inputClass}
              value={newSnapshot}
              onChange={(e) => setNewSnapshot(e.target.value)}
            >
              <option value="">Newest analysed snapshot</option>
              {list.data?.snapshots.map((s) => (
                <option key={s.snapshotId} value={s.snapshotId}>
                  {short(s.commitSha)} · {s.completeness ?? s.analysisStatus} ·{" "}
                  {formatDate(s.createdAt)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() =>
                act(async () => {
                  const created = await call<ConversationView>(base, "POST", {
                    ...(newSnapshot ? { snapshotId: newSnapshot } : {}),
                  });
                  onNavigate({ conversation: created.id });
                })
              }
              className="w-full rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-stone-950 hover:bg-orange-400"
            >
              New conversation
            </button>
          </div>
        )}
        {list.loading && <Spinner />}
        {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
        {list.data && list.data.conversations.length === 0 && (
          <EmptyState
            title={archived ? "Nothing archived" : "No conversations yet"}
            message={
              archived
                ? undefined
                : "Start one to ask about this repository."
            }
          />
        )}
        <ul className="max-h-[28rem] divide-y divide-stone-800 overflow-y-auto">
          {list.data?.conversations.map((c) => (
            <li key={c.id} className="p-3">
              <button
                type="button"
                onClick={() => onNavigate({ conversation: c.id })}
                className={`block w-full truncate text-left text-sm ${
                  selected === c.id ? "text-orange-300" : "text-stone-200"
                }`}
              >
                {c.title}
              </button>
              <p className="mt-0.5 text-[11px] text-stone-500">
                {formatDate(c.updatedAt)}
              </p>
              <div className="mt-2 flex gap-3 text-[11px] text-stone-400">
                <button
                  type="button"
                  className="hover:text-stone-200"
                  onClick={() => {
                    const title = window.prompt("Rename conversation", c.title);
                    if (title && title.trim())
                      void act(async () => {
                        await call(`/api/ai/conversations/${c.id}`, "PATCH", { title });
                      });
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="hover:text-stone-200"
                  onClick={() =>
                    act(async () => {
                      await call(`/api/ai/conversations/${c.id}`, "PATCH", {
                        archived: !c.archived,
                      });
                      if (selected === c.id) onNavigate({ conversation: null });
                    })
                  }
                >
                  {c.archived ? "Restore" : "Archive"}
                </button>
                <button
                  type="button"
                  className="hover:text-red-300"
                  onClick={() => {
                    if (
                      window.confirm(
                        "Permanently delete this conversation and its messages?",
                      )
                    )
                      void act(async () => {
                        await call(`/api/ai/conversations/${c.id}`, "DELETE");
                        if (selected === c.id) onNavigate({ conversation: null });
                      });
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        {actionError && <ErrorBox message={actionError} />}
      </Panel>

      {selected ? (
        <Conversation
          key={selected}
          conversationId={selected}
          repositoryId={repositoryId}
          currentAnalysisId={analysisId}
          snapshots={list.data?.snapshots ?? []}
          usage={usage.data}
          onUsage={usage.reload}
          onChanged={list.reload}
          onNavigate={onNavigate}
        />
      ) : (
        <Panel>
          <EmptyState
            title="Select or start a conversation"
            message="Answers use only evidence from the snapshot shown for the conversation, and every citation is checked against that snapshot."
          />
        </Panel>
      )}
    </div>
  );
}

function Conversation({
  conversationId,
  repositoryId,
  currentAnalysisId,
  snapshots,
  usage,
  onUsage,
  onChanged,
  onNavigate,
}: {
  conversationId: string;
  repositoryId: string;
  currentAnalysisId: string;
  snapshots: SnapshotOptionView[];
  usage: UsageResponse | null;
  onUsage: () => void;
  onChanged: () => void;
  onNavigate: (patch: Partial<ExplorerState>) => void;
}) {
  const url = `/api/ai/conversations/${encodeURIComponent(conversationId)}`;
  const detail = useApi<ConversationResponse>(url);
  const messages = useApi<MessagesResponse>(`${url}/messages?limit=200`);
  const [local, setLocal] = useState<MessageView[]>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [switchTo, setSwitchTo] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);

  const all = useMemo(() => {
    const seen = new Set<string>();
    return [...(messages.data?.messages ?? []), ...local].filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  }, [messages.data, local]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [all.length]);

  const max = usage?.limits.maxQuestionChars ?? 2000;
  const exhausted =
    !!usage &&
    (usage.requestsUsed >= usage.requestLimit ||
      usage.tokensUsed >= usage.tokenLimit);
  const archived = detail.data?.conversation.archived ?? false;
  const context = detail.data?.context ?? null;

  const submit = async (text: string) => {
    if (sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`${url}/messages`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        messages?: MessageView[];
        error?: string;
        resetsAt?: string;
      };
      if (body.messages) setLocal((cur) => [...cur, ...body.messages!]);
      if (!response.ok) {
        // The question stays in the box so it can be retried.
        setError(body.error ?? `Request failed (${response.status}).`);
      } else {
        setQuestion("");
      }
      onUsage();
      onChanged();
    } catch {
      setError("The request could not be completed. Your question was kept.");
    } finally {
      setSending(false);
    }
  };

  const switchSnapshot = async () => {
    if (!switchTo) return;
    setError(null);
    try {
      await call(url, "PATCH", { snapshotId: switchTo });
      setSwitchTo("");
      detail.reload();
      messages.reload();
      setLocal([]);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Switch failed.");
    }
  };

  return (
    <Panel
      title={detail.data?.conversation.title ?? "Conversation"}
      action={
        usage && (
          <span className="text-[11px] text-stone-500">
            {usage.requestsUsed}/{usage.requestLimit} requests today · resets{" "}
            {formatDate(usage.resetsAt)}
          </span>
        )
      }
    >
      <div className="space-y-2 border-b border-stone-800 p-3 text-xs text-stone-400">
        {detail.loading && <span>Loading context...</span>}
        {detail.error && <span className="text-red-300">{detail.error}</span>}
        {detail.data && context && (
          <p>
            Answering from snapshot <strong className="text-stone-200">{short(context.commitSha)}</strong>{" "}
            {context.completeness && context.completeness !== "COMPLETE" && (
              <Badge tone="warn">{context.completeness.toLowerCase()} snapshot</Badge>
            )}
          </p>
        )}
        {detail.data && !context && (
          <p className="text-amber-300">
            The snapshot for this conversation is no longer available. Switch to
            another snapshot to continue; earlier answers keep their original sources.
          </p>
        )}
        {detail.data && !archived && (
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="ai-switch" className="sr-only">Switch snapshot</label>
            <select
              id="ai-switch"
              className={`${inputClass} !w-64`}
              value={switchTo}
              onChange={(e) => setSwitchTo(e.target.value)}
            >
              <option value="">Switch snapshot...</option>
              {snapshots
                .filter((s) => s.snapshotId !== context?.snapshotId)
                .map((s) => (
                  <option key={s.snapshotId} value={s.snapshotId}>
                    {short(s.commitSha)} · {s.completeness ?? s.analysisStatus}
                  </option>
                ))}
            </select>
            <button
              type="button"
              disabled={!switchTo}
              onClick={switchSnapshot}
              className="rounded-lg border border-stone-700 px-3 py-2 text-xs text-stone-200 hover:bg-stone-800 disabled:opacity-40"
            >
              Switch
            </button>
          </div>
        )}
      </div>

      <div className="max-h-[32rem] space-y-4 overflow-y-auto p-4" aria-live="polite">
        {messages.loading && <Spinner />}
        {messages.error && <ErrorBox message={messages.error} onRetry={messages.reload} />}
        {!messages.loading && all.length === 0 && (
          <EmptyState
            title="Ask about this repository"
            message="For example: What depends on this module? Why was this finding generated?"
          />
        )}
        {all.map((m, index) => (
          <MessageItem
            key={m.id}
            message={m}
            repositoryId={repositoryId}
            currentAnalysisId={currentAnalysisId}
            onNavigate={onNavigate}
            onRetry={
              m.status === "FAILED" && !sending
                ? () => {
                    const q = [...all.slice(0, index)].reverse().find((x) => x.role === "USER");
                    if (q) void submit(q.content);
                  }
                : undefined
            }
          />
        ))}
        {sending && <Spinner label="Investigating the evidence..." />}
        <div ref={endRef} />
      </div>

      {error && <ErrorBox message={error} />}

      <form
        className="space-y-2 border-t border-stone-800 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <label htmlFor="ai-question" className="sr-only">Your question</label>
        <textarea
          id="ai-question"
          rows={3}
          maxLength={max}
          value={question}
          disabled={sending || archived || !context}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={
            archived
              ? "Restore this conversation to ask a new question."
              : "Ask about files, symbols, dependencies, call relationships or findings..."
          }
          className={inputClass}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-stone-500">
            {question.length}/{max}
            {exhausted && (
              <span className="ml-2 text-amber-300">
                Daily allowance used; resets {usage ? formatDate(usage.resetsAt) : "tomorrow"}.
              </span>
            )}
          </span>
          <button
            type="submit"
            disabled={sending || !question.trim() || archived || !context || exhausted}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-orange-400 disabled:opacity-40"
          >
            {sending ? "Working..." : "Ask"}
          </button>
        </div>
      </form>
    </Panel>
  );
}

function MessageItem({
  message,
  repositoryId,
  currentAnalysisId,
  onNavigate,
  onRetry,
}: {
  message: MessageView;
  repositoryId: string;
  currentAnalysisId: string;
  onNavigate: (patch: Partial<ExplorerState>) => void;
  onRetry?: () => void;
}) {
  if (message.role === "SYSTEM") {
    return (
      <p className="rounded-lg border border-stone-800 bg-stone-950 px-3 py-2 text-center text-xs text-stone-400">
        {message.content}
      </p>
    );
  }
  if (message.role === "USER") {
    return (
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-stone-800 px-4 py-2 text-sm text-stone-100">
        {message.content}
        <p className="mt-1 text-[10px] text-stone-500">
          snapshot {short(message.commitSha)}
        </p>
      </div>
    );
  }
  if (message.status === "FAILED") {
    return (
      <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-200">
        {message.content}
        {onRetry && (
          <button type="button" onClick={onRetry} className="ml-3 text-xs underline">
            Retry
          </button>
        )}
      </div>
    );
  }
  const answer = message.answer as AssistantAnswer | null;
  if (!answer) return <p className="text-sm text-stone-300">{message.content}</p>;

  const open = (c: Citation) => {
    if (c.path && c.analysisId === currentAnalysisId) {
      onNavigate({ view: "files", file: c.path, line: c.startLine });
    }
  };

  return (
    <div className="max-w-[92%] space-y-3 rounded-2xl border border-stone-800 bg-stone-950 p-4">
      {answer.status === "INSUFFICIENT_EVIDENCE" && (
        <Badge tone="warn">Insufficient evidence</Badge>
      )}
      {answer.sections.map((s, i) => (
        <div key={i} className="text-sm text-stone-200">
          <p>
            {s.text}{" "}
            {s.citations.map((c) => (
              <CitationChip key={`${c.evidenceId}${c.startLine}`} c={c} repositoryId={repositoryId} sameAnalysis={c.analysisId === currentAnalysisId} onOpen={open} />
            ))}
          </p>
          {s.type !== "uncertainty" && (
            <p className="mt-0.5 text-[11px] text-stone-500">
              {s.type === "inference" ? "Inference · " : ""}
              {SECTION_LABELS[s.certainty]}
            </p>
          )}
        </div>
      ))}
      {answer.limitations.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-amber-300/90">
          {answer.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {(answer.removedClaims > 0 || answer.rejectedCitations > 0) && (
        <p className="text-[11px] text-stone-500">
          {answer.removedClaims} unsupported claim(s) removed and{" "}
          {answer.rejectedCitations} invalid citation(s) rejected by validation.
        </p>
      )}
      {answer.references.length > 0 && (
        <ReferencesPanel references={answer.references} repositoryId={repositoryId} currentAnalysisId={currentAnalysisId} onOpen={open} />
      )}
      <p className="text-[10px] text-stone-600">
        Answered from snapshot {short(message.commitSha)}
        {message.model ? ` · ${message.model}` : ""}. Static analysis only; runtime behaviour is not verified.
      </p>
    </div>
  );
}

function CitationChip({
  c,
  repositoryId,
  sameAnalysis,
  onOpen,
}: {
  c: Citation;
  repositoryId: string;
  sameAnalysis: boolean;
  onOpen: (c: Citation) => void;
}) {
  const cls =
    "mx-0.5 inline-flex items-center rounded border border-stone-700 px-1.5 py-0.5 font-mono text-[10px] text-orange-300 hover:bg-stone-800";
  const href = citationHref(repositoryId, c);
  if (!c.path || !href) return <span className={cls}>{c.label}</span>;
  // Same snapshot: navigate in place. Another snapshot: a link that loads that
  // snapshot's analysis, so the source shown always matches the citation.
  return sameAnalysis ? (
    <button type="button" className={cls} onClick={() => onOpen(c)} title={`${CERTAINTY_LABELS[c.certainty]} evidence`}>
      {c.label}
    </button>
  ) : (
    <a className={cls} href={href} title="Opens the snapshot this answer was based on">
      {c.label}
    </a>
  );
}

function ReferencesPanel({
  references,
  repositoryId,
  currentAnalysisId,
  onOpen,
}: {
  references: SourceReference[];
  repositoryId: string;
  currentAnalysisId: string;
  onOpen: (c: Citation) => void;
}) {
  return (
    <details className="rounded-lg border border-stone-800 p-2 text-xs">
      <summary className="cursor-pointer text-stone-300">
        Source references ({references.length})
      </summary>
      <ul className="mt-2 space-y-1.5">
        {references.map((r) => (
          <li key={`${r.evidenceId}${r.startLine}`} className="flex flex-wrap items-center gap-2">
            <CitationChip c={r} repositoryId={repositoryId} sameAnalysis={r.analysisId === currentAnalysisId} onOpen={onOpen} />
            <Badge tone="neutral">{r.kind}</Badge>
            <Badge tone={certaintyTone(r.certainty)}>{CERTAINTY_LABELS[r.certainty]}</Badge>
            <span className="text-stone-500">cited in {r.sections.map((n) => n + 1).join(", ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
