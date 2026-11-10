// components/explorer/ExplorerWorkspace.tsx
"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { RepositoryExplorerOverview } from "@/lib/explorer/explorer.service";
import {
  EXPLORER_VIEWS,
  explorerSearchParams,
  parseExplorerState,
  type ExplorerState,
  type ExplorerView,
} from "@/features/explorer/navigation/explorer-url";

import CodeSearch from "./CodeSearch";
import DependencyGraph from "./DependencyGraph";
import FileExplorer from "./FileExplorer";
import AssistantPanel from "@/components/ai/AssistantPanel";
import ResearchPanel from "@/components/research/ResearchPanel";
import FindingsPanel from "@/components/findings/FindingsPanel";
import OverviewPanel from "./OverviewPanel";
import SymbolExplorer from "./SymbolExplorer";
import { Badge, ErrorBox, Spinner, formatDate, inputClass } from "./ui";
import { readApiError } from "./useApi";

type Props = {
  initialOverview: RepositoryExplorerOverview;
  initialState: ExplorerState;
};

const LABELS: Record<ExplorerView, string> = {
  overview: "Overview",
  files: "Files",
  symbols: "Symbols",
  graph: "Dependency graph",
  search: "Search",
  findings: "Findings",
  assistant: "Assistant",
  research: "Research",
};

