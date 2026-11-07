// features/code-intelligence/graph/build-graph.ts
//
// Builds the graph read model from relational analysis records. The same
// function runs at analysis time and when the graph is regenerated from the
// database, so both always agree. Output is fully sorted and contains no
// clock values, making it deterministic for identical inputs.
//
// Unresolved, ambiguous and external relationships are deliberately NOT turned
// into edges (that would require inventing a target); they remain in the
// relational records and are counted in `metadata.notRepresented`.
import {
  ANALYSIS_LIMITS,
  type AnalysisRecords,
  type SymbolRecord,
} from "../contracts";
import { GRAPH_SCHEMA_VERSION } from "../contracts";
import type {
  DependencyGraph,
  GraphContext,
  GraphEdge,
  GraphEdgeResolution,
  GraphEdgeType,
  GraphEvidence,
  GraphNode,
} from "./graph.types";

export const fileNodeId = (path: string) => `file:${path}`;
export const symbolNodeId = (key: string) => `sym:${key}`;

class EdgeAccumulator {
  private readonly edges = new Map<string, GraphEdge>();

  add(input: {
    type: GraphEdgeType;
    source: string;
    target: string;
    resolution: GraphEdgeResolution;
    evidence?: GraphEvidence;
    attributes?: Record<string, unknown>;
    merge?: (
      existing: Record<string, unknown>,
      incoming: Record<string, unknown>,
    ) => void;
  }) {
    const id = `${input.type}|${input.source}|${input.target}`;
    const existing = this.edges.get(id);

    if (!existing) {
      this.edges.set(id, {
        id,
        type: input.type,
        source: input.source,
        target: input.target,
        resolution: input.resolution,
        attributes: { ...(input.attributes ?? {}) },
        evidence: input.evidence ? [input.evidence] : [],
        occurrences: input.evidence ? 1 : 0,
      });
      return;
    }

    if (input.evidence) {
      existing.occurrences += 1;
      existing.evidence.push(input.evidence);
    }
    if (input.merge) input.merge(existing.attributes, input.attributes ?? {});
  }

  values(): GraphEdge[] {
    return [...this.edges.values()];
  }
}

function compareEvidence(a: GraphEvidence, b: GraphEvidence) {
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column;
}

function unionSorted(existing: unknown, incoming: unknown): string[] {
  return [
    ...new Set([
      ...((existing as string[] | undefined) ?? []),
      ...((incoming as string[] | undefined) ?? []),
    ]),
  ].sort();
}

