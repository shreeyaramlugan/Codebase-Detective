// features/explorer/navigation/explorer-url.ts
//
// The explorer keeps its navigation state in the URL so every view (and every
// source location) is deep-linkable. Everything parsed from the URL is
// treated as untrusted and validated here.

export const EXPLORER_VIEWS = [
  "overview",
  "files",
  "symbols",
  "graph",
  "search",
  "findings",
  "assistant",
] as const;

export type ExplorerView = (typeof EXPLORER_VIEWS)[number];

export interface ExplorerState {
  view: ExplorerView;
  /** Selected analysis id; absent means "the default for this repository". */
  analysis: string | null;
  /** Repository-relative path of the open file. */
  file: string | null;
  /** 1-based line to reveal in the open file. */
  line: number | null;
  /** Selected symbol id (symbols view). */
  symbol: string | null;
  /** Search / filter text. */
  q: string;
  /** Selected findings run id (findings view). */
  run: string | null;
  /** Selected finding id (findings view). */
  finding: string | null;
  /** Selected assistant conversation id (assistant view). */
  conversation: string | null;
}

export const DEFAULT_STATE: ExplorerState = {
  view: "overview",
  analysis: null,
  file: null,
  line: null,
  symbol: null,
  q: "",
  run: null,
  finding: null,
  conversation: null,
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PATH = 1024;
const MAX_QUERY = 100;
const MAX_LINE = 10_000_000;

/** Client-side sanity check; the server re-validates every path it receives. */
export function isSafeRepositoryPath(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.includes("\0")) return false;
  return value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

type ParamSource =
  URLSearchParams | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | null {
  if (source instanceof URLSearchParams) return source.get(key);
  const value = source[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function parseExplorerState(source: ParamSource): ExplorerState {
  const view = read(source, "view");
  const analysis = read(source, "analysis");
  const file = read(source, "file");
  const line = Number(read(source, "line"));
  const symbol = read(source, "symbol");
  const q = read(source, "q") ?? "";
  const run = read(source, "run");
  const finding = read(source, "finding");
  const conversation = read(source, "conversation");

  return {
    view: (EXPLORER_VIEWS as readonly string[]).includes(view ?? "")
      ? (view as ExplorerView)
      : "overview",
    analysis: analysis && ID_PATTERN.test(analysis) ? analysis : null,
    file: file && isSafeRepositoryPath(file) ? file : null,
    line: Number.isInteger(line) && line >= 1 && line <= MAX_LINE ? line : null,
    symbol: symbol && ID_PATTERN.test(symbol) ? symbol : null,
    q: q.slice(0, MAX_QUERY),
    run: run && ID_PATTERN.test(run) ? run : null,
    finding: finding && ID_PATTERN.test(finding) ? finding : null,
    conversation:
      conversation && ID_PATTERN.test(conversation) ? conversation : null,
  };
}

export function explorerSearchParams(state: ExplorerState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.view !== "overview") params.set("view", state.view);
  if (state.analysis) params.set("analysis", state.analysis);
  if (state.file) params.set("file", state.file);
  if (state.line) params.set("line", String(state.line));
  if (state.symbol) params.set("symbol", state.symbol);
  if (state.q) params.set("q", state.q);
  if (state.run) params.set("run", state.run);
  if (state.finding) params.set("finding", state.finding);
  if (state.conversation) params.set("conversation", state.conversation);
  return params;
}

export function explorerHref(
  repositoryId: string,
  state: Partial<ExplorerState>,
): string {
  const query = explorerSearchParams({ ...DEFAULT_STATE, ...state }).toString();
  const base = `/dashboard/repositories/${encodeURIComponent(repositoryId)}`;
  return query ? `${base}?${query}` : base;
}
