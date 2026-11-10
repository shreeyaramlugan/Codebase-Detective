// tests/unit/explorer/graph-view.test.ts
//
// Runs the explorer's graph view-model over REAL Sprint 03 graph output, so
// the node/edge shapes it relies on are the ones the engine produces.
import { describe, expect, it } from "vitest";

import type {
  DependencyGraph,
  GraphEdge,
  GraphNode,
} from "../../../features/code-intelligence/graph/graph.types";
import {
  applyGraphFilters,
  countByType,
  defaultGraphFilters,
  edgeStyle,
  edgesOfNode,
  layoutGraph,
  neighbourhood,
  type GraphFilters,
} from "../../../features/explorer/graph/graph-view";
import { graphOf } from "../../../tests/fixtures/code-intelligence/projects";

const graph: DependencyGraph = graphOf({
  "src/a.ts": `import { b, B } from "./b";
import { ext } from "external-pkg";
import { gone } from "./gone";
export class C extends B { go() { b(); this.other(); ext(); gone(); } other() {} }
export { b as reB } from "./b";`,
  "src/b.ts": `export function b() {} export class B {}`,
  "src/lonely.ts": `export const x = 1;`,
});

function filters(over: Partial<GraphFilters> = {}): GraphFilters {
  return { ...defaultGraphFilters(), ...over };
}

const all = (types: string[]) => new Set(types);

describe("applyGraphFilters", () => {
  it("defaults to a file-level import map and hides isolated files", () => {
    const view = applyGraphFilters(graph, defaultGraphFilters());
    expect(view.nodes.every((n) => n.type === "FILE")).toBe(true);
    expect(view.nodes.map((n) => n.id).sort()).toEqual([
      "file:src/a.ts",
      "file:src/b.ts",
    ]);
    expect(
      view.edges.every((e) => e.type === "IMPORTS" || e.type === "RE_EXPORTS"),
    ).toBe(true);
  });

  it("shows isolated nodes when asked", () => {
    const view = applyGraphFilters(graph, filters({ hideIsolated: false }));
    expect(view.nodes.some((n) => n.id === "file:src/lonely.ts")).toBe(true);
  });

  it("only ever returns nodes and edges that exist in the persisted graph", () => {
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    const view = applyGraphFilters(
      graph,
      filters({
        nodeTypes: all(["FILE", "CLASS", "METHOD", "FUNCTION"]),
        edgeTypes: all([
          "CALLS",
          "POSSIBLY_CALLS",
          "DECLARES",
          "IMPORTS",
          "EXTENDS",
        ]),
      }),
    );
    expect(view.edges.length).toBeGreaterThan(0);
    for (const edge of view.edges) {
      expect(edgeIds.has(edge.id)).toBe(true);
      expect(nodeIds.has(edge.source)).toBe(true);
      expect(nodeIds.has(edge.target)).toBe(true);
    }
  });

  it("keeps CALLS and POSSIBLY_CALLS separate and drawn differently", () => {
    const view = applyGraphFilters(
      graph,
      filters({
        nodeTypes: all(["FILE", "CLASS", "METHOD", "FUNCTION"]),
        edgeTypes: all(["CALLS", "POSSIBLY_CALLS"]),
      }),
    );
    const types = new Set(view.edges.map((e) => e.type));
    expect(types.has("CALLS")).toBe(true);
    const calls = view.edges.find((e) => e.type === "CALLS")!;
    expect(edgeStyle(calls).dashed).toBe(false);
    expect(
      edgeStyle({ type: "POSSIBLY_CALLS", resolution: "POSSIBLE" }).dashed,
    ).toBe(true);
    expect(edgeStyle({ type: "IMPORTS", resolution: "POSSIBLE" }).dashed).toBe(
      true,
    );
    expect(
      edgeStyle({ type: "CALLS", resolution: "CONFIRMED" }).color,
    ).not.toBe(
      edgeStyle({ type: "POSSIBLY_CALLS", resolution: "POSSIBLE" }).color,
    );
  });

  it("does not fabricate edges for unresolved or external dependencies", () => {
    const view = applyGraphFilters(
      graph,
      filters({
        nodeTypes: all(["FILE"]),
        edgeTypes: all(["IMPORTS", "RE_EXPORTS"]),
        hideIsolated: false,
      }),
    );
    const targets = view.edges.map((e) => e.target);
    expect(targets.every((t) => t.startsWith("file:src/"))).toBe(true);
    expect(targets).not.toContain("file:src/gone.ts");
    // The skipped relationships are reported by the engine, not drawn.
    expect(graph.metadata.notRepresented.unresolvedImports).toBe(1);
    expect(graph.metadata.notRepresented.externalImports).toBe(1);
  });

  it("filters by text, keeping direct neighbours", () => {
    const view = applyGraphFilters(
      graph,
      filters({ query: "lonely", hideIsolated: false }),
    );
    expect(view.nodes.map((n) => n.id)).toEqual(["file:src/lonely.ts"]);

    const b = applyGraphFilters(graph, filters({ query: "src/b" }));
    expect(b.nodes.map((n) => n.id).sort()).toEqual([
      "file:src/a.ts",
      "file:src/b.ts",
    ]);
  });

  it("focuses on a neighbourhood", () => {
    const view = applyGraphFilters(
      graph,
      filters({
        nodeTypes: all(["FILE", "CLASS", "METHOD", "FUNCTION"]),
        edgeTypes: all(["DECLARES", "IMPORTS"]),
        focusNodeId: "file:src/b.ts",
        focusDepth: 1,
        hideIsolated: false,
      }),
    );
    const ids = view.nodes.map((n) => n.id);
    expect(ids).toContain("file:src/b.ts");
    expect(ids).toContain("file:src/a.ts");
    expect(ids).not.toContain("file:src/lonely.ts");
  });

  it("returns an empty view for an empty graph", () => {
    const view = applyGraphFilters(
      { nodes: [], edges: [] },
      defaultGraphFilters(),
    );
    expect(view).toEqual({
      nodes: [],
      edges: [],
      cappedNodeCount: 0,
      truncated: false,
    });
  });

  it("caps very large graphs and reports what was dropped", () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 1000; i += 1) {
      nodes.push({
        id: `file:f${i}.ts`,
        type: "FILE",
        label: `f${i}.ts`,
        path: `f${i}.ts`,
        qualifiedName: null,
        location: null,
        exported: false,
      });
      if (i > 0) {
        edges.push({
          id: `IMPORTS|file:f${i}.ts|file:f0.ts`,
          type: "IMPORTS",
          source: `file:f${i}.ts`,
          target: "file:f0.ts",
          resolution: "RESOLVED",
          attributes: {},
          evidence: [],
          occurrences: 1,
        });
      }
    }
    const view = applyGraphFilters({ nodes, edges }, filters({ maxNodes: 50 }));
    expect(view.nodes).toHaveLength(50);
    expect(view.truncated).toBe(true);
    expect(view.cappedNodeCount).toBe(950);
    // The hub is the most connected node and must survive the cap.
    expect(view.nodes.some((n) => n.id === "file:f0.ts")).toBe(true);
    expect(
      view.edges.every((e) => view.nodes.some((n) => n.id === e.source)),
    ).toBe(true);
  });
});

