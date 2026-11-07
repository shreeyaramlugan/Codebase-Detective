// features/explorer/tree/file-tree.ts
//
// Pure model for the hierarchical file explorer. The server returns a flat,
// merged list (snapshot files + analysis files); this module turns it into a
// tree and into the flat list of rows that are currently visible.

export interface TreeFileEntry {
  path: string;
  name: string;
  extension: string | null;
  /** Snapshot file status: STORED | SKIPPED | FAILED | ELIGIBLE | DISCOVERED. */
  snapshotStatus: string;
  skipReason: string | null;
  failureCode: string | null;
  analysisFileId: string | null;
  /** ANALYSED | ANALYSED_WITH_ERRORS | CONFIG | SKIPPED | FAILED, if analysed. */
  analysisStatus: string | null;
  sizeBytes: number | null;
  lineCount: number | null;
  symbolCount: number | null;
  syntaxErrorCount: number | null;
}

export type FileAvailability =
  | "analysed"
  | "analysed_with_errors"
  | "config"
  | "stored"
  | "skipped"
  | "failed"
  | "unavailable";

export interface FileAvailabilityInfo {
  availability: FileAvailability;
  label: string;
  /** Source can be read through the protected content endpoint. */
  viewable: boolean;
  detail: string | null;
}

export function describeAvailability(
  entry: TreeFileEntry,
): FileAvailabilityInfo {
  const viewable = entry.snapshotStatus === "STORED";

  if (entry.snapshotStatus === "SKIPPED") {
    return {
      availability: "skipped",
      label: "Skipped",
      viewable: false,
      detail: entry.skipReason ?? "Skipped during ingestion.",
    };
  }

  if (entry.snapshotStatus === "FAILED") {
    return {
      availability: "failed",
      label: "Unavailable",
      viewable: false,
      detail: entry.failureCode
        ? `Could not be retrieved (${entry.failureCode}).`
        : "Could not be retrieved during ingestion.",
    };
  }

  if (!viewable) {
    return {
      availability: "unavailable",
      label: "Not stored",
      viewable: false,
      detail: "Source for this file was not stored.",
    };
  }

  switch (entry.analysisStatus) {
    case "ANALYSED":
      return {
        availability: "analysed",
        label: "Analysed",
        viewable,
        detail: null,
      };
    case "ANALYSED_WITH_ERRORS":
      return {
        availability: "analysed_with_errors",
        label: "Analysed with syntax errors",
        viewable,
        detail: "The parser reported syntax errors; results may be incomplete.",
      };
    case "CONFIG":
      return {
        availability: "config",
        label: "Config",
        viewable,
        detail: null,
      };
    case "FAILED":
    case "SKIPPED":
      return {
        availability: "failed",
        label: "Not analysed",
        viewable,
        detail: "Source is available but analysis did not complete for it.",
      };
    default:
      return {
        availability: "stored",
        label: "Stored",
        viewable,
        detail: "Source is stored but this file type is not analysed.",
      };
  }
}

export interface DirNode {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
}

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
  entry: TreeFileEntry;
}

export type TreeNode = DirNode | FileNode;

function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  const left = a.name.toLowerCase();
  const right = b.name.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function buildFileTree(entries: readonly TreeFileEntry[]): DirNode {
  const root: DirNode = {
    kind: "dir",
    name: "",
    path: "",
    children: [],
    fileCount: 0,
  };
  const dirs = new Map<string, DirNode>([["", root]]);

  for (const entry of entries) {
    const segments = entry.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;

    let parent = root;
    let current = "";

    for (let i = 0; i < segments.length - 1; i += 1) {
      current = current ? `${current}/${segments[i]}` : segments[i];
      let dir = dirs.get(current);

      if (!dir) {
        dir = {
          kind: "dir",
          name: segments[i],
          path: current,
          children: [],
          fileCount: 0,
        };
        dirs.set(current, dir);
        parent.children.push(dir);
      }

      dir.fileCount += 1;
      parent = dir;
    }

    root.fileCount += 1;
    parent.children.push({
      kind: "file",
      name: segments[segments.length - 1],
      path: segments.join("/"),
      entry,
    });
  }

  for (const dir of dirs.values()) dir.children.sort(compareNodes);
  return root;
}

export interface TreeFilter {
  query?: string;
  /** Availability values to keep. Empty/undefined keeps everything. */
  availability?: readonly FileAvailability[];
}

export function filterEntries(
  entries: readonly TreeFileEntry[],
  filter: TreeFilter,
): TreeFileEntry[] {
  const query = (filter.query ?? "").trim().toLowerCase();
  const allowed =
    filter.availability && filter.availability.length > 0
      ? new Set<FileAvailability>(filter.availability)
      : null;

  if (!query && !allowed) return entries.slice();

  return entries.filter((entry) => {
    if (query && !entry.path.toLowerCase().includes(query)) return false;
    if (allowed && !allowed.has(describeAvailability(entry).availability)) {
      return false;
    }
    return true;
  });
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  expanded: boolean;
}

/** Visible rows in display order. Collapsed directories contribute no children. */
export function flattenVisible(
  root: DirNode,
  expanded: ReadonlySet<string>,
  expandAll = false,
): TreeRow[] {
  const rows: TreeRow[] = [];

  // Iterative so very deep trees cannot overflow the call stack.
  const stack: Array<{ node: TreeNode; depth: number }> = [];
  for (let i = root.children.length - 1; i >= 0; i -= 1) {
    stack.push({ node: root.children[i], depth: 0 });
  }

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const isOpen =
      node.kind === "dir" && (expandAll || expanded.has(node.path));
    rows.push({ node, depth, expanded: isOpen });

    if (node.kind === "dir" && isOpen) {
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node.children[i], depth: depth + 1 });
      }
    }
  }

  return rows;
}

/** Every ancestor directory path of `path` (for revealing a selected file). */
export function ancestorPaths(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = current ? `${current}/${segments[i]}` : segments[i];
    result.push(current);
  }
  return result;
}

export function indexOfPath(rows: readonly TreeRow[], path: string): number {
  return rows.findIndex((row) => row.node.path === path);
}

/** Short label used as a file-type indicator. */
export function fileTypeBadge(extension: string | null, name: string): string {
  const ext = (extension ?? "").replace(/^\./, "").toLowerCase();
  const map: Record<string, string> = {
    ts: "TS",
    tsx: "TSX",
    mts: "TS",
    cts: "TS",
    js: "JS",
    jsx: "JSX",
    mjs: "JS",
    cjs: "JS",
    json: "{}",
    md: "MD",
    css: "CSS",
    html: "HTML",
    yml: "YML",
    yaml: "YML",
    prisma: "PRI",
    sql: "SQL",
    sh: "SH",
    py: "PY",
  };
  if (map[ext]) return map[ext];
  if (name.startsWith(".")) return "CFG";
  return ext ? ext.slice(0, 3).toUpperCase() : "TXT";
}
