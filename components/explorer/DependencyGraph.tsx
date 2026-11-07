// components/explorer/DependencyGraph.tsx
"use client";

import dynamic from "next/dynamic";
import { Component, useMemo, useState, type ReactNode } from "react";

import type {
  DependencyGraph as GraphModel,
  GraphEdge,
  GraphNode,
} from "@/features/code-intelligence/graph/graph.types";
import {
  ALL_EDGE_TYPES,
  ALL_NODE_TYPES,
  applyGraphFilters,
  countByType,
  defaultGraphFilters,
  edgeStyle,
  edgesOfNode,
  layoutGraph,
  type GraphFilters,
} from "@/features/explorer/graph/graph-view";
import type { ExplorerState } from "@/features/explorer/navigation/explorer-url";

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
import { useApi } from "./useApi";

const GraphCanvas = dynamic(() => import("./GraphCanvas"), {
  ssr: false,
  loading: () => <Spinner label="Loading graph renderer..." />,
});

type Props = {
  analysisId: string;
  onNavigate: (patch: Partial<ExplorerState>) => void;
};

/** Catches renderer failures so a broken graph never takes the page down. */
class GraphBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <ErrorBox message="The graph could not be rendered. Try narrowing the filters or reload the page." />
      );
    }
    return this.props.children;
  }
}

type Selection = { kind: "node" | "edge"; id: string } | null;

const MAX_NODE_CHOICES = [100, 300, 600, 1000];

function toggle(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function NodeDetails({
  graph,
  node,
  nodesById,
  onFocus,
  onNavigate,
}: {
  graph: GraphModel;
  node: GraphNode;
  nodesById: Map<string, GraphNode>;
  onFocus: (nodeId: string, edgeType?: string) => void;
  onNavigate: Props["onNavigate"];
}) {
  const { outgoing, incoming } = useMemo(
    () => edgesOfNode(graph, node.id),
    [graph, node.id],
  );
  const loc = node.location;

  const list = (
    title: string,
    edges: GraphEdge[],
    side: "source" | "target",
  ) => (
    <section>
      <h4 className="mb-1 text-xs font-semibold text-stone-400">
        {title} ({edges.length})
      </h4>
      <ul className="max-h-48 space-y-1 overflow-auto">
        {edges.slice(0, 100).map((edge) => {
          const other = nodesById.get(edge[side]);
          return (
            <li key={edge.id} className="flex items-center gap-2 text-xs">
              <Badge tone={resolutionTone(edge.resolution)}>
                {edgeStyle(edge).label.toLowerCase()}
              </Badge>
              <button
                type="button"
                onClick={() => onFocus(edge[side], edge.type)}
                className="truncate text-orange-300 hover:underline"
                title={other?.path}
              >
                {other?.qualifiedName ?? other?.label ?? edge[side]}
              </button>
            </li>
          );
        })}
      </ul>
      {edges.length > 100 && (
        <p className="mt-1 text-[11px] text-stone-600">
          Showing the first 100.
        </p>
      )}
    </section>
  );

  return (
    <div className="space-y-4 p-4 text-sm">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={node.type === "FILE" ? "accent" : kindTone(node.type)}>
            {node.type.toLowerCase()}
          </Badge>
          {node.exported && <Badge tone="good">exported</Badge>}
        </div>
        <p className="mt-2 break-all font-medium text-stone-100">
          {node.qualifiedName ?? node.label}
        </p>
        <p className="mt-1 break-all font-mono text-xs text-stone-500">
          {node.path}
          {loc ? `:${loc.startLine}` : ""}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() =>
            onNavigate({
              view: "files",
              file: node.path,
              line: loc?.startLine ?? null,
              symbol: null,
            })
          }
          className="rounded-lg border border-orange-500/30 px-3 py-1.5 text-xs font-medium text-orange-300 hover:bg-orange-500/10"
        >
          Open source
        </button>
        {node.id.startsWith("sym:") && (
          <button
            type="button"
            onClick={() =>
              onNavigate({ view: "symbols", symbol: node.id.slice(4) })
            }
            className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800"
          >
            Open in symbol explorer
          </button>
        )}
        <button
          type="button"
          onClick={() => onFocus(node.id)}
          className="rounded-lg border border-stone-700 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-800"
        >
          Focus neighbourhood
        </button>
      </div>

      {list("Outgoing", outgoing, "target")}
      {list("Incoming", incoming, "source")}
    </div>
  );
}

