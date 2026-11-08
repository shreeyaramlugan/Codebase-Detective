// components/explorer/OverviewPanel.tsx
"use client";

import FeedbackState from "@/components/dashboard/FeedbackState";
import type { RepositoryExplorerOverview } from "@/lib/explorer/explorer.service";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";

import { Badge, Panel, formatBytes, formatDate, resolutionTone } from "./ui";

type Props = {
  overview: RepositoryExplorerOverview;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-950/50 p-4">
      <p className="text-xs text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-stone-100">{value}</p>
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

function Breakdown({
  title,
  counts,
  toneFor,
}: {
  title: string;
  counts: Record<string, number>;
  toneFor?: (
    key: string,
  ) => "neutral" | "good" | "warn" | "bad" | "info" | "accent";
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-stone-400">{title}</p>
      {entries.length === 0 ? (
        <p className="text-xs text-stone-600">None recorded.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {entries.map(([key, count]) => (
            <li key={key}>
              <Badge tone={toneFor ? toneFor(key) : "neutral"}>
                {key.replace(/_/g, " ").toLowerCase()} · {count}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function OverviewPanel({ overview, onNavigate }: Props) {
  const { repository, state, stats } = overview;
  const snapshot = overview.snapshots.find(
    (s) => s.id === overview.selectedSnapshotId,
  );
  const analysis = overview.analyses.find(
    (a) => a.id === overview.selectedAnalysisId,
  );

  return (
    <div className="space-y-6">
      <FeedbackState
        type={state.tone}
        title={state.title}
        message={state.message}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title="Repository">
          <dl className="space-y-3 p-4 text-sm">
            <div>
              <dt className="text-xs text-stone-500">Name</dt>
              <dd>
                <a
                  href={repository.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-stone-100 hover:text-orange-400"
                >
                  {repository.fullName}
                </a>
              </dd>
            </div>
            {repository.description && (
              <div>
                <dt className="text-xs text-stone-500">Description</dt>
                <dd className="text-stone-300">{repository.description}</dd>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Badge>{repository.visibility.toLowerCase()}</Badge>
              {repository.defaultBranch && (
                <Badge>branch {repository.defaultBranch}</Badge>
              )}
              {repository.language && <Badge>{repository.language}</Badge>}
            </div>
          </dl>
        </Panel>

        <Panel title="Snapshot">
          {snapshot ? (
            <dl className="space-y-3 p-4 text-sm">
              <div>
                <dt className="text-xs text-stone-500">Commit</dt>
                <dd className="font-mono text-stone-200">
                  {snapshot.commitSha.slice(0, 12)}
                </dd>
                {snapshot.commitMessage && (
                  <dd className="mt-1 truncate text-xs text-stone-500">
                    {snapshot.commitMessage.split("\n")[0]}
                  </dd>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge
                  tone={snapshot.completeness === "COMPLETE" ? "good" : "warn"}
                >
                  {snapshot.completeness?.toLowerCase() ??
                    snapshot.status.toLowerCase()}
                </Badge>
                {snapshot.branchName && <Badge>{snapshot.branchName}</Badge>}
              </div>
              <p className="text-xs text-stone-400">
                {snapshot.storedFiles} stored · {snapshot.skippedFiles} skipped
                · {snapshot.failedFiles} failed · {snapshot.totalFiles}{" "}
                discovered · {formatBytes(snapshot.totalBytes)}
              </p>
              <p className="text-xs text-stone-600">
                {snapshot.commitAuthor ? `${snapshot.commitAuthor} · ` : ""}
                {formatDate(snapshot.committedAt ?? snapshot.createdAt)}
              </p>
            </dl>
          ) : (
            <p className="p-4 text-sm text-stone-500">No snapshot selected.</p>
          )}
        </Panel>

        <Panel title="Analysis">
          {analysis ? (
            <dl className="space-y-3 p-4 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge
                  tone={
                    analysis.status === "COMPLETED"
                      ? "good"
                      : analysis.status === "PARTIAL"
                        ? "warn"
                        : analysis.status === "FAILED"
                          ? "bad"
                          : "info"
                  }
                >
                  {analysis.status.toLowerCase()}
                </Badge>
                <Badge tone={analysis.isComplete ? "good" : "warn"}>
                  {analysis.isComplete ? "complete" : "not fully complete"}
                </Badge>
              </div>
              <p className="text-xs text-stone-400">
                Commit {analysis.commitSha.slice(0, 7)} · engine{" "}
                {analysis.engineVersion} · parser {analysis.parserVersion}
              </p>
              <p className="text-xs text-stone-500">
                Finished {formatDate(analysis.completedAt)}
              </p>
              <p className="break-all font-mono text-[11px] text-stone-600">
                {analysis.id}
              </p>
            </dl>
          ) : (
            <p className="p-4 text-sm text-stone-500">
              No analysis exists for this snapshot yet.
            </p>
          )}
        </Panel>
      </div>

      {stats && state.explorable && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Stat
              label="Files analysed"
              value={stats.files.byStatus.ANALYSED ?? 0}
              hint={`${stats.files.total} records`}
            />
            <Stat
              label="Symbols"
              value={stats.symbols.total}
              hint={`${stats.symbols.exported} exported`}
            />
            <Stat
              label="Module dependencies"
              value={stats.dependencies.total}
            />
            <Stat label="Calls" value={stats.calls.total} />
            <Stat
              label="Graph"
              value={stats.graph ? stats.graph.nodeCount : "-"}
              hint={
                stats.graph
                  ? `${stats.graph.edgeCount} edges`
                  : "No graph stored"
              }
            />
            <Stat label="Diagnostics" value={stats.diagnostics.total} />
          </div>

          <Panel title="Breakdown">
            <div className="grid gap-6 p-4 md:grid-cols-2">
              <Breakdown
                title="File analysis status"
                counts={stats.files.byStatus}
                toneFor={(k) =>
                  k === "ANALYSED"
                    ? "good"
                    : k === "FAILED"
                      ? "bad"
                      : k === "ANALYSED_WITH_ERRORS"
                        ? "warn"
                        : "neutral"
                }
              />
              <Breakdown
                title="Symbols by kind"
                counts={stats.symbols.byKind}
              />
              <Breakdown
                title="Dependency resolution"
                counts={stats.dependencies.byStatus}
                toneFor={resolutionTone}
              />
              <Breakdown
                title="Call resolution"
                counts={stats.calls.byResolution}
                toneFor={resolutionTone}
              />
            </div>
          </Panel>

          {stats.diagnosticsPreview.length > 0 && (
            <Panel
              title={`Diagnostics (${stats.diagnostics.total})`}
              action={
                <span className="text-xs text-stone-500">
                  Showing errors and warnings
                </span>
              }
            >
              <ul className="divide-y divide-stone-800">
                {stats.diagnosticsPreview.map((d) => (
                  <li
                    key={d.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm"
                  >
                    <Badge tone={d.severity === "ERROR" ? "bad" : "warn"}>
                      {d.severity.toLowerCase()}
                    </Badge>
                    <span className="text-stone-300">{d.message}</span>
                    {d.path && (
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate({
                            view: "files",
                            file: d.path,
                            line: d.line,
                          })
                        }
                        className="font-mono text-xs text-orange-300 hover:underline"
                      >
                        {d.path}
                        {d.line ? `:${d.line}` : ""}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}

      {state.explorable && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[
            {
              view: "files",
              title: "Browse files",
              text: "Folders, source code and per-file analysis.",
            },
            {
              view: "symbols",
              title: "Explore symbols",
              text: "Functions, classes, types and their relationships.",
            },
            {
              view: "graph",
              title: "Dependency graph",
              text: "Interactive imports, calls and inheritance.",
            },
            {
              view: "search",
              title: "Search the codebase",
              text: "Files, symbols, modules and exports.",
            },
            {
              view: "findings",
              title: "Findings",
              text: "Deterministic dependency, complexity, structure and security-indicator checks.",
            },
          ].map((card) => (
            <button
              key={card.view}
              type="button"
              onClick={() =>
                onNavigate({ view: card.view as ExplorerState["view"] })
              }
              className="rounded-2xl border border-stone-800 bg-stone-900/70 p-5 text-left transition hover:border-orange-500/40 hover:bg-stone-900"
            >
              <p className="font-semibold text-stone-100">{card.title}</p>
              <p className="mt-1 text-sm text-stone-400">{card.text}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
