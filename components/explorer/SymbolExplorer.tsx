// components/explorer/SymbolExplorer.tsx
"use client";

import { useEffect, useMemo, useState } from "react";

import type {
  ExplorerSymbolRow,
  SymbolDetailView,
  SymbolBrief,
  SymbolPage,
} from "@/lib/explorer/explorer.service";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";

import SourceViewer from "./SourceViewer";
import {
  Badge,
  EmptyState,
  ErrorBox,
  Panel,
  Spinner,
  inputClass,
  kindTone,
  resolutionTone,
} from "./ui";
import { readApiError, useApi, useDebounced } from "./useApi";

const KINDS = [
  "FUNCTION",
  "CLASS",
  "METHOD",
  "INTERFACE",
  "TYPE",
  "VARIABLE",
  "ENUM",
] as const;

type Props = {
  repositoryId: string;
  snapshotId: string;
  analysisId: string;
  state: ExplorerState;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

interface Filters {
  q: string;
  kinds: string[];
  pathContains: string;
  exportedOnly: boolean;
  topLevelOnly: boolean;
}

function buildUrl(analysisId: string, filters: Filters, cursor: string | null) {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.kinds.length > 0) params.set("kinds", filters.kinds.join(","));
  if (filters.pathContains.trim()) {
    params.set("pathContains", filters.pathContains.trim());
  }
  if (filters.exportedOnly) params.set("exported", "true");
  if (filters.topLevelOnly) params.set("parent", "none");
  params.set("limit", "50");
  if (cursor) params.set("cursor", cursor);
  return `/api/analyses/${encodeURIComponent(analysisId)}/explorer/symbols?${params}`;
}

function BriefLink({
  brief,
  onOpen,
}: {
  brief: SymbolBrief;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(brief.id)}
      className="flex items-center gap-2 text-left text-xs hover:underline"
      title={`${brief.path}:${brief.startLine}`}
    >
      <Badge tone={kindTone(brief.kind)}>{brief.kind.toLowerCase()}</Badge>
      <span className="truncate text-orange-300">{brief.qualifiedName}</span>
      <span className="shrink-0 text-stone-600">
        {brief.path}:{brief.startLine}
      </span>
    </button>
  );
}

