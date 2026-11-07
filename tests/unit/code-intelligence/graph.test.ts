// tests/unit/code-intelligence/graph.test.ts
import { describe, expect, it } from "vitest";

import { buildGraph } from "@/features/code-intelligence/graph/build-graph";
import type { DependencyGraph } from "@/features/code-intelligence/graph/graph.types";
import { validateGraph } from "@/features/code-intelligence/graph/validate-graph";
import {
  analyze,
  fixtures,
  graphOf,
  type Project,
} from "../../fixtures/code-intelligence/projects";

const project: Project = {
  "src/a.ts": `import { b, B } from "./b";
import { ext } from "external-pkg";
import { gone } from "./gone";
export class C extends B { go() { b(); this.other(); ext(); gone(); } other() {} }
export { b as reB } from "./b";`,
  "src/b.ts": `export function b() {} export class B {}`,
};

const edgesOf = (graph: DependencyGraph, type: string) =>
  graph.edges.filter((e) => e.type === type);

describe("graph construction", () => {
  const graph = graphOf(project);

  it("is valid", () => {
    expect(validateGraph(graph)).toEqual([]);
  });

  it("builds file and symbol nodes", () => {
    const types = graph.nodes.map((n) => n.type);
    expect(types.filter((t) => t === "FILE")).toHaveLength(2);
    expect(types).toContain("CLASS");
    expect(types).toContain("METHOD");
    expect(types).toContain("FUNCTION");
  });

  it("builds the documented edge types with consistent direction", () => {
    const imports = edgesOf(graph, "IMPORTS");
    expect(imports.map((e) => [e.source, e.target])).toEqual([
      ["file:src/a.ts", "file:src/b.ts"],
    ]);
    expect(edgesOf(graph, "RE_EXPORTS")).toHaveLength(1);
    expect(
      edgesOf(graph, "DECLARES").every(
        (e) => e.source.startsWith("file:") && e.target.startsWith("sym:"),
      ),
    ).toBe(true);
    expect(
      edgesOf(graph, "CONTAINS").every((e) => e.source.startsWith("sym:")),
    ).toBe(true);
    expect(edgesOf(graph, "EXPORTS").length).toBeGreaterThan(0);
    expect(edgesOf(graph, "EXTENDS")).toHaveLength(1);
  });

  it("distinguishes CALLS from POSSIBLY_CALLS", () => {
    expect(edgesOf(graph, "CALLS")).toHaveLength(1);
    expect(edgesOf(graph, "CALLS")[0].resolution).toBe("CONFIRMED");
    expect(edgesOf(graph, "POSSIBLY_CALLS")).toHaveLength(1);
    expect(edgesOf(graph, "POSSIBLY_CALLS")[0].resolution).toBe("POSSIBLE");
  });

  it("does not fabricate edges for unresolved, ambiguous or external relationships", () => {
    expect(
      graph.edges.every((e) => graph.nodes.some((n) => n.id === e.target)),
    ).toBe(true);
    expect(graph.metadata.notRepresented).toMatchObject({
      unresolvedImports: 1,
      externalImports: 1,
      unresolvedCalls: 2,
    });
  });

  it("merges repeated relationships into one edge and keeps evidence", () => {
    const g = graphOf({
      "a.ts": `import { f } from "./b"; import { h } from "./b"; f(); f(); f();`,
      "b.ts": `export function f() {} export function h() {}`,
    });
    expect(edgesOf(g, "IMPORTS")).toHaveLength(1);
    const call = edgesOf(g, "CALLS")[0];
    expect(call.occurrences).toBe(3);
    expect(call.evidence).toHaveLength(3);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });

  it("marks an import edge type-only only when every statement is", () => {
    const g = graphOf({
      "a.ts": `import type { T } from "./b"; import { v } from "./b";`,
      "b.ts": `export type T = 1; export const v = 1;`,
    });
    expect(edgesOf(g, "IMPORTS")[0].attributes.typeOnly).toBe(false);
    const only = graphOf({
      "a.ts": `import type { T } from "./b";`,
      "b.ts": `export type T = 1;`,
    });
    expect(edgesOf(only, "IMPORTS")[0].attributes.typeOnly).toBe(true);
  });

  it("keeps both edges of circular imports", () => {
    const g = graphOf(fixtures.circular);
    expect(edgesOf(g, "IMPORTS")).toHaveLength(2);
  });

  it("allows recursion as a CALLS self-loop but nothing else", () => {
    const g = graphOf({ "a.ts": `export function f() { f(); }` });
    expect(edgesOf(g, "CALLS")[0].source).toBe(edgesOf(g, "CALLS")[0].target);
    expect(validateGraph(g)).toEqual([]);
  });

  it("is deterministic and regeneratable from the same records", () => {
    const first = JSON.stringify(graphOf(fixtures.reexports));
    const second = JSON.stringify(graphOf(fixtures.reexports));
    expect(first).toBe(second);

    const { records } = analyze(fixtures.reexports);
    const context = {
      analysisId: "analysis-1",
      snapshotId: "snapshot-1",
      commitSha: "abc123",
      snapshotCompleteness: "COMPLETE",
      engineVersion: "test",
      parserVersion: "test",
    };
    // Input order must not matter: rebuilding from shuffled records matches.
    const shuffled = {
      ...records,
      symbols: [...records.symbols].reverse(),
      dependencies: [...records.dependencies].reverse(),
      calls: [...records.calls].reverse(),
      relations: [...records.relations].reverse(),
      files: [...records.files].reverse(),
    };
    expect(JSON.stringify(buildGraph(shuffled, context))).toBe(
      JSON.stringify(buildGraph(records, context)),
    );
  });
});

