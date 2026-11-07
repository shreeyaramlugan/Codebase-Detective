// features/explorer/graph/graph-view.ts
//
// Pure view-model for the dependency graph: filtering, neighbourhood focus,
// size capping and a deterministic layered layout. It only ever REMOVES
// elements from the persisted read model; it never adds an edge, so an
// unresolved dependency can never appear as a drawn connection.
import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
} from "@/features/code-intelligence/graph/graph.types";

export const ALL_EDGE_TYPES = [
  "IMPORTS",
  "RE_EXPORTS",
  "EXPORTS",
  "DECLARES",
  "CONTAINS",
  "CALLS",
  "POSSIBLY_CALLS",
  "EXTENDS",
  "IMPLEMENTS",
  "REFERENCES",
] as const;

export const ALL_NODE_TYPES = [
  "FILE",
  "FUNCTION",
  "CLASS",
  "METHOD",
  "INTERFACE",
  "TYPE",
  "VARIABLE",
  "ENUM",
] as const;

export const DEFAULT_MAX_NODES = 300;

export interface GraphFilters {
  nodeTypes: ReadonlySet<string>;
  edgeTypes: ReadonlySet<string>;
  /** Free text matched against label, path and qualified name. */
  query: string;
  focusNodeId: string | null;
  focusDepth: number;
  hideIsolated: boolean;
  maxNodes: number;
}

/** File-level dependency map: the least noisy, most useful starting view. */
export function defaultGraphFilters(): GraphFilters {
  return {
    nodeTypes: new Set(["FILE"]),
    edgeTypes: new Set(["IMPORTS", "RE_EXPORTS"]),
    query: "",
    focusNodeId: null,
    focusDepth: 1,
    hideIsolated: true,
    maxNodes: DEFAULT_MAX_NODES,
  };
}

export interface FilteredGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Nodes that matched the filters but were dropped by the size cap. */
  cappedNodeCount: number;
  truncated: boolean;
}

function adjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let set = map.get(a);
    if (!set) {
      set = new Set();
      map.set(a, set);
    }
    set.add(b);
  };
  for (const edge of edges) {
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  return map;
}

export function neighbourhood(
  edges: readonly GraphEdge[],
  start: string,
  depth: number,
): Set<string> {
  const adj = adjacency(edges);
  const seen = new Set<string>([start]);
  let frontier = [start];

  for (let level = 0; level < depth; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbour of adj.get(id) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          next.push(neighbour);
        }
      }
    }
    frontier = next;
  }

  return seen;
}

export function applyGraphFilters(
  graph: Pick<DependencyGraph, "nodes" | "edges">,
  filters: GraphFilters,
): FilteredGraph {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  // 1. Type filters. Edges need both endpoints to survive the node filter.
  let edges = graph.edges.filter(
    (edge) =>
      filters.edgeTypes.has(edge.type) &&
      nodeById.has(edge.source) &&
      nodeById.has(edge.target) &&
      filters.nodeTypes.has(nodeById.get(edge.source)!.type) &&
      filters.nodeTypes.has(nodeById.get(edge.target)!.type),
  );
  let keep = new Set(
    graph.nodes.filter((n) => filters.nodeTypes.has(n.type)).map((n) => n.id),
  );

  // 2. Text query: matching nodes plus their direct neighbours.
  const query = filters.query.trim().toLowerCase();
  if (query) {
    const matching = new Set(
      graph.nodes
        .filter(
          (node) =>
            keep.has(node.id) &&
            (node.label.toLowerCase().includes(query) ||
              node.path.toLowerCase().includes(query) ||
              (node.qualifiedName ?? "").toLowerCase().includes(query)),
        )
        .map((node) => node.id),
    );
    const near = new Set(matching);
    for (const edge of edges) {
      if (matching.has(edge.source)) near.add(edge.target);
      if (matching.has(edge.target)) near.add(edge.source);
    }
    keep = new Set([...keep].filter((id) => near.has(id)));
  }

  // 3. Neighbourhood focus.
  if (filters.focusNodeId && keep.has(filters.focusNodeId)) {
    const around = neighbourhood(
      edges,
      filters.focusNodeId,
      filters.focusDepth,
    );
    keep = new Set([...keep].filter((id) => around.has(id)));
  }

  edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));

  // 4. Isolated nodes (never the focused one).
  if (filters.hideIsolated) {
    const connected = new Set<string>();
    for (const edge of edges) {
      connected.add(edge.source);
      connected.add(edge.target);
    }
    keep = new Set(
      [...keep].filter((id) => connected.has(id) || id === filters.focusNodeId),
    );
  }

  // 5. Size cap: keep the most connected nodes (stable tie-break on id).
  let cappedNodeCount = 0;
  if (keep.size > filters.maxNodes) {
    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    const ranked = [...keep].sort(
      (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1),
    );
    const kept = new Set(ranked.slice(0, filters.maxNodes));
    if (filters.focusNodeId && keep.has(filters.focusNodeId)) {
      kept.add(filters.focusNodeId);
    }
    cappedNodeCount = keep.size - kept.size;
    keep = kept;
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  }

  const nodes = graph.nodes.filter((node) => keep.has(node.id));

  return { nodes, edges, cappedNodeCount, truncated: cappedNodeCount > 0 };
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  columnWidth: number;
  rowHeight: number;
}

