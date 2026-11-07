// components/explorer/CodeSearch.tsx
"use client";

import { useState, type ReactNode } from "react";

import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";
import {
  MIN_QUERY_LENGTH,
  SEARCH_CATEGORIES,
  navigationForResult,
  type SearchCategory,
  type SearchSelection,
  type UnifiedSearchResponse,
} from "@/features/explorer/search/search-model";

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
import { useApi, useDebounced } from "./useApi";

type Props = {
  analysisId: string;
  query: string;
  onQueryChange: (q: string) => void;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

const TITLES: Record<SearchCategory, string> = {
  files: "Files and paths",
  symbols: "Symbols",
  modules: "Modules",
  exports: "Exports",
};

function Row({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="block w-full px-4 py-2 text-left hover:bg-stone-800/60"
      >
        {children}
      </button>
    </li>
  );
}

export default function CodeSearch({
  analysisId,
  query,
  onQueryChange,
  onNavigate,
}: Props) {
  const [categories, setCategories] = useState<SearchCategory[]>([
    ...SEARCH_CATEGORIES,
  ]);
  const debounced = useDebounced(query.trim(), 300);
  const ready = debounced.length >= MIN_QUERY_LENGTH && categories.length > 0;

  const url = ready
    ? `/api/analyses/${encodeURIComponent(analysisId)}/explorer/search?` +
      new URLSearchParams({
        q: debounced,
        categories: categories.join(","),
        limit: "15",
      })
    : null;

  const search = useApi<UnifiedSearchResponse>(url);

  const open = (selection: SearchSelection) =>
    onNavigate(navigationForResult(selection));

  const results = search.data?.results;
  const total = results
    ? SEARCH_CATEGORIES.reduce(
        (sum, c) => sum + (results[c]?.items.length ?? 0),
        0,
      )
    : 0;

  return (
    <div className="space-y-4">
      <Panel>
        <div className="space-y-3 p-4">
          <label htmlFor="code-search" className="sr-only">
            Search the codebase
          </label>
          <input
            id="code-search"
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search files, symbols, modules and exports..."
            className={inputClass}
          />
          <div
            className="flex flex-wrap gap-4 text-xs text-stone-400"
            role="group"
            aria-label="Categories"
          >
            {SEARCH_CATEGORIES.map((category) => (
              <label key={category} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={categories.includes(category)}
                  onChange={() =>
                    setCategories((current) =>
                      current.includes(category)
                        ? current.filter((c) => c !== category)
                        : [...current, category],
                    )
                  }
                />
                {TITLES[category]}
              </label>
            ))}
          </div>
        </div>
      </Panel>

      {categories.length === 0 ? (
        <EmptyState title="Choose at least one category" />
      ) : !ready ? (
        <EmptyState
          title="Start typing to search"
          message={`Enter at least ${MIN_QUERY_LENGTH} characters. Results are limited to this analysis.`}
        />
      ) : search.loading ? (
        <Spinner label="Searching..." />
      ) : search.error ? (
        <ErrorBox message={search.error} onRetry={search.reload} />
      ) : total === 0 ? (
        <EmptyState
          title={`No results for "${debounced}"`}
          message="Try a shorter term or enable more categories."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {results?.files && results.files.items.length > 0 && (
            <Panel
              title={`${TITLES.files} (${results.files.items.length}${results.files.hasMore ? "+" : ""})`}
            >
              <ul className="divide-y divide-stone-800/60">
                {results.files.items.map((item) => (
                  <Row
                    key={item.path}
                    onClick={() => open({ category: "files", item })}
                  >
                    <span className="block truncate text-sm text-stone-100">
                      {item.name}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-stone-500">
                      {item.path}
                    </span>
                  </Row>
                ))}
              </ul>
              {results.files.hasMore && <More />}
            </Panel>
          )}

          {results?.symbols && results.symbols.items.length > 0 && (
            <Panel
              title={`${TITLES.symbols} (${results.symbols.items.length}${results.symbols.hasMore ? "+" : ""})`}
            >
              <ul className="divide-y divide-stone-800/60">
                {results.symbols.items.map((item) => (
                  <Row
                    key={item.id}
                    onClick={() => open({ category: "symbols", item })}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={kindTone(item.kind)}>
                        {item.kind.toLowerCase()}
                      </Badge>
                      <span className="truncate text-sm text-stone-100">
                        {item.qualifiedName}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-[11px] text-stone-500">
                      {item.path}:{item.startLine}
                    </span>
                  </Row>
                ))}
              </ul>
              {results.symbols.hasMore && <More />}
            </Panel>
          )}

          {results?.modules && results.modules.items.length > 0 && (
            <Panel
              title={`${TITLES.modules} (${results.modules.items.length}${results.modules.hasMore ? "+" : ""})`}
            >
              <ul className="divide-y divide-stone-800/60">
                {results.modules.items.map((item) => (
                  <Row
                    key={`${item.specifier}|${item.status}|${item.targetPath}`}
                    onClick={() => open({ category: "modules", item })}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={resolutionTone(item.status)}>
                        {item.status.toLowerCase()}
                      </Badge>
                      <span className="truncate font-mono text-sm text-stone-100">
                        {item.specifier}
                      </span>
                    </span>
                    <span className="block truncate font-mono text-[11px] text-stone-500">
                      {item.targetPath
                        ? `→ ${item.targetPath}`
                        : `imported in ${item.importedBy.path}:${item.importedBy.line}`}
                    </span>
                  </Row>
                ))}
              </ul>
              {results.modules.hasMore && <More />}
            </Panel>
          )}

          {results?.exports && results.exports.items.length > 0 && (
            <Panel
              title={`${TITLES.exports} (${results.exports.items.length}${results.exports.hasMore ? "+" : ""})`}
            >
              <ul className="divide-y divide-stone-800/60">
                {results.exports.items.map((item) => (
                  <Row
                    key={item.id}
                    onClick={() => open({ category: "exports", item })}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone={kindTone(item.kind)}>
                        {item.kind.toLowerCase()}
                      </Badge>
                      <span className="truncate text-sm text-stone-100">
                        {item.qualifiedName}
                      </span>
                      {item.isDefaultExport && (
                        <Badge tone="good">default</Badge>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-stone-500">
                      {item.path}:{item.startLine}
                      {item.exportNames.length > 0
                        ? ` · as ${item.exportNames.join(", ")}`
                        : ""}
                    </span>
                  </Row>
                ))}
              </ul>
              {results.exports.hasMore && <More />}
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

function More() {
  return (
    <p className="border-t border-stone-800 px-4 py-2 text-xs text-stone-500">
      More results exist. Refine your search to narrow them down.
    </p>
  );
}
