// components/research/ResearchPanel.tsx
"use client";

import { useCallback, useEffect, useState } from "react";

import { citationHref } from "@/features/ai/assistant/view";
import type { Citation } from "@/features/ai/assistant/contracts";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import { researchSuggestion } from "@/features/research/engine/queries";
import type { RecommendationStatus } from "@/features/research/engine/lifecycle";
import type { SourceCitation } from "@/features/research/engine/synthesis";
import type {
  toRecommendationView,
  toRunView,
  toSourceView,
} from "@/lib/research/research.service";

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

type RunView = ReturnType<typeof toRunView>;
type SourceView = ReturnType<typeof toSourceView>;
type RecView = ReturnType<typeof toRecommendationView>;

interface RunDetail {
  run: RunView;
  sources: SourceView[];
  recommendations: RecView[];
}
interface UsageView {
  runs: { used: number; limit: number };
  syntheses: { used: number; limit: number };
  tokens: { used: number; limit: number };
  providerRequests: { used: number; limit: number };
  resetsAt: string;
}

type Props = {
  repositoryId: string;
  analysisId: string;
  state: ExplorerState;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

const short = (sha: string) => sha.slice(0, 7);

const CONTENT_LABEL: Record<string, string> = {
  FULL_TEXT: "Page text retrieved",
  ABSTRACT: "Abstract only - full text not reviewed",
  METADATA_ONLY: "Metadata only - nothing was read",
};
const CLASS_LABEL: Record<string, string> = {
  OFFICIAL: "Official documentation",
  PEER_REVIEWED: "Peer-reviewed (inferred)",
  PREPRINT: "Preprint - not peer reviewed",
  OTHER_SCHOLARLY: "Other scholarly",
};
const STATUS_LABEL: Record<string, string> = {
  PROPOSED: "Proposed",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  IMPLEMENTED: "Implemented",
  ARCHIVED: "Archived",
};
const RUN_STATUS_LABEL: Record<string, string> = {
  DISCOVERING: "Searching",
  AWAITING_REVIEW: "Review sources",
  SYNTHESIZING: "Writing recommendations",
  COMPLETED: "Completed",
  FAILED: "Failed",
};
// Mirrors the server lifecycle; the server remains the authority.
const NEXT: Record<string, RecommendationStatus[]> = {
  PROPOSED: ["ACCEPTED", "REJECTED", "ARCHIVED"],
  ACCEPTED: ["IMPLEMENTED", "REJECTED", "ARCHIVED", "PROPOSED"],
  REJECTED: ["PROPOSED", "ARCHIVED"],
  IMPLEMENTED: ["ACCEPTED", "ARCHIVED"],
  ARCHIVED: ["PROPOSED"],
};

async function send(url: string, method: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return response.json();
}

export default function ResearchPanel({ repositoryId, analysisId, state, onNavigate }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const list = useApi<{ runs: RunView[] }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/research/runs${showArchived ? "?archived=true" : ""}`,
  );
  const usage = useApi<UsageView>("/api/research/usage");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    async (body: Record<string, unknown>) => {
      setBusy("Starting research...");
      setError(null);
      try {
        const result = (await send(
          `/api/repositories/${encodeURIComponent(repositoryId)}/research/runs`,
          "POST",
          body,
        )) as RunDetail;
        setQuestion("");
        list.reload();
        usage.reload();
        onNavigate({ view: "research", research: result.run.id, finding: null });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Research could not be started.");
      } finally {
        setBusy(null);
      }
    },
    [repositoryId, list, usage, onNavigate],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="space-y-4">
        <Panel title="New research">
          <div className="space-y-3 p-4">
            {state.finding && (
              <div className="rounded-xl border border-stone-800 bg-stone-950/40 p-3 text-sm text-stone-300">
                <p>Research the finding you selected.</p>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => start({ findingId: state.finding })}
                  className="mt-2 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-stone-950 disabled:opacity-50"
                >
                  Search sources for this finding
                </button>
              </div>
            )}
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (question.trim().length >= 8) void start({ question, analysisId });
              }}
              className="space-y-2"
            >
              <label className="block text-xs text-stone-400" htmlFor="research-question">
                Ask a research question
              </label>
              <textarea
                id="research-question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={500}
                rows={3}
                placeholder="e.g. How do teams break circular dependencies between modules?"
                className={inputClass}
              />
              <button
                type="submit"
                disabled={busy !== null || question.trim().length < 8}
                className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800 disabled:opacity-50"
              >
                Search sources
              </button>
            </form>
            <p className="text-xs text-stone-500">
              Searching never changes your code. You choose which sources are used before any recommendation is written.
            </p>
            {busy && <Spinner label={busy} />}
            {error && <ErrorBox message={error} />}
            {usage.data && (
              <p className="text-xs text-stone-500">
                Today: {usage.data.runs.used}/{usage.data.runs.limit} searches, {usage.data.syntheses.used}/
                {usage.data.syntheses.limit} recommendation runs. Resets {formatDate(usage.data.resetsAt)}.
              </p>
            )}
          </div>
        </Panel>

        <Panel
          title="Research history"
          action={
            <button type="button" className="text-xs text-stone-400 hover:text-stone-200" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "Show active" : "Show archived"}
            </button>
          }
        >
          {list.loading && <Spinner />}
          {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
          {list.data && list.data.runs.length === 0 && (
            <EmptyState title={showArchived ? "No archived research" : "No research yet"} message="Research you run appears here and is kept unchanged." />
          )}
          <ul className="divide-y divide-stone-800">
            {list.data?.runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onNavigate({ view: "research", research: run.id, finding: null })}
                  className={`w-full px-4 py-3 text-left hover:bg-stone-800/50 ${state.research === run.id ? "bg-stone-800/60" : ""}`}
                >
                  <span className="block truncate text-sm text-stone-200">{run.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <Badge tone={run.status === "COMPLETED" ? "good" : run.status === "FAILED" ? "bad" : "info"}>
                      {RUN_STATUS_LABEL[run.status] ?? run.status}
                    </Badge>
                    <span>{short(run.commitSha)}</span>
                    <span>{formatDate(run.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <div>
        {state.research ? (
          <RunView
            key={state.research}
            runId={state.research}
            repositoryId={repositoryId}
            onChanged={() => {
              list.reload();
              usage.reload();
            }}
            onGone={() => onNavigate({ research: null })}
          />
        ) : (
          <Panel>
            <EmptyState
              title="Select or start a research run"
              message="Research looks for official documentation and published studies. Sources are shown to you first; recommendations are written only from the sources you keep."
            />
          </Panel>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- run view */

function RunView({
  runId,
  repositoryId,
  onChanged,
  onGone,
}: {
  runId: string;
  repositoryId: string;
  onChanged: () => void;
  onGone: () => void;
}) {
  const { data, error, loading, reload } = useApi<RunDetail>(`/api/research/runs/${encodeURIComponent(runId)}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [detailed, setDetailed] = useState(false);
  const [title, setTitle] = useState<string | null>(null);

  const act = useCallback(
    async (label: string, fn: () => Promise<unknown>, after?: () => void) => {
      setBusy(label);
      setActionError(null);
      try {
        await fn();
        reload();
        onChanged();
        after?.();
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "That did not work.");
      } finally {
        setBusy(null);
      }
    },
    [reload, onChanged],
  );

  // Discovery and synthesis run in the background worker. Poll quietly (no
  // spinner) and reload the view once the run leaves the in-flight state.
  const liveStatus = data?.run.status;
  useEffect(() => {
    if (liveStatus !== "DISCOVERING" && liveStatus !== "SYNTHESIZING") return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/research/runs/${encodeURIComponent(runId)}`, { credentials: "same-origin" });
        if (!response.ok) return;
        const body = (await response.json()) as RunDetail;
        if (!stopped && body.run.status !== liveStatus) {
          reload();
          onChanged();
        }
      } catch {
        // Transient network error: try again on the next tick.
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [liveStatus, runId, reload, onChanged]);

  if (loading) return <Panel><Spinner label="Loading research..." /></Panel>;
  if (error) return <Panel><ErrorBox message={error} onRetry={reload} /></Panel>;
  if (!data) return null;

  const { run, sources, recommendations } = data;
  const inFlight = run.status === "DISCOVERING" || run.status === "SYNTHESIZING";
  const reviewing = run.status === "AWAITING_REVIEW";
  const official = sources.filter((s) => s.kind === "OFFICIAL_DOCUMENTATION");
  const scholarly = sources.filter((s) => s.kind === "SCHOLARLY");
  const included = sources.filter((s) => s.included).length;

  const toggle = (s: SourceView) =>
    act("Saving review...", () =>
      send(`/api/research/runs/${encodeURIComponent(runId)}/sources`, "PATCH", { included: { [s.sourceKey]: !s.included } }),
    );

  return (
    <div className="space-y-4">
      {inFlight && (
        <div role="status" className="rounded-xl border border-stone-800 bg-stone-950/40 p-3 text-sm text-stone-300">
          {run.status === "DISCOVERING"
            ? "Searching official documentation and scholarly sources in the background. This page updates when it finishes."
            : "Writing recommendations in the background. This page updates when it finishes."}
        </div>
      )}
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            {title === null ? run.title : (
              <input
                aria-label="Run title"
                className={inputClass}
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </span>
        }
        action={
          <div className="flex gap-2 text-xs">
            {title === null ? (
              <button type="button" className="text-stone-400 hover:text-stone-200" onClick={() => setTitle(run.title)}>Rename</button>
            ) : (
              <button
                type="button"
                className="text-orange-300"
                onClick={() => act("Renaming...", () => send(`/api/research/runs/${encodeURIComponent(runId)}`, "PATCH", { title }), () => setTitle(null))}
              >
                Save
              </button>
            )}
            <button
              type="button"
              className="text-stone-400 hover:text-stone-200"
              onClick={() => act("Updating...", () => send(`/api/research/runs/${encodeURIComponent(runId)}`, "PATCH", { archived: !run.archived }))}
            >
              {run.archived ? "Restore" : "Archive"}
            </button>
            <button
              type="button"
              className="text-red-400 hover:text-red-300"
              onClick={() => {
                if (window.confirm("Delete this research run permanently?")) {
                  void act("Deleting...", () => send(`/api/research/runs/${encodeURIComponent(runId)}`, "DELETE"), onGone);
                }
              }}
            >
              Delete
            </button>
          </div>
        }
      >
        <div className="space-y-2 p-4 text-sm text-stone-400">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={run.status === "COMPLETED" ? "good" : "info"}>{RUN_STATUS_LABEL[run.status] ?? run.status}</Badge>
            <Badge tone="neutral" title="The repository snapshot this research was tied to">Snapshot {short(run.commitSha)}</Badge>
            {run.ruleId && <Badge tone="neutral">{run.ruleId}</Badge>}
            {run.partial && <Badge tone="warn">Some searches did not complete</Badge>}
            <span className="text-xs text-stone-500">{formatDate(run.createdAt)}</span>
          </div>
          <p>{run.question}</p>
          {run.ruleId && researchSuggestion(run.ruleId) && (
            <p className="text-xs text-stone-500">Topic: {researchSuggestion(run.ruleId)}</p>
          )}
          {run.diagnostics.filter((d) => d.status !== "OK" && d.status !== "EMPTY").map((d, i) => (
            <p key={i} className="text-xs text-amber-300">
              {d.provider}: {d.note ?? d.status}
            </p>
          ))}
          {run.discarded && (run.discarded.lowRelevance > 0 || run.discarded.overLimit > 0) && (
            <p className="text-xs text-stone-500">
              Not shown: {run.discarded.lowRelevance} low-relevance and {run.discarded.overLimit} over the per-run limit.
            </p>
          )}
        </div>
      </Panel>

      {actionError && <ErrorBox message={actionError} />}
      {busy && <Spinner label={busy} />}

      <SourceList title="Official documentation" sources={official} reviewing={reviewing} onToggle={toggle} />
      <SourceList title="Scholarly sources" sources={scholarly} reviewing={reviewing} onToggle={toggle} />

      {reviewing && (
        <Panel>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <p className="text-sm text-stone-400">
              {included} of {sources.length} sources will be used. Excluded sources and sources with only metadata are never sent to the AI provider.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => act("Writing recommendations...", () => send(`/api/research/runs/${encodeURIComponent(runId)}/synthesize`, "POST"))}
              className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-stone-950 disabled:opacity-50"
            >
              Write recommendations from selected sources
            </button>
          </div>
        </Panel>
      )}

      {run.status === "COMPLETED" && run.synthesis && (
        <Panel
          title="Recommendations"
          action={
            <label className="flex items-center gap-2 text-xs text-stone-400">
              <input type="checkbox" checked={detailed} onChange={(e) => setDetailed(e.target.checked)} /> Detailed
            </label>
          }
        >
          <div className="space-y-4 p-4">
            {run.synthesis.summary && <p className="text-sm text-stone-300">{run.synthesis.summary}</p>}
            {run.synthesis.status === "INSUFFICIENT_EVIDENCE" && (
              <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-200">
                The reviewed sources do not support a recommendation. Try a different question or keep more sources.
              </p>
            )}
            {recommendations.map((rec) => (
              <RecommendationCard
                key={rec.id}
                rec={rec}
                detailed={detailed}
                repositoryId={repositoryId}
                disabled={busy !== null}
                onChange={(patch) => act("Saving...", () => send(`/api/research/recommendations/${encodeURIComponent(rec.id)}`, "PATCH", patch))}
              />
            ))}
            {run.synthesis.conflicts.length > 0 && (
              <div>
                <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Where sources differ</h5>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-300">
                  {run.synthesis.conflicts.map((c, i) => <li key={i}>{c.text}</li>)}
                </ul>
              </div>
            )}
            {run.synthesis.limitations.length > 0 && (
              <div>
                <h5 className="text-xs font-semibold uppercase tracking-wide text-stone-500">Limitations</h5>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-stone-400">
                  {run.synthesis.limitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </div>
            )}
            <p className="text-xs text-stone-500">
              Recommendations are suggestions for you to evaluate. Nothing was changed in your code, and &quot;Implemented&quot; is only ever set by you.
              {run.model ? ` Written with ${run.model}.` : ""} {run.synthesis.removedRecommendations > 0 ? `${run.synthesis.removedRecommendations} unsupported suggestion(s) were removed.` : ""}
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ sources */

function SourceList({
  title,
  sources,
  reviewing,
  onToggle,
}: {
  title: string;
  sources: SourceView[];
  reviewing: boolean;
  onToggle: (s: SourceView) => void;
}) {
  return (
    <Panel title={`${title} (${sources.length})`}>
      {sources.length === 0 ? (
        <p className="p-4 text-sm text-stone-500">No sources were found.</p>
      ) : (
        <ul className="divide-y divide-stone-800">
          {sources.map((s) => (
            <li key={s.sourceKey} className="space-y-2 p-4">
              <div className="flex items-start gap-3">
                {reviewing && (
                  <input
                    type="checkbox"
                    aria-label={`Use ${s.title}`}
                    checked={s.included}
                    onChange={() => onToggle(s)}
                    className="mt-1"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <a href={s.canonicalUrl} target="_blank" rel="noopener noreferrer" className="break-words text-sm font-medium text-orange-300 hover:underline">
                    {s.title}
                  </a>
                  <p className="text-xs text-stone-500">
                    {s.publisher}
                    {s.container ? ` - ${s.container}` : ""}
                    {s.authors.length ? ` - ${s.authors.slice(0, 3).join(", ")}${s.authors.length > 3 ? " et al." : ""}` : ""}
                    {s.publishedAt ? ` - ${s.publishedAt}` : ""}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <Badge tone={s.sourceClass === "OFFICIAL" ? "good" : s.sourceClass === "PREPRINT" ? "warn" : "info"} title={s.classificationBasis}>
                      {CLASS_LABEL[s.sourceClass] ?? s.sourceClass}
                    </Badge>
                    <Badge tone={s.contentLevel === "FULL_TEXT" ? "good" : "warn"}>{CONTENT_LABEL[s.contentLevel] ?? s.contentLevel}</Badge>
                    {s.availability === "UNAVAILABLE" && <Badge tone="bad">Page unavailable</Badge>}
                    {s.evaluation.freshness === "DATED" && <Badge tone="warn">Dated</Badge>}
                    {s.reused && <Badge tone="neutral" title="Metadata reused from an earlier search; retrieved at the time shown">Reused</Badge>}
                    {s.openAccess === true && <Badge tone="neutral">Open access</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    {s.classificationBasis} Retrieved {formatDate(s.retrievedAt)}.
                    {s.doi ? ` DOI ${s.doi}.` : ""}
                  </p>
                  {s.evaluation.notes.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-amber-300">
                      {s.evaluation.notes.map((n, i) => <li key={i}>{n}</li>)}
                    </ul>
                  )}
                  {s.passages.length > 0 && (
                    <details className="mt-2 text-xs text-stone-400">
                      <summary className="cursor-pointer">Retrieved passages ({s.passages.length})</summary>
                      <ol className="mt-1 space-y-1">
                        {s.passages.map((p) => (
                          <li key={p.ordinal} className="rounded-lg bg-stone-950/50 p-2">
                            <span className="text-stone-500">{p.locator}: </span>
                            {p.text}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------- recommendations */

function RecommendationCard({
  rec,
  detailed,
  repositoryId,
  disabled,
  onChange,
}: {
  rec: RecView;
  detailed: boolean;
  repositoryId: string;
  disabled: boolean;
  onChange: (patch: { status?: RecommendationStatus; note?: string }) => void;
}) {
  const [note, setNote] = useState(rec.note ?? "");
  const repoCitations = rec.repositoryCitations as Citation[];
  const sourceCitations = rec.sourceCitations as SourceCitation[];

  return (
    <article className="rounded-xl border border-stone-800 bg-stone-950/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-stone-100">{rec.title}</h4>
        <Badge tone={rec.status === "ACCEPTED" || rec.status === "IMPLEMENTED" ? "good" : rec.status === "REJECTED" ? "bad" : "neutral"}>
          {STATUS_LABEL[rec.status] ?? rec.status}
        </Badge>
        <Badge tone={rec.basis === "REPOSITORY_AND_RESEARCH" ? "info" : "warn"}>
          {rec.basis === "REPOSITORY_AND_RESEARCH" ? "Tied to your repository" : "General guidance - not tied to your repository"}
        </Badge>
      </div>
      <p className="mt-2 text-sm text-stone-300">{rec.concise}</p>
      {detailed && <p className="mt-2 text-sm text-stone-400">{rec.detail}</p>}

      {repoCitations.length > 0 && (
        <p className="mt-2 text-xs text-stone-500">
          Repository evidence:{" "}
          {repoCitations.map((c, i) => {
            const href = citationHref(repositoryId, c);
            return (
              <span key={`${c.evidenceId}-${i}`}>
                {i > 0 && ", "}
                {href ? <a href={href} className="text-orange-300 hover:underline">{c.label}</a> : c.label}
              </span>
            );
          })}{" "}
          (commit {short(repoCitations[0].commitSha)})
        </p>
      )}

      <ul className="mt-2 space-y-1 text-xs text-stone-400">
        {sourceCitations.map((c, i) => (
          <li key={`${c.sourceKey}-${i}`}>
            <a href={c.canonicalUrl} target="_blank" rel="noopener noreferrer" className="text-orange-300 hover:underline">{c.title}</a>{" "}
            - {CLASS_LABEL[c.sourceClass] ?? c.sourceClass}; {c.reviewed}.
            {c.doi ? ` DOI ${c.doi}.` : ""}
            {c.quote && <blockquote className="mt-1 border-l-2 border-stone-700 pl-2 italic">&ldquo;{c.quote}&rdquo;</blockquote>}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(NEXT[rec.status] ?? []).map((next) => (
          <button
            key={next}
            type="button"
            disabled={disabled}
            onClick={() => onChange({ status: next })}
            className="rounded-lg border border-stone-700 px-2.5 py-1 text-xs text-stone-300 hover:bg-stone-800 disabled:opacity-50"
          >
            {next === "PROPOSED" ? "Reopen" : next === "IMPLEMENTED" ? "Mark implemented" : STATUS_LABEL[next]}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          aria-label="Note"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note"
          className={inputClass}
        />
        <button
          type="button"
          disabled={disabled || note === (rec.note ?? "")}
          onClick={() => onChange({ note })}
          className="rounded-lg border border-stone-700 px-2.5 py-1 text-xs text-stone-300 hover:bg-stone-800 disabled:opacity-50"
        >
          Save note
        </button>
      </div>
    </article>
  );
}