/**
 * Deterministic left-to-right layered layout.
 *  1. Back edges (cycles) are found with an iterative DFS and ignored for
 *     ranking, so circular imports do not loop or stack nodes.
 *  2. Rank = longest path from a source over the remaining DAG.
 *  3. Two barycentre sweeps order nodes inside each rank to reduce crossings.
 */
export function layoutGraph(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: LayoutOptions = { columnWidth: 260, rowHeight: 76 },
): Map<string, Point> {
  const ids = nodes.map((n) => n.id).sort();
  const out = new Map<string, string[]>();
  for (const id of ids) out.set(id, []);

  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (out.has(edge.source) && out.has(edge.target)) {
      out.get(edge.source)!.push(edge.target);
    }
  }
  for (const list of out.values()) list.sort();

  // Back-edge detection (iterative DFS).
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const targets = out.get(frame.id)!;
      if (frame.next >= targets.length) {
        state.set(frame.id, 2);
        stack.pop();
        continue;
      }
      const target = targets[frame.next];
      frame.next += 1;
      const s = state.get(target);
      if (s === 1) back.add(`${frame.id}\u0000${target}`);
      else if (!s) {
        state.set(target, 1);
        stack.push({ id: target, next: 0 });
      }
    }
  }

  // Longest-path ranking over the DAG (Kahn).
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [source, targets] of out) {
    for (const target of targets) {
      if (back.has(`${source}\u0000${target}`)) continue;
      forward.get(source)!.push(target);
      indegree.set(target, indegree.get(target)! + 1);
    }
  }

  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indegree.get(id) === 0);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const target of forward.get(id)!) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      indegree.set(target, indegree.get(target)! - 1);
      if (indegree.get(target) === 0) queue.push(target);
    }
  }

  const layers: string[][] = [];
  for (const id of ids) {
    const r = rank.get(id)!;
    (layers[r] ??= []).push(id);
  }

  // Barycentre ordering.
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [source, targets] of forward) {
    for (const target of targets) incoming.get(target)!.push(source);
  }
  const order = new Map<string, number>();
  const refresh = () =>
    layers.forEach((layer) => layer?.forEach((id, i) => order.set(id, i)));
  refresh();

  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (let r = 1; r < layers.length; r += 1) {
      const layer = layers[r];
      if (!layer) continue;
      const score = (id: string) => {
        const parents = incoming.get(id)!;
        if (parents.length === 0) return order.get(id)!;
        return (
          parents.reduce((sum, p) => sum + order.get(p)!, 0) / parents.length
        );
      };
      layer.sort((a, b) => score(a) - score(b) || (a < b ? -1 : 1));
      layer.forEach((id, i) => order.set(id, i));
    }
  }

  const positions = new Map<string, Point>();
  layers.forEach((layer, r) => {
    layer?.forEach((id, i) => {
      positions.set(id, {
        x: r * options.columnWidth,
        y: i * options.rowHeight,
      });
    });
  });

  return positions;
}

export interface NodeNeighbours {
  outgoing: GraphEdge[];
  incoming: GraphEdge[];
}

/** Every edge of the FULL graph touching a node (for the details panel). */
export function edgesOfNode(
  graph: Pick<DependencyGraph, "edges">,
  nodeId: string,
): NodeNeighbours {
  return {
    outgoing: graph.edges.filter((e) => e.source === nodeId),
    incoming: graph.edges.filter((e) => e.target === nodeId),
  };
}

export function countByType<T extends { type: string }>(
  items: readonly T[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.type] = (counts[item.type] ?? 0) + 1;
  return counts;
}

export interface EdgeStyle {
  color: string;
  dashed: boolean;
  label: string;
}

/**
 * Edge appearance. POSSIBLE resolution is always dashed so a possible call is
 * visually distinct from a confirmed one, regardless of edge type.
 */
export function edgeStyle(
  edge: Pick<GraphEdge, "type" | "resolution">,
): EdgeStyle {
  const base: Record<string, { color: string; label: string }> = {
    IMPORTS: { color: "#a8a29e", label: "Imports" },
    RE_EXPORTS: { color: "#d6d3d1", label: "Re-exports" },
    EXPORTS: { color: "#34d399", label: "Exports" },
    DECLARES: { color: "#78716c", label: "Declares" },
    CONTAINS: { color: "#78716c", label: "Contains" },
    CALLS: { color: "#60a5fa", label: "Calls" },
    POSSIBLY_CALLS: { color: "#fbbf24", label: "Possibly calls" },
    EXTENDS: { color: "#c084fc", label: "Extends" },
    IMPLEMENTS: { color: "#f472b6", label: "Implements" },
    REFERENCES: { color: "#2dd4bf", label: "References" },
  };
  const entry = base[edge.type] ?? { color: "#a8a29e", label: edge.type };
  return {
    color: entry.color,
    label: entry.label,
    dashed: edge.type === "POSSIBLY_CALLS" || edge.resolution === "POSSIBLE",
  };
}

export function nodeColor(type: string): string {
  const colors: Record<string, string> = {
    FILE: "#f97316",
    FUNCTION: "#60a5fa",
    CLASS: "#c084fc",
    METHOD: "#818cf8",
    INTERFACE: "#f472b6",
    TYPE: "#2dd4bf",
    VARIABLE: "#a3e635",
    ENUM: "#fbbf24",
  };
  return colors[type] ?? "#a8a29e";
}