export function buildGraph(
  records: AnalysisRecords,
  context: GraphContext,
): DependencyGraph {
  const nodes: GraphNode[] = [];
  const edges = new EdgeAccumulator();
  const symbolByKey = new Map<string, SymbolRecord>();

  for (const file of records.files) {
    if (file.status !== "ANALYSED" && file.status !== "ANALYSED_WITH_ERRORS")
      continue;

    nodes.push({
      id: fileNodeId(file.path),
      type: "FILE",
      label: file.path.slice(file.path.lastIndexOf("/") + 1),
      path: file.path,
      qualifiedName: null,
      location: null,
      exported: false,
    });
  }

  for (const symbol of records.symbols) {
    symbolByKey.set(symbol.key, symbol);

    nodes.push({
      id: symbolNodeId(symbol.key),
      type: symbol.kind,
      label: symbol.name,
      path: symbol.filePath,
      qualifiedName: symbol.qualifiedName,
      location: symbol.location,
      exported: symbol.isExported,
    });

    const location = {
      path: symbol.filePath,
      line: symbol.location.startLine,
      column: symbol.location.startColumn,
    };

    if (symbol.parentKey === null) {
      edges.add({
        type: "DECLARES",
        source: fileNodeId(symbol.filePath),
        target: symbolNodeId(symbol.key),
        resolution: "RESOLVED",
        evidence: location,
      });
    } else {
      edges.add({
        type: "CONTAINS",
        source: symbolNodeId(symbol.parentKey),
        target: symbolNodeId(symbol.key),
        resolution: "RESOLVED",
        evidence: location,
      });
    }

    if (symbol.isExported && symbol.parentKey === null) {
      edges.add({
        type: "EXPORTS",
        source: fileNodeId(symbol.filePath),
        target: symbolNodeId(symbol.key),
        resolution: "RESOLVED",
        evidence: location,
        attributes: { names: symbol.exportNames },
      });
    }
  }

  const notRepresented = {
    unresolvedImports: 0,
    ambiguousImports: 0,
    externalImports: 0,
    importsOfNonSourceFiles: 0,
    unresolvedCalls: 0,
  };

  for (const dep of records.dependencies) {
    if (dep.status === "UNRESOLVED") notRepresented.unresolvedImports += 1;
    else if (dep.status === "AMBIGUOUS") notRepresented.ambiguousImports += 1;
    else if (dep.status === "EXTERNAL") notRepresented.externalImports += 1;
    else if (!dep.targetAnalysed || !dep.targetPath)
      notRepresented.importsOfNonSourceFiles += 1;

    if (dep.status !== "RESOLVED" || !dep.targetAnalysed || !dep.targetPath)
      continue;
    if (dep.targetPath === dep.sourcePath) continue;

    const isReExport = dep.kind === "RE_EXPORT" || dep.kind === "EXPORT_ALL";

    edges.add({
      type: isReExport ? "RE_EXPORTS" : "IMPORTS",
      source: fileNodeId(dep.sourcePath),
      target: fileNodeId(dep.targetPath),
      resolution: "RESOLVED",
      evidence: {
        path: dep.sourcePath,
        line: dep.location.startLine,
        column: dep.location.startColumn,
      },
      attributes: isReExport
        ? {
            typeOnly: dep.isTypeOnly,
            exportsAll: dep.kind === "EXPORT_ALL",
            names: dep.bindings
              .map((binding) => binding.local)
              .filter((name): name is string => name !== null)
              .sort(),
          }
        : { typeOnly: dep.isTypeOnly, kinds: [dep.kind] },
      merge: (existing, incoming) => {
        // An edge is type-only only if every contributing statement is.
        existing.typeOnly =
          Boolean(existing.typeOnly) && Boolean(incoming.typeOnly);
        if (isReExport) {
          existing.exportsAll =
            Boolean(existing.exportsAll) || Boolean(incoming.exportsAll);
          existing.names = unionSorted(existing.names, incoming.names);
        } else {
          existing.kinds = unionSorted(existing.kinds, incoming.kinds);
        }
      },
    });
  }

  for (const call of records.calls) {
    if (call.resolution === "UNRESOLVED" || !call.targetKey) {
      notRepresented.unresolvedCalls += 1;
      continue;
    }

    edges.add({
      type: call.resolution === "CONFIRMED" ? "CALLS" : "POSSIBLY_CALLS",
      source: call.callerKey
        ? symbolNodeId(call.callerKey)
        : fileNodeId(call.sourcePath),
      target: symbolNodeId(call.targetKey),
      resolution: call.resolution,
      evidence: {
        path: call.sourcePath,
        line: call.location.startLine,
        column: call.location.startColumn,
      },
      attributes: { callKinds: [call.kind] },
      merge: (existing, incoming) => {
        existing.callKinds = unionSorted(
          existing.callKinds,
          incoming.callKinds,
        );
      },
    });
  }

  for (const relation of records.relations) {
    if (relation.status !== "RESOLVED" || !relation.targetKey) continue;

    edges.add({
      type: relation.kind,
      source: relation.sourceKey
        ? symbolNodeId(relation.sourceKey)
        : fileNodeId(relation.sourcePath),
      target: symbolNodeId(relation.targetKey),
      resolution: "RESOLVED",
      evidence: {
        path: relation.sourcePath,
        line: relation.location.startLine,
        column: relation.location.startColumn,
      },
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));

  const edgeList = edges.values().sort((a, b) => a.id.localeCompare(b.id));
  for (const edge of edgeList) {
    edge.evidence.sort(compareEvidence);
    if (edge.evidence.length > ANALYSIS_LIMITS.MAX_EVIDENCE_PER_EDGE) {
      edge.evidence.length = ANALYSIS_LIMITS.MAX_EVIDENCE_PER_EDGE;
    }
  }

  const count = <T extends string>(items: readonly { type: T }[]) => {
    const result: Record<string, number> = {};
    for (const item of items) result[item.type] = (result[item.type] ?? 0) + 1;
    return Object.fromEntries(
      Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
    );
  };

  return {
    metadata: {
      analysisId: context.analysisId,
      snapshotId: context.snapshotId,
      commitSha: context.commitSha,
      snapshotCompleteness: context.snapshotCompleteness,
      engineVersion: context.engineVersion,
      parserVersion: context.parserVersion,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      edgeDirection:
        "Edges point from the entity that holds the relationship to the entity it relates to.",
      counts: {
        nodes: nodes.length,
        edges: edgeList.length,
        nodesByType: count(nodes),
        edgesByType: count(edgeList),
      },
      notRepresented,
    },
    nodes,
    edges: edgeList,
  };
}