export default function ExplorerWorkspace({
  initialOverview,
  initialState,
}: Props) {
  const repositoryId = initialOverview.repository.id;
  const [overview, setOverview] = useState(initialOverview);
  const [state, setState] = useState<ExplorerState>(initialState);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const analysisId = overview.selectedAnalysisId;
  const snapshotId = overview.selectedSnapshotId;
  const explorable = overview.state.explorable && !!analysisId && !!snapshotId;

  const writeUrl = useCallback((next: ExplorerState, push: boolean) => {
    const query = explorerSearchParams(next).toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (push) window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
  }, []);

  const navigate = useCallback(
    (patch: Partial<ExplorerState>) => {
      setState((current) => {
        const next = { ...current, ...patch };
        // Switching view keeps only what that view understands.
        if (patch.view && patch.view !== current.view) {
          if (patch.file === undefined && patch.view !== "files")
            next.line = patch.line ?? null;
        }
        writeUrl(next, true);
        return next;
      });
      window.scrollTo?.({ top: 0 });
    },
    [writeUrl],
  );

  // Browser back/forward.
  useEffect(() => {
    const onPop = () =>
      setState(parseExplorerState(new URLSearchParams(window.location.search)));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadOverview = useCallback(
    async (selection: { snapshotId?: string; analysisId?: string }) => {
      setOverviewLoading(true);
      setOverviewError(null);
      const params = new URLSearchParams();
      if (selection.snapshotId) params.set("snapshotId", selection.snapshotId);
      if (selection.analysisId) params.set("analysisId", selection.analysisId);

      try {
        const response = await fetch(
          `/api/repositories/${encodeURIComponent(repositoryId)}/explorer?${params}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) throw new Error(await readApiError(response));
        const next = (await response.json()) as RepositoryExplorerOverview;
        setOverview(next);
        const nextState: ExplorerState = {
          ...state,
          analysis: selection.analysisId ?? null,
          file: null,
          line: null,
          symbol: null,
        };
        setState(nextState);
        writeUrl(nextState, true);
      } catch (cause) {
        setOverviewError(
          cause instanceof Error
            ? cause.message
            : "Could not load that selection.",
        );
      } finally {
        setOverviewLoading(false);
      }
    },
    [repositoryId, state, writeUrl],
  );

  // If the URL named an analysis that differs from the loaded one, load it.
  useEffect(() => {
    if (
      state.analysis &&
      state.analysis !== overview.selectedAnalysisId &&
      !overviewLoading
    ) {
      void loadOverview({ analysisId: state.analysis });
    }
    // Run when the requested analysis changes (e.g. back/forward).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.analysis]);

  const view: ExplorerView =
    !explorable && state.view !== "overview" ? "overview" : state.view;

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <nav aria-label="Breadcrumb" className="text-xs text-stone-500">
          <Link href="/dashboard/repositories" className="hover:text-stone-300">
            Repositories
          </Link>{" "}
          /{" "}
          <span className="text-stone-300">{overview.repository.fullName}</span>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold text-stone-100">
              {overview.repository.fullName}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {snapshotId && (
                <Badge>
                  commit{" "}
                  {overview.snapshots
                    .find((s) => s.id === snapshotId)
                    ?.commitSha.slice(0, 7)}
                </Badge>
              )}
              <Badge
                tone={
                  overview.state.tone === "success"
                    ? "good"
                    : overview.state.tone === "error"
                      ? "bad"
                      : overview.state.kind === "ready_partial"
                        ? "warn"
                        : "info"
                }
              >
                {overview.state.title}
              </Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <div>
              <label
                htmlFor="snapshot-select"
                className="mb-1 block text-[11px] text-stone-500"
              >
                Snapshot
              </label>
              <select
                id="snapshot-select"
                value={snapshotId ?? ""}
                disabled={overview.snapshots.length === 0 || overviewLoading}
                onChange={(event) =>
                  void loadOverview({ snapshotId: event.target.value })
                }
                className={`${inputClass} !w-56`}
              >
                {overview.snapshots.length === 0 && (
                  <option value="">No snapshots</option>
                )}
                {overview.snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.commitSha.slice(0, 7)} · {s.status.toLowerCase()} ·{" "}
                    {formatDate(s.createdAt)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="analysis-select"
                className="mb-1 block text-[11px] text-stone-500"
              >
                Analysis
              </label>
              <select
                id="analysis-select"
                value={analysisId ?? ""}
                disabled={overview.analyses.length === 0 || overviewLoading}
                onChange={(event) =>
                  void loadOverview({ analysisId: event.target.value })
                }
                className={`${inputClass} !w-56`}
              >
                {overview.analyses.length === 0 && (
                  <option value="">No analyses</option>
                )}
                {overview.analyses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.status.toLowerCase()} · {formatDate(a.createdAt)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="Explorer views"
          className="flex flex-wrap gap-1 border-b border-stone-800"
        >
          {EXPLORER_VIEWS.map((id) => {
            const disabled = id !== "overview" && !explorable;
            const active = view === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                disabled={disabled}
                title={
                  disabled
                    ? "Available once an analysis has completed."
                    : undefined
                }
                onClick={() => navigate({ view: id })}
                className={`-mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition ${
                  active
                    ? "border-orange-500 text-orange-300"
                    : "border-transparent text-stone-400 hover:text-stone-200"
                } disabled:cursor-not-allowed disabled:text-stone-700`}
              >
                {LABELS[id]}
              </button>
            );
          })}
        </div>
      </header>

      {overviewError && <ErrorBox message={overviewError} />}
      {overviewLoading && <Spinner label="Loading selection..." />}

      {!overviewLoading && (
        <section role="tabpanel" aria-label={LABELS[view]}>
          {view === "overview" && (
            <OverviewPanel overview={overview} onNavigate={navigate} />
          )}

          {explorable && view === "files" && (
            <FileExplorer
              key={analysisId!}
              repositoryId={repositoryId}
              snapshotId={snapshotId!}
              analysisId={analysisId!}
              state={state}
              onNavigate={navigate}
            />
          )}

          {explorable && view === "symbols" && (
            <SymbolExplorer
              key={analysisId!}
              repositoryId={repositoryId}
              snapshotId={snapshotId!}
              analysisId={analysisId!}
              state={state}
              onNavigate={navigate}
            />
          )}

          {explorable && view === "graph" && (
            <DependencyGraph
              key={analysisId!}
              analysisId={analysisId!}
              onNavigate={navigate}
            />
          )}

          {explorable && view === "findings" && (
            <FindingsPanel
              key={analysisId!}
              repositoryId={repositoryId}
              analysisId={analysisId!}
              state={state}
              onNavigate={navigate}
            />
          )}

          {explorable && view === "assistant" && (
            <AssistantPanel
              repositoryId={repositoryId}
              analysisId={analysisId!}
              state={state}
              onNavigate={navigate}
            />
          )}

          {explorable && view === "research" && (
            <ResearchPanel
              repositoryId={repositoryId}
              analysisId={analysisId!}
              state={state}
              onNavigate={navigate}
            />
          )}

          {explorable && view === "search" && (
            <CodeSearch
              key={analysisId!}
              analysisId={analysisId!}
              query={state.q}
              onQueryChange={(q) => {
                const next = { ...state, q };
                setState(next);
                writeUrl(next, false);
              }}
              onNavigate={navigate}
            />
          )}
        </section>
      )}
    </div>
  );
}