function SymbolDetail({
  repositoryId,
  snapshotId,
  analysisId,
  symbolId,
  onSelect,
  onNavigate,
}: {
  repositoryId: string;
  snapshotId: string;
  analysisId: string;
  symbolId: string;
  onSelect: (id: string) => void;
  onNavigate: Props["onNavigate"];
}) {
  const detail = useApi<SymbolDetailView>(
    `/api/analyses/${encodeURIComponent(analysisId)}/explorer/symbols/${encodeURIComponent(symbolId)}`,
  );

  if (detail.loading) return <Spinner label="Loading symbol..." />;
  if (detail.error)
    return <ErrorBox message={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  const {
    symbol,
    parent,
    children,
    extendsOrImplements,
    extendedBy,
    callers,
    callees,
    limits,
  } = detail.data;
  const location = symbol.location;

  return (
    <div className="space-y-4">
      <div className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={kindTone(symbol.kind)}>
            {symbol.kind.toLowerCase()}
          </Badge>
          {symbol.isExported && <Badge tone="good">exported</Badge>}
          {symbol.isDefaultExport && <Badge tone="good">default export</Badge>}
          <h3 className="break-all text-base font-semibold text-stone-100">
            {symbol.qualifiedName}
          </h3>
        </div>
        <p className="font-mono text-xs text-stone-400">
          {symbol.path}:{location.startLine}:{location.startColumn} –{" "}
          {location.endLine}:{location.endColumn}
        </p>
        {symbol.exportNames.length > 0 && (
          <p className="text-xs text-stone-400">
            Exported as: {symbol.exportNames.join(", ")}
          </p>
        )}
        <button
          type="button"
          onClick={() =>
            onNavigate({
              view: "files",
              file: symbol.path,
              line: location.startLine,
              symbol: symbol.id,
            })
          }
          className="rounded-lg border border-orange-500/30 px-3 py-1.5 text-xs font-medium text-orange-300 hover:bg-orange-500/10"
        >
          Open in file explorer
        </button>
      </div>

      <div className="border-y border-stone-800">
        <SourceViewer
          key={`${symbol.path}:${symbol.id}`}
          repositoryId={repositoryId}
          snapshotId={snapshotId}
          path={symbol.path}
          line={location.startLine}
          range={{ startLine: location.startLine, endLine: location.endLine }}
          height={260}
        />
      </div>

      <div className="space-y-4 p-4">
        {parent && (
          <section>
            <h4 className="mb-1 text-xs font-semibold text-stone-400">
              Parent
            </h4>
            <BriefLink brief={parent} onOpen={onSelect} />
          </section>
        )}

        {children.length > 0 && (
          <section>
            <h4 className="mb-1 text-xs font-semibold text-stone-400">
              Members ({children.length}
              {children.length >= limits.perList ? "+" : ""})
            </h4>
            <ul className="space-y-1">
              {children.map((child) => (
                <li key={child.id}>
                  <BriefLink brief={child} onOpen={onSelect} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {(extendsOrImplements.length > 0 || extendedBy.length > 0) && (
          <section>
            <h4 className="mb-1 text-xs font-semibold text-stone-400">
              Inheritance
            </h4>
            <ul className="space-y-1">
              {extendsOrImplements.map((r, i) => (
                <li key={`o${i}`} className="flex items-center gap-2 text-xs">
                  <Badge tone={resolutionTone(r.status)}>
                    {r.kind.toLowerCase()}
                  </Badge>
                  {r.target ? (
                    <BriefLink brief={r.target} onOpen={onSelect} />
                  ) : (
                    <span className="text-stone-400">
                      {r.targetName} ({r.status.toLowerCase()})
                    </span>
                  )}
                </li>
              ))}
              {extendedBy.map((r, i) =>
                r.source ? (
                  <li key={`i${i}`} className="flex items-center gap-2 text-xs">
                    <Badge>{r.kind.toLowerCase()} this</Badge>
                    <BriefLink brief={r.source} onOpen={onSelect} />
                  </li>
                ) : null,
              )}
            </ul>
          </section>
        )}

        <section>
          <h4 className="mb-1 text-xs font-semibold text-stone-400">
            Called by ({callers.length}
            {callers.length >= limits.perList ? "+" : ""})
          </h4>
          {callers.length === 0 ? (
            <p className="text-xs text-stone-600">No recorded callers.</p>
          ) : (
            <ul className="space-y-1">
              {callers.map((call, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <Badge tone={resolutionTone(call.resolution)}>
                    {call.resolution.toLowerCase()}
                  </Badge>
                  {call.caller ? (
                    <BriefLink brief={call.caller} onOpen={onSelect} />
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate({
                          view: "files",
                          file: call.path,
                          line: call.line,
                        })
                      }
                      className="text-orange-300 hover:underline"
                    >
                      {call.path}:{call.line}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4 className="mb-1 text-xs font-semibold text-stone-400">
            Calls ({callees.length}
            {callees.length >= limits.perList ? "+" : ""})
          </h4>
          {callees.length === 0 ? (
            <p className="text-xs text-stone-600">No recorded calls.</p>
          ) : (
            <ul className="space-y-1">
              {callees.map((call, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <Badge tone={resolutionTone(call.resolution)}>
                    {call.resolution.toLowerCase()}
                  </Badge>
                  {call.target ? (
                    <BriefLink brief={call.target} onOpen={onSelect} />
                  ) : (
                    <span className="font-mono text-stone-400">
                      {call.calleeText} (unresolved)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

export default function SymbolExplorer({
  repositoryId,
  snapshotId,
  analysisId,
  state,
  onNavigate,
}: Props) {
  const [filters, setFilters] = useState<Filters>({
    q: "",
    kinds: [],
    pathContains: "",
    exportedOnly: false,
    topLevelOnly: false,
  });
  const debounced = useDebounced(filters, 250);

  const [items, setItems] = useState<ExplorerSymbolRow[]>([]);
  const [facets, setFacets] = useState<Record<string, number> | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // First page whenever the analysis or any filter changes. Results from a
  // previous analysis are discarded, so runs can never be mixed.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    setNextCursor(null);

    fetch(buildUrl(analysisId, debounced, null), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiError(response));
        return (await response.json()) as SymbolPage;
      })
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setFacets(page.facets);
        setNextCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Symbols could not be loaded.",
        );
        setLoading(false);
      });

    return () => controller.abort();
  }, [analysisId, debounced, nonce]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(buildUrl(analysisId, debounced, nextCursor));
      if (!response.ok) throw new Error(await readApiError(response));
      const page = (await response.json()) as SymbolPage;
      setItems((previous) => [...previous, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load more symbols.",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleKind = (kind: string) =>
    setFilters((f) => ({
      ...f,
      kinds: f.kinds.includes(kind)
        ? f.kinds.filter((k) => k !== kind)
        : [...f.kinds, kind],
    }));

  // Symbols that share a name get their location shown prominently.
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items)
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
  }, [items]);

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Panel title="Symbols" className="min-w-0">
        <div className="space-y-3 border-b border-stone-800 p-3">
          <label htmlFor="symbol-q" className="sr-only">
            Search symbols
          </label>
          <input
            id="symbol-q"
            value={filters.q}
            onChange={(event) =>
              setFilters((f) => ({ ...f, q: event.target.value }))
            }
            placeholder="Search name or qualified name..."
            className={inputClass}
          />
          <div
            className="flex flex-wrap gap-1.5"
            role="group"
            aria-label="Symbol kinds"
          >
            {KINDS.map((kind) => {
              const active = filters.kinds.includes(kind);
              const count = facets?.[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleKind(kind)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                    active
                      ? "border-orange-500/60 bg-orange-500/10 text-orange-200"
                      : "border-stone-700 text-stone-400 hover:bg-stone-800"
                  }`}
                >
                  {kind.toLowerCase()}
                  {count !== undefined ? ` · ${count}` : ""}
                </button>
              );
            })}
          </div>
          <label htmlFor="symbol-path" className="sr-only">
            Filter by file path
          </label>
          <input
            id="symbol-path"
            value={filters.pathContains}
            onChange={(event) =>
              setFilters((f) => ({ ...f, pathContains: event.target.value }))
            }
            placeholder="File path contains..."
            className={inputClass}
          />
          <div className="flex flex-wrap gap-4 text-xs text-stone-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.exportedOnly}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, exportedOnly: e.target.checked }))
                }
              />
              Exported only
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={filters.topLevelOnly}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, topLevelOnly: e.target.checked }))
                }
              />
              Top level only
            </label>
          </div>
        </div>

        {loading ? (
          <Spinner label="Loading symbols..." />
        ) : error ? (
          <ErrorBox message={error} onRetry={() => setNonce((n) => n + 1)} />
        ) : items.length === 0 ? (
          <EmptyState
            title="No symbols match"
            message="Adjust the search text or filters."
          />
        ) : (
          <>
            <ul
              className="max-h-[560px] divide-y divide-stone-800/60 overflow-auto"
              aria-label="Symbol results"
            >
              {items.map((item) => {
                const selected = state.symbol === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() =>
                        onNavigate({ view: "symbols", symbol: item.id })
                      }
                      aria-current={selected ? "true" : undefined}
                      className={`block w-full px-3 py-2 text-left ${
                        selected ? "bg-orange-500/10" : "hover:bg-stone-800/60"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Badge tone={kindTone(item.kind)}>
                          {item.kind.toLowerCase()}
                        </Badge>
                        <span className="truncate text-sm text-stone-100">
                          {item.qualifiedName}
                        </span>
                        {item.isExported && <Badge tone="good">export</Badge>}
                      </span>
                      <span
                        className={`mt-0.5 block truncate font-mono text-[11px] ${
                          duplicateNames.has(item.name)
                            ? "text-amber-400/80"
                            : "text-stone-500"
                        }`}
                      >
                        {item.path}:{item.location.startLine}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between border-t border-stone-800 px-3 py-2 text-xs text-stone-500">
              <span>
                {items.length} shown{nextCursor ? " · more available" : ""}
              </span>
              {nextCursor && (
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="rounded-lg border border-stone-700 px-3 py-1 text-stone-200 hover:bg-stone-800 disabled:opacity-50"
                >
                  {loadingMore ? "Loading..." : "Load more"}
                </button>
              )}
            </div>
          </>
        )}
      </Panel>

      <Panel title="Symbol details" className="min-w-0">
        {state.symbol ? (
          <SymbolDetail
            key={state.symbol}
            repositoryId={repositoryId}
            snapshotId={snapshotId}
            analysisId={analysisId}
            symbolId={state.symbol}
            onSelect={(id) => onNavigate({ view: "symbols", symbol: id })}
            onNavigate={onNavigate}
          />
        ) : (
          <EmptyState
            title="Select a symbol"
            message="Its source, hierarchy and relationships appear here."
          />
        )}
      </Panel>
    </div>
  );
}
