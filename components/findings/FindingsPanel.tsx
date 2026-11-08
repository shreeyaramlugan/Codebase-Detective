// components/findings/FindingsPanel.tsx
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import {
  FINDING_CATEGORIES,
  FINDING_CERTAINTIES,
  SEVERITY_ORDER,
} from "@/features/findings/contracts";
import {
  CATEGORY_LABELS,
  CERTAINTY_EXPLANATIONS,
  CERTAINTY_LABELS,
  EMPTY_FILTERS,
  REVIEW_LABELS,
  SEVERITY_LABELS,
  certaintyTone,
  describeRun,
  findingsQuery,
  hasActiveFilters,
  labelFor,
  severityTone,
  toggle,
  type FindingsFilterState,
} from "@/features/findings/view/findings-view";
import type {
  FindingListItem,
  FindingsRunView,
  RuleRunView,
} from "@/lib/findings/findings.service";

import {
  Badge,
  EmptyState,
  ErrorBox,
  Panel,
  Spinner,
  formatDate,
  inputClass,
} from "@/components/explorer/ui";
import {
  readApiError,
  useApi,
  useDebounced,
} from "@/components/explorer/useApi";

import FindingDetail from "./FindingDetail";
import FindingsComparison from "./FindingsComparison";

type Props = {
  repositoryId: string;
  analysisId: string;
  state: ExplorerState;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

type Tab = "findings" | "compare" | "rules";

interface RuleDoc {
  id: string;
  name: string;
  version: string;
  category: string;
  severityPolicy: string;
  certainties: string[];
  description: string;
  evaluation: string;
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-xs transition ${
        active
          ? "border-orange-500/60 bg-orange-500/10 text-orange-300"
          : "border-stone-700 text-stone-400 hover:text-stone-200"
      }`}
    >
      {children}
    </button>
  );
}

function RuleCatalogue() {
  const { data, error, loading, reload } = useApi<{ rules: RuleDoc[] }>(
    "/api/findings/rules",
  );
  return (
    <Panel title="Rule catalogue">
      {loading && <Spinner />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      <ul className="divide-y divide-stone-800">
        {data?.rules.map((rule) => (
          <li key={rule.id} className="space-y-1 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-stone-100">
                {rule.id} · {rule.name}
              </span>
              <Badge>{labelFor(CATEGORY_LABELS, rule.category)}</Badge>
              {rule.certainties.map((c) => (
                <Badge key={c} tone={certaintyTone(c)}>
                  {labelFor(CERTAINTY_LABELS, c)}
                </Badge>
              ))}
              <span className="text-xs text-stone-500">v{rule.version}</span>
            </div>
            <p className="text-sm text-stone-400">{rule.description}</p>
            <p className="text-xs text-stone-500">
              Severity: {rule.severityPolicy}
            </p>
            <p className="text-xs text-stone-500">
              Detection: {rule.evaluation}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export default function FindingsPanel({
  repositoryId,
  analysisId,
  state,
  onNavigate,
}: Props) {
  const [tab, setTab] = useState<Tab>("findings");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const runs = useApi<{ runs: FindingsRunView[] }>(
    `/api/analyses/${encodeURIComponent(analysisId)}/findings/runs`,
  );

  const runId =
    state.run && runs.data?.runs.some((r) => r.id === state.run)
      ? state.run
      : (runs.data?.runs[0]?.id ?? null);

  const summary = useApi<{ run: FindingsRunView; ruleRuns: RuleRunView[] }>(
    runId ? `/api/findings/runs/${encodeURIComponent(runId)}` : null,
  );

  const [filters, setFilters] = useState<FindingsFilterState>({
    ...EMPTY_FILTERS,
    q: state.q,
  });
  const debouncedQ = useDebounced(filters.q);
  const effective = { ...filters, q: debouncedQ };
  const queryKey = findingsQuery(effective);

  const [items, setItems] = useState<FindingListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [listNonce, setListNonce] = useState(0);

  const fetchPage = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      const response = await fetch(
        `/api/findings/runs/${encodeURIComponent(runId!)}/findings?${findingsQuery(effective, after)}`,
        { signal, credentials: "same-origin" },
      );
      if (!response.ok) throw new Error(await readApiError(response));
      return (await response.json()) as {
        items: FindingListItem[];
        nextCursor: string | null;
        total: number;
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, queryKey],
  );

  useEffect(() => {
    if (!runId || summary.data?.run.status === "FAILED") {
      setItems([]);
      setTotal(0);
      setCursor(null);
      return;
    }
    const controller = new AbortController();
    setListLoading(true);
    setListError(null);
    fetchPage(null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setTotal(page.total);
        setCursor(page.nextCursor);
        setListLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setListError(
          cause instanceof Error ? cause.message : "Failed to load.",
        );
        setListLoading(false);
      });
    return () => controller.abort();
  }, [runId, fetchPage, listNonce, summary.data?.run.status]);

  async function loadMore() {
    if (!cursor) return;
    setListLoading(true);
    try {
      const page = await fetchPage(cursor);
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Failed to load.");
    } finally {
      setListLoading(false);
    }
  }

  async function startRun() {
    setStarting(true);
    setStartError(null);
    try {
      const response = await fetch(
        `/api/analyses/${encodeURIComponent(analysisId)}/findings/run`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      );
      if (!response.ok) throw new Error(await readApiError(response));
      const result = (await response.json()) as { runId: string };
      runs.reload();
      onNavigate({ run: result.runId, finding: null });
    } catch (cause) {
      setStartError(
        cause instanceof Error ? cause.message : "Could not start the run.",
      );
    } finally {
      setStarting(false);
    }
  }

  const stats = summary.data?.run.stats as
    { total?: number; bySeverity?: Record<string, number> } | null | undefined;
  const banner = summary.data
    ? describeRun(summary.data.run, stats?.total ?? 0)
    : null;

  const tabs: Array<[Tab, string]> = [
    ["findings", "Findings"],
    ["compare", "Compare"],
    ["rules", "Rules"],
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex gap-1"
          role="tablist"
          aria-label="Findings sections"
        >
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`rounded-lg px-3 py-1.5 text-sm ${tab === id ? "bg-stone-800 text-stone-100" : "text-stone-400 hover:text-stone-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {runs.data && runs.data.runs.length > 0 && (
            <>
              <label htmlFor="run-select" className="sr-only">
                Findings run
              </label>
              <select
                id="run-select"
                value={runId ?? ""}
                onChange={(e) =>
                  onNavigate({ run: e.target.value, finding: null })
                }
                className={`${inputClass} !w-60`}
              >
                {runs.data.runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.status.toLowerCase()} · {formatDate(run.createdAt)}
                  </option>
                ))}
              </select>
            </>
          )}
          <button
            type="button"
            disabled={starting}
            onClick={() => void startRun()}
            className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-stone-950 hover:bg-orange-400 disabled:opacity-60"
          >
            {starting ? "Running..." : "Run findings analysis"}
          </button>
        </div>
      </div>

      {startError && <ErrorBox message={startError} />}

      {tab === "rules" && <RuleCatalogue />}
      {tab === "compare" && (
        <FindingsComparison repositoryId={repositoryId} currentRunId={runId} />
      )}

      {tab === "findings" && (
        <>
          {runs.loading && <Spinner label="Loading findings runs..." />}
          {runs.error && (
            <ErrorBox message={runs.error} onRetry={runs.reload} />
          )}

          {runs.data && runs.data.runs.length === 0 && (
            <Panel>
              <EmptyState
                title="No findings have been generated for this analysis."
                message="Run the deterministic rules to find dependency, complexity, structure and security-indicator issues."
              />
            </Panel>
          )}

          {banner && summary.data && (
            <div
              role="status"
              className={`rounded-xl border p-4 ${
                banner.tone === "bad"
                  ? "border-red-500/30 bg-red-500/5"
                  : banner.tone === "warn"
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-stone-800 bg-stone-900/70"
              }`}
            >
              <p className="text-sm font-medium text-stone-100">
                {banner.title}
              </p>
              {banner.message && (
                <p className="mt-1 text-sm text-stone-400">{banner.message}</p>
              )}
              {summary.data.run.limitations.length > 1 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-stone-400">
                  {summary.data.run.limitations.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-[11px] text-stone-500">
                Engine {summary.data.run.engineVersion} · catalogue{" "}
                {summary.data.run.catalogueVersion} · commit{" "}
                {summary.data.run.commitSha.slice(0, 7)}
              </p>
            </div>
          )}

          {summary.data && summary.data.run.status !== "FAILED" && (
            <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
              {SEVERITY_ORDER.map((severity) => (
                <button
                  key={severity}
                  type="button"
                  aria-pressed={filters.severities.includes(severity)}
                  onClick={() =>
                    setFilters((f) => ({
                      ...f,
                      severities: toggle(f.severities, severity),
                    }))
                  }
                  className="rounded-2xl border border-stone-800 bg-stone-900/70 p-4 text-left hover:border-stone-700"
                >
                  <p className="text-2xl font-semibold text-stone-100">
                    {stats?.bySeverity?.[severity] ?? 0}
                  </p>
                  <Badge tone={severityTone(severity)}>
                    {SEVERITY_LABELS[severity]}
                  </Badge>
                </button>
              ))}
            </div>
          )}

          {runId && summary.data && summary.data.run.status !== "FAILED" && (
            <Panel
              title={`Findings (${total})`}
              action={
                hasActiveFilters(filters) ? (
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_FILTERS)}
                    className="text-xs text-orange-300 hover:underline"
                  >
                    Clear filters
                  </button>
                ) : undefined
              }
            >
              <div className="space-y-3 border-b border-stone-800 p-4">
                <label htmlFor="findings-q" className="sr-only">
                  Search findings
                </label>
                <input
                  id="findings-q"
                  type="search"
                  value={filters.q}
                  maxLength={100}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, q: e.target.value }))
                  }
                  placeholder="Search title, file path or rule id"
                  className={inputClass}
                />
                <div className="flex flex-wrap gap-2">
                  {FINDING_CATEGORIES.map((c) => (
                    <Chip
                      key={c}
                      active={filters.categories.includes(c)}
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          categories: toggle(f.categories, c),
                        }))
                      }
                    >
                      {CATEGORY_LABELS[c]}
                    </Chip>
                  ))}
                  <span className="mx-1 text-stone-700">|</span>
                  {FINDING_CERTAINTIES.map((c) => (
                    <Chip
                      key={c}
                      active={filters.certainties.includes(c)}
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          certainties: toggle(f.certainties, c),
                        }))
                      }
                    >
                      {CERTAINTY_LABELS[c]}
                    </Chip>
                  ))}
                  <span className="mx-1 text-stone-700">|</span>
                  {Object.entries(REVIEW_LABELS).map(([key, label]) => (
                    <Chip
                      key={key}
                      active={filters.review === key}
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          review: f.review === key ? "" : key,
                        }))
                      }
                    >
                      {label}
                    </Chip>
                  ))}
                </div>
              </div>

              {listError && (
                <ErrorBox
                  message={listError}
                  onRetry={() => setListNonce((n) => n + 1)}
                />
              )}

              {!listError && items.length === 0 && !listLoading && (
                <EmptyState
                  title={
                    hasActiveFilters(filters)
                      ? "No findings match these filters."
                      : "No findings in this run."
                  }
                />
              )}

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <ul className="divide-y divide-stone-800">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={state.finding === item.id}
                        onClick={() =>
                          onNavigate({ finding: item.id, run: runId })
                        }
                        className={`block w-full px-4 py-3 text-left hover:bg-stone-800/60 ${state.finding === item.id ? "bg-stone-800/60" : ""}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={severityTone(item.severity)}>
                            {labelFor(SEVERITY_LABELS, item.severity)}
                          </Badge>
                          <Badge
                            tone={certaintyTone(item.certainty)}
                            title={
                              CERTAINTY_EXPLANATIONS[
                                item.certainty as keyof typeof CERTAINTY_EXPLANATIONS
                              ]
                            }
                          >
                            {labelFor(CERTAINTY_LABELS, item.certainty)}
                          </Badge>
                          <span className="text-xs text-stone-500">
                            {item.ruleId}
                          </span>
                          {item.review && (
                            <Badge tone="accent">
                              {labelFor(REVIEW_LABELS, item.review.status)}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-stone-200">
                          {item.title}
                        </p>
                        <p className="truncate text-xs text-stone-500">
                          {item.subjectPath}
                          {item.primaryLine ? `:${item.primaryLine}` : ""}
                        </p>
                      </button>
                    </li>
                  ))}
                  {listLoading && <Spinner />}
                  {cursor && !listLoading && (
                    <li className="p-3 text-center">
                      <button
                        type="button"
                        onClick={() => void loadMore()}
                        className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800"
                      >
                        Load more
                      </button>
                    </li>
                  )}
                </ul>

                <div className="p-4 lg:pl-0">
                  {state.finding ? (
                    <FindingDetail
                      key={state.finding}
                      findingId={state.finding}
                      onNavigate={onNavigate}
                      onClose={() => onNavigate({ finding: null })}
                      onReviewChanged={() => setListNonce((n) => n + 1)}
                    />
                  ) : (
                    <p className="p-6 text-center text-sm text-stone-500">
                      Select a finding to see its evidence.
                    </p>
                  )}
                </div>
              </div>
            </Panel>
          )}

          {summary.data &&
            summary.data.ruleRuns.some((r) => r.status !== "COMPLETED") && (
              <Panel title="Rules that did not run to completion">
                <ul className="divide-y divide-stone-800">
                  {summary.data.ruleRuns
                    .filter((r) => r.status !== "COMPLETED")
                    .map((r) => (
                      <li
                        key={r.ruleId}
                        className="px-4 py-2 text-sm text-stone-400"
                      >
                        <span className="text-stone-200">{r.ruleId}</span>{" "}
                        <Badge tone="warn">{r.status.toLowerCase()}</Badge>{" "}
                        {r.reason}
                      </li>
                    ))}
                </ul>
              </Panel>
            )}
        </>
      )}
    </div>
  );
}