describe("neighbourhood / edgesOfNode", () => {
  it("walks undirected to a depth", () => {
    const edges = graph.edges.filter((e) => e.type === "IMPORTS");
    expect([...neighbourhood(edges, "file:src/a.ts", 1)].sort()).toEqual([
      "file:src/a.ts",
      "file:src/b.ts",
    ]);
  });

  it("lists every edge of a node from the full graph", () => {
    const { outgoing, incoming } = edgesOfNode(graph, "file:src/a.ts");
    expect(outgoing.some((e) => e.type === "IMPORTS")).toBe(true);
    expect(incoming).toHaveLength(0);
  });

  it("counts edge types", () => {
    const counts = countByType(graph.edges);
    expect(counts.IMPORTS).toBe(1);
  });
});

describe("layoutGraph", () => {
  const mk = (id: string): GraphNode => ({
    id,
    type: "FILE",
    label: id,
    path: id,
    qualifiedName: null,
    location: null,
    exported: false,
  });
  const link = (a: string, b: string): GraphEdge => ({
    id: `IMPORTS|${a}|${b}`,
    type: "IMPORTS",
    source: a,
    target: b,
    resolution: "RESOLVED",
    attributes: {},
    evidence: [],
    occurrences: 1,
  });

  it("ranks dependencies to the right of their importers", () => {
    const pos = layoutGraph(
      [mk("a"), mk("b"), mk("c")],
      [link("a", "b"), link("b", "c")],
    );
    expect(pos.get("a")!.x).toBeLessThan(pos.get("b")!.x);
    expect(pos.get("b")!.x).toBeLessThan(pos.get("c")!.x);
  });

  it("terminates on cycles and self-imports and places every node once", () => {
    const nodes = [mk("a"), mk("b"), mk("c")];
    const pos = layoutGraph(nodes, [
      link("a", "b"),
      link("b", "c"),
      link("c", "a"),
      link("a", "a"),
    ]);
    expect(pos.size).toBe(3);
    const spots = new Set([...pos.values()].map((p) => `${p.x},${p.y}`));
    expect(spots.size).toBe(3);
  });

  it("is deterministic regardless of input order", () => {
    const nodes = ["a", "b", "c", "d"].map(mk);
    const edges = [link("a", "c"), link("b", "c"), link("c", "d")];
    const one = layoutGraph(nodes, edges);
    const two = layoutGraph([...nodes].reverse(), [...edges].reverse());
    expect([...one.entries()].sort()).toEqual([...two.entries()].sort());
  });

  it("lays out a large graph quickly", () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 3000; i += 1) {
      nodes.push(mk(`n${i}`));
      if (i > 0) edges.push(link(`n${i}`, `n${Math.floor(i / 2)}`));
    }
    const started = Date.now();
    const pos = layoutGraph(nodes, edges);
    expect(pos.size).toBe(3000);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