function EdgeDetails({
  edge,
  nodesById,
  onNavigate,
}: {
  edge: GraphEdge;
  nodesById: Map<string, GraphNode>;
  onNavigate: Props["onNavigate"];
}) {
  const style = edgeStyle(edge);
  const source = nodesById.get(edge.source);
  const target = nodesById.get(edge.target);

  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={edge.type === "POSSIBLY_CALLS" ? "warn" : "info"}>
          {style.label.toLowerCase()}
        </Badge>
        <Badge tone={resolutionTone(edge.resolution)}>
          {edge.resolution.toLowerCase()}
        </Badge>
        <Badge>
          {edge.occurrences} occurrence{edge.occurrences === 1 ? "" : "s"}
        </Badge>
      </div>
      {edge.resolution === "POSSIBLE" && (
        <p className="rounded-lg bg-amber-500/5 p-2 text-xs text-amber-300">
          This call could not be confirmed statically; it is one possible
          target.
        </p>
      )}
      <p className="text-xs text-stone-400">
        <span className="text-stone-200">
          {source?.qualifiedName ?? source?.label ?? edge.source}
        </span>
        {" → "}
        <span className="text-stone-200">
          {target?.qualifiedName ?? target?.label ?? edge.target}
        </span>
      </p>
      <section>
        <h4 className="mb-1 text-xs font-semibold text-stone-400">
          Evidence ({edge.evidence.length}
          {edge.occurrences > edge.evidence.length
            ? ` of ${edge.occurrences}`
            : ""}
          )
        </h4>
        <ul className="max-h-48 space-y-1 overflow-auto">
          {edge.evidence.map((item, index) => (
            <li key={`${item.path}:${item.line}:${index}`}>
              <button
                type="button"
                onClick={() =>
                  onNavigate({
                    view: "files",
                    file: item.path,
                    line: item.line,
                  })
                }
                className="font-mono text-xs text-orange-300 hover:underline"
              >
                {item.path}:{item.line}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export default function DependencyGraph({ analysisId, onNavigate }: Props) {
  const api = useApi<{ graph: GraphModel }>(
    `/api/analyses/${encodeURIComponent(analysisId)}/graph`,
  );
  const [filters, setFilters] = useState<GraphFilters>(defaultGraphFilters);
  const [selection, setSelection] = useState<Selection>(null);

  const graph = api.data?.graph ?? null;

  const nodesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n])),
    [graph],
  );
  const view = useMemo(
    () => (graph ? applyGraphFilters(graph, filters) : null),
    [graph, filters],
  );
  const positions = useMemo(
    () => (view ? layoutGraph(view.nodes, view.edges) : new Map()),
    [view],
  );
  const nodeCounts = useMemo(() => countByType(graph?.nodes ?? []), [graph]);
  const edgeCounts = useMemo(() => countByType(graph?.edges ?? []), [graph]);

  const focusOn = (nodeId: string, edgeType?: string) => {
    const target = nodesById.get(nodeId);
    setFilters((current) => {
      const nodeTypes = new Set(current.nodeTypes);
      const edgeTypes = new Set(current.edgeTypes);
      if (target) nodeTypes.add(target.type);
      const origin =
        selection?.kind === "node" ? nodesById.get(selection.id) : null;
      if (origin) nodeTypes.add(origin.type);
      if (edgeType) edgeTypes.add(edgeType);
      return {
        ...current,
        nodeTypes,
        edgeTypes,
        focusNodeId: nodeId,
        hideIsolated: false,
      };
    });
    setSelection({ kind: "node", id: nodeId });
  };

  if (api.loading) return <Spinner label="Loading dependency graph..." />;
  if (api.error) return <ErrorBox message={api.error} onRetry={api.reload} />;
  if (!graph || !view) return null;

  const notRepresented = graph.metadata.notRepresented;
  const selectedNode =
    selection?.kind === "node" ? nodesById.get(selection.id) : null;
  const selectedEdge =
    selection?.kind === "edge"
      ? graph.edges.find((e) => e.id === selection.id)
      : null;

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        title="This graph is empty"
        message="The analysis did not produce any files or symbols to draw."
      />
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
      <Panel title="Filters" className="min-w-0">
        <div className="space-y-5 p-4 text-xs text-stone-300">
          <div>
            <label htmlFor="graph-q" className="sr-only">
              Search graph
            </label>
            <input
              id="graph-q"
              value={filters.query}
              onChange={(e) =>
                setFilters((f) => ({ ...f, query: e.target.value }))
              }
              placeholder="Search nodes..."
              className={inputClass}
            />
          </div>

          <fieldset>
            <legend className="mb-2 font-semibold text-stone-400">
              Node types
            </legend>
            <div className="space-y-1">
              {ALL_NODE_TYPES.map((type) => (
                <label key={type} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={filters.nodeTypes.has(type)}
                    onChange={() =>
                      setFilters((f) => ({
                        ...f,
                        nodeTypes: toggle(f.nodeTypes, type),
                      }))
                    }
                  />
                  {type.toLowerCase()}
                  <span className="ml-auto text-stone-600">
                    {nodeCounts[type] ?? 0}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-2 font-semibold text-stone-400">
              Relationships
            </legend>
            <div className="space-y-1">
              {ALL_EDGE_TYPES.map((type) => {
                const style = edgeStyle({ type, resolution: "RESOLVED" });
                return (
                  <label key={type} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={filters.edgeTypes.has(type)}
                      onChange={() =>
                        setFilters((f) => ({
                          ...f,
                          edgeTypes: toggle(f.edgeTypes, type),
                        }))
                      }
                    />
                    <span
                      aria-hidden="true"
                      className="inline-block w-5 border-t-2"
                      style={{
                        borderColor: style.color,
                        borderTopStyle:
                          type === "POSSIBLY_CALLS" ? "dashed" : "solid",
                      }}
                    />
                    {style.label}
                    <span className="ml-auto text-stone-600">
                      {edgeCounts[type] ?? 0}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.hideIsolated}
              onChange={(e) =>
                setFilters((f) => ({ ...f, hideIsolated: e.target.checked }))
              }
            />
            Hide unconnected nodes
          </label>

          <div>
            <label
              htmlFor="graph-max"
              className="mb-1 block font-semibold text-stone-400"
            >
              Maximum nodes drawn
            </label>
            <select
              id="graph-max"
              value={filters.maxNodes}
              onChange={(e) =>
                setFilters((f) => ({ ...f, maxNodes: Number(e.target.value) }))
              }
              className={inputClass}
            >
              {MAX_NODE_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          {filters.focusNodeId && (
            <div className="rounded-lg border border-orange-500/30 p-3">
              <p className="mb-2 text-orange-200">
                Focused on one node's neighbourhood.
              </p>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Focus depth"
                  value={filters.focusDepth}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      focusDepth: Number(e.target.value),
                    }))
                  }
                  className={`${inputClass} !w-24`}
                >
                  <option value={1}>1 hop</option>
                  <option value={2}>2 hops</option>
                  <option value={3}>3 hops</option>
                </select>
                <button
                  type="button"
                  onClick={() =>
                    setFilters((f) => ({ ...f, focusNodeId: null }))
                  }
                  className="rounded-lg border border-stone-700 px-3 py-1.5 hover:bg-stone-800"
                >
                  Clear focus
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setFilters(defaultGraphFilters());
              setSelection(null);
            }}
            className="w-full rounded-lg border border-stone-700 px-3 py-1.5 hover:bg-stone-800"
          >
            Reset filters
          </button>
        </div>
      </Panel>

      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge>{view.nodes.length} nodes shown</Badge>
          <Badge>{view.edges.length} edges shown</Badge>
          <Badge tone="neutral">
            {graph.metadata.counts.nodes} nodes / {graph.metadata.counts.edges}{" "}
            edges in graph
          </Badge>
          {graph.metadata.snapshotCompleteness === "PARTIAL" && (
            <Badge tone="warn">partial snapshot</Badge>
          )}
        </div>

        {view.truncated && (
          <p
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300"
          >
            {view.cappedNodeCount} more matching nodes are not drawn. Showing
            the most connected nodes; narrow the filters, focus on a node or
            raise the limit to see others.
          </p>
        )}

        <p className="text-xs text-stone-500">
          Not drawn because they have no resolved target:{" "}
          {notRepresented.unresolvedImports} unresolved imports,{" "}
          {notRepresented.ambiguousImports} ambiguous imports,{" "}
          {notRepresented.externalImports} external package imports,{" "}
          {notRepresented.unresolvedCalls} unresolved calls. Dashed lines are
          possible (unconfirmed) relationships.
        </p>

        <div className="h-[600px] overflow-hidden rounded-2xl border border-stone-800 bg-stone-950">
          {view.nodes.length === 0 ? (
            <EmptyState
              title="Nothing to draw"
              message="No nodes match the current filters. Enable more node or relationship types, or reset the filters."
            />
          ) : (
            <GraphBoundary key={view.nodes.length + ":" + view.edges.length}>
              <GraphCanvas
                nodes={view.nodes}
                edges={view.edges}
                positions={positions}
                onSelectNode={(id) => setSelection({ kind: "node", id })}
                onSelectEdge={(id) => setSelection({ kind: "edge", id })}
                onClear={() => setSelection(null)}
              />
            </GraphBoundary>
          )}
        </div>
      </div>

      <Panel title="Details" className="min-w-0">
        {selectedNode ? (
          <NodeDetails
            graph={graph}
            node={selectedNode}
            nodesById={nodesById}
            onFocus={focusOn}
            onNavigate={onNavigate}
          />
        ) : selectedEdge ? (
          <EdgeDetails
            edge={selectedEdge}
            nodesById={nodesById}
            onNavigate={onNavigate}
          />
        ) : (
          <EmptyState
            title="Select a node or edge"
            message="Click an element in the graph to see its details and open its source."
          />
        )}
      </Panel>
    </div>
  );
}
