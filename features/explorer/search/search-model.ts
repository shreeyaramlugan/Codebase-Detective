// features/explorer/search/search-model.ts
//
// Shared shapes for the unified search API and the rule that decides where
// selecting a result navigates.
import type { ExplorerState } from "../navigation/explorer-url";

export const SEARCH_CATEGORIES = [
  "files",
  "symbols",
  "modules",
  "exports",
] as const;

export type SearchCategory = (typeof SEARCH_CATEGORIES)[number];

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 100;

export interface FileSearchResult {
  path: string;
  name: string;
  status: string;
  symbolCount: number | null;
}

export interface SymbolSearchResult {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  path: string;
  startLine: number;
  startColumn: number;
  isExported: boolean;
}

export interface ExportSearchResult extends SymbolSearchResult {
  exportNames: string[];
  isDefaultExport: boolean;
}

export interface ModuleSearchResult {
  specifier: string;
  status: string;
  /** Internal file the specifier resolved to, if any. */
  targetPath: string | null;
  externalPackage: string | null;
  /** One file that imports it, so every result has a source location. */
  importedBy: { path: string; line: number };
}

export interface CategoryResults<T> {
  items: T[];
  hasMore: boolean;
}

export interface UnifiedSearchResponse {
  query: string;
  analysisId: string;
  results: {
    files?: CategoryResults<FileSearchResult>;
    symbols?: CategoryResults<SymbolSearchResult>;
    modules?: CategoryResults<ModuleSearchResult>;
    exports?: CategoryResults<ExportSearchResult>;
  };
}

export type SearchSelection =
  | { category: "files"; item: FileSearchResult }
  | { category: "symbols"; item: SymbolSearchResult }
  | { category: "exports"; item: ExportSearchResult }
  | { category: "modules"; item: ModuleSearchResult };

/**
 * Where selecting a search result goes:
 *  - file        -> files view, file open
 *  - symbol/export -> files view at the declaration line, symbol selected
 *  - module      -> the resolved internal file, otherwise the importing line
 */
export function navigationForResult(
  selection: SearchSelection,
): Partial<ExplorerState> {
  switch (selection.category) {
    case "files":
      return { view: "files", file: selection.item.path, line: null };
    case "symbols":
    case "exports":
      return {
        view: "files",
        file: selection.item.path,
        line: selection.item.startLine,
        symbol: selection.item.id,
      };
    case "modules":
      return selection.item.targetPath
        ? { view: "files", file: selection.item.targetPath, line: null }
        : {
            view: "files",
            file: selection.item.importedBy.path,
            line: selection.item.importedBy.line,
          };
  }
}
