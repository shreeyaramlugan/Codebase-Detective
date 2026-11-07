// components/explorer/FileExplorer.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

import type { AnalysisTreeView } from "@/lib/explorer/explorer.service";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import {
  ancestorPaths,
  buildFileTree,
  describeAvailability,
  filterEntries,
  flattenVisible,
  type FileAvailability,
  type TreeFileEntry,
} from "@/features/explorer/tree/file-tree";

import FileTree from "./FileTree";
import SourceViewer from "./SourceViewer";
import {
  Badge,
  EmptyState,
  ErrorBox,
  Panel,
  Spinner,
  formatBytes,
  inputClass,
  kindTone,
  resolutionTone,
} from "./ui";
import { useApi, useDebounced, type ApiState } from "./useApi";

type Props = {
  repositoryId: string;
  snapshotId: string;
  analysisId: string;
  state: ExplorerState;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

interface FileDetail {
  file: {
    id: string;
    path: string;
    contentHash: string;
    reason: string | null;
  };
  symbols: Array<{
    id: string;
    name: string;
    kind: string;
    qualifiedName: string;
    parentId: string | null;
    startLine: number;
    startColumn: number;
    endLine: number;
    isExported: boolean;
  }>;
  dependencies: Array<{
    id: string;
    specifier: string;
    status: string;
    targetPath: string | null;
    kind: string;
    startLine: number;
  }>;
  importedBy: Array<{
    sourcePath: string;
    specifier: string;
    startLine: number;
  }>;
  diagnostics: Array<{
    id: string;
    severity: string;
    message: string;
    line: number | null;
  }>;
}

const FILTERS: Array<{ value: FileAvailability; label: string }> = [
  { value: "analysed", label: "Analysed" },
  { value: "analysed_with_errors", label: "Syntax errors" },
  { value: "stored", label: "Stored, not analysed" },
  { value: "skipped", label: "Skipped" },
  { value: "failed", label: "Unavailable / failed" },
];

function FileDetails({
  detail,
  entry,
  onNavigate,
}: {
  detail: ApiState<FileDetail>;
  entry: TreeFileEntry;
  onNavigate: Props["onNavigate"];
}) {
  const info = describeAvailability(entry);

  return (
    <Panel title="File details" className="min-w-0">
      <div className="space-y-4 p-4 text-sm">
        <div className="flex flex-wrap gap-2">
          <Badge
            tone={
              info.availability === "analysed"
                ? "good"
                : info.availability === "skipped" ||
                    info.availability === "analysed_with_errors"
                  ? "warn"
                  : info.availability === "failed" ||
                      info.availability === "unavailable"
                    ? "bad"
                    : "neutral"
            }
          >
            {info.label}
          </Badge>
          <Badge>{formatBytes(entry.sizeBytes)}</Badge>
          {entry.lineCount !== null && <Badge>{entry.lineCount} lines</Badge>}
          {entry.symbolCount !== null && (
            <Badge>{entry.symbolCount} symbols</Badge>
          )}
        </div>
        {info.detail && <p className="text-xs text-stone-400">{info.detail}</p>}

        {!entry.analysisFileId ? null : detail.loading ? (
          <Spinner label="Loading analysis..." />
        ) : detail.error ? (
          <ErrorBox message={detail.error} onRetry={detail.reload} />
        ) : detail.data ? (
          <>
            <section>
              <h4 className="mb-2 text-xs font-semibold text-stone-400">
                Symbols ({detail.data.symbols.length})
              </h4>
              {detail.data.symbols.length === 0 ? (
                <p className="text-xs text-stone-600">No symbols extracted.</p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-auto">
                  {detail.data.symbols.map((symbol) => (
                    <li key={symbol.id}>
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate({
                            view: "files",
                            file: entry.path,
                            line: symbol.startLine,
                            symbol: symbol.id,
                          })
                        }
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-stone-800"
                      >
                        <Badge tone={kindTone(symbol.kind)}>
                          {symbol.kind.toLowerCase()}
                        </Badge>
                        <span
                          className="truncate text-stone-200"
                          title={symbol.qualifiedName}
                        >
                          {symbol.qualifiedName}
                        </span>
                        <span className="ml-auto shrink-0 text-stone-600">
                          :{symbol.startLine}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h4 className="mb-2 text-xs font-semibold text-stone-400">
                Imports ({detail.data.dependencies.length})
              </h4>
              <ul className="max-h-48 space-y-1 overflow-auto">
                {detail.data.dependencies.map((dependency) => (
                  <li
                    key={dependency.id}
                    className="flex items-center gap-2 text-xs"
                  >
                    <Badge tone={resolutionTone(dependency.status)}>
                      {dependency.status.toLowerCase()}
                    </Badge>
                    {dependency.status === "RESOLVED" &&
                    dependency.targetPath ? (
                      <button
                        type="button"
                        onClick={() =>
                          onNavigate({
                            view: "files",
                            file: dependency.targetPath,
                            line: null,
                          })
                        }
                        className="truncate text-orange-300 hover:underline"
                        title={dependency.targetPath}
                      >
                        {dependency.specifier}
                      </button>
                    ) : (
                      <span className="truncate text-stone-400">
                        {dependency.specifier}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h4 className="mb-2 text-xs font-semibold text-stone-400">
                Imported by ({detail.data.importedBy.length})
              </h4>
              <ul className="max-h-40 space-y-1 overflow-auto">
                {detail.data.importedBy.map((item, index) => (
                  <li key={`${item.sourcePath}:${item.startLine}:${index}`}>
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate({
                          view: "files",
                          file: item.sourcePath,
                          line: item.startLine,
                        })
                      }
                      className="truncate text-xs text-orange-300 hover:underline"
                    >
                      {item.sourcePath}:{item.startLine}
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {detail.data.diagnostics.length > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold text-stone-400">
                  Diagnostics ({detail.data.diagnostics.length})
                </h4>
                <ul className="space-y-1">
                  {detail.data.diagnostics.map((d) => (
                    <li key={d.id} className="text-xs text-stone-400">
                      <Badge tone={d.severity === "ERROR" ? "bad" : "warn"}>
                        {d.severity.toLowerCase()}
                      </Badge>{" "}
                      {d.message}
                      {d.line ? ` (line ${d.line})` : ""}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export default function FileExplorer({
  repositoryId,
  snapshotId,
  analysisId,
  state,
  onNavigate,
}: Props) {
  const tree = useApi<AnalysisTreeView>(
    `/api/analyses/${encodeURIComponent(analysisId)}/explorer/tree`,
  );

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounced(query, 200);
  const [availability, setAvailability] = useState<FileAvailability | "">("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const entries = tree.data?.entries;
  const filterActive = debouncedQuery.trim().length > 0 || availability !== "";

  const root = useMemo(
    () =>
      buildFileTree(
        filterEntries(entries ?? [], {
          query: debouncedQuery,
          availability: availability ? [availability] : [],
        }),
      ),
    [entries, debouncedQuery, availability],
  );

  const rows = useMemo(
    () => flattenVisible(root, expanded, filterActive),
    [root, expanded, filterActive],
  );

  // Reveal the open file in the tree.
  useEffect(() => {
    if (!state.file) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const dir of ancestorPaths(state.file!)) next.add(dir);
      return next;
    });
  }, [state.file]);

  const selected = useMemo(
    () => entries?.find((entry) => entry.path === state.file) ?? null,
    [entries, state.file],
  );

  // Analysis detail for the open file (symbols, imports, content hash).
  const detail = useApi<FileDetail>(
    selected?.analysisFileId
      ? `/api/analyses/${encodeURIComponent(analysisId)}/files/${encodeURIComponent(selected.analysisFileId)}`
      : null,
  );

  const toggle = (path: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (tree.loading) return <Spinner label="Loading files..." />;
  if (tree.error)
    return <ErrorBox message={tree.error} onRetry={tree.reload} />;
  if (!entries || entries.length === 0) {
    return (
      <EmptyState
        title="This snapshot contains no files"
        message="There is nothing to browse for this commit."
      />
    );
  }

  const viewInfo = selected ? describeAvailability(selected) : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_320px]">
      <Panel
        title={`Files (${entries.length.toLocaleString()})`}
        className="min-w-0"
      >
        <div className="space-y-2 border-b border-stone-800 p-3">
          <label htmlFor="tree-filter" className="sr-only">
            Filter files
          </label>
          <input
            id="tree-filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by path..."
            className={inputClass}
          />
          <label htmlFor="tree-status" className="sr-only">
            Filter by status
          </label>
          <select
            id="tree-status"
            value={availability}
            onChange={(event) =>
              setAvailability(event.target.value as FileAvailability | "")
            }
            className={inputClass}
          >
            <option value="">All files</option>
            {FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
          {tree.data?.truncated && (
            <p className="text-xs text-amber-400">
              Very large repository: only the first files are listed.
            </p>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title="No files match"
            message="Try a different filter."
          />
        ) : (
          <FileTree
            rows={rows}
            selectedPath={state.file}
            height={520}
            onToggle={toggle}
            onSelect={(path) =>
              onNavigate({
                view: "files",
                file: path,
                line: null,
                symbol: null,
              })
            }
          />
        )}
      </Panel>

      <Panel className="min-w-0">
        {!selected ? (
          state.file ? (
            <EmptyState
              title="File not found in this snapshot"
              message={`${state.file} is not part of the selected analysis.`}
            />
          ) : (
            <EmptyState
              title="Select a file"
              message="Choose a file from the tree to read its source."
            />
          )
        ) : viewInfo && !viewInfo.viewable ? (
          <div className="p-6">
            <p className="font-mono text-sm text-stone-300">{selected.path}</p>
            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
              <p className="text-sm font-medium text-amber-300">
                Source is not available ({viewInfo.label.toLowerCase()})
              </p>
              <p className="mt-1 text-sm text-stone-400">{viewInfo.detail}</p>
            </div>
          </div>
        ) : (
          <SourceViewer
            key={selected.path}
            repositoryId={repositoryId}
            snapshotId={snapshotId}
            path={selected.path}
            line={state.line}
            range={
              state.line ? { startLine: state.line, endLine: state.line } : null
            }
            analysisContentHash={detail.data?.file.contentHash ?? null}
          />
        )}
      </Panel>

      {selected ? (
        <FileDetails detail={detail} entry={selected} onNavigate={onNavigate} />
      ) : (
        <Panel title="File details">
          <EmptyState title="No file selected" />
        </Panel>
      )}
    </div>
  );
}