describe("graph validation", () => {
  const valid = () => structuredClone(graphOf(project));

  it("detects dangling edges", () => {
    const graph = valid();
    const edge = graph.edges[0];
    edge.target = "sym:missing";
    edge.id = `${edge.type}|${edge.source}|${edge.target}`;
    expect(validateGraph(graph).map((i) => i.code)).toContain(
      "DANGLING_TARGET",
    );
  });

  it("detects duplicate nodes and edges", () => {
    const graph = valid();
    graph.nodes.push(graph.nodes[0]);
    graph.edges.push(graph.edges[0]);
    const codes = validateGraph(graph).map((i) => i.code);
    expect(codes).toContain("DUPLICATE_NODE");
    expect(codes).toContain("DUPLICATE_EDGE");
  });

  it("detects edges whose id does not match their endpoints", () => {
    const graph = valid();
    graph.edges[0].id = "bogus";
    expect(validateGraph(graph).map((i) => i.code)).toContain(
      "EDGE_ID_MISMATCH",
    );
  });

  it("detects wrong node types for an edge", () => {
    const graph = valid();
    const edge = graph.edges.find((e) => e.type === "IMPORTS")!;
    const symbol = graph.nodes.find((n) => n.type !== "FILE")!;
    edge.target = symbol.id;
    edge.id = `${edge.type}|${edge.source}|${edge.target}`;
    expect(validateGraph(graph).map((i) => i.code)).toContain(
      "EDGE_TYPE_MISMATCH",
    );
  });

  it("detects a CALLS edge that is not confirmed", () => {
    const graph = valid();
    edgesOf(graph, "CALLS")[0].resolution = "POSSIBLE";
    expect(validateGraph(graph).map((i) => i.code)).toContain(
      "RESOLUTION_MISMATCH",
    );
  });

  it("detects self-loops on non-call edges", () => {
    const graph = valid();
    const edge = edgesOf(graph, "IMPORTS")[0];
    edge.target = edge.source;
    edge.id = `${edge.type}|${edge.source}|${edge.target}`;
    expect(validateGraph(graph).map((i) => i.code)).toContain("SELF_LOOP");
  });

  it("detects symbols without a file node and count mismatches", () => {
    const graph = valid();
    graph.nodes = graph.nodes.filter((n) => n.id !== "file:src/b.ts");
    const codes = validateGraph(graph).map((i) => i.code);
    expect(codes).toContain("NODE_WITHOUT_FILE");
    expect(codes).toContain("COUNT_MISMATCH");
  });
});
