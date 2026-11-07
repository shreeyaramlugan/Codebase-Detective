// features/code-intelligence/graph/validate-graph.ts
//
// Structural validation of a graph read model. A graph that fails validation
// is never persisted: the analysis run is marked FAILED with these issues.
import { ANALYSIS_LIMITS } from "../contracts";
import type { DependencyGraph, GraphEdgeType } from "./graph.types";

export interface GraphIssue {
  code: string;
  message: string;
}

const FILE_TO_FILE: ReadonlySet<GraphEdgeType> = new Set([
  "IMPORTS",
  "RE_EXPORTS",
]);
const FILE_TO_SYMBOL: ReadonlySet<GraphEdgeType> = new Set([
  "EXPORTS",
  "DECLARES",
]);
const SYMBOL_TO_SYMBOL: ReadonlySet<GraphEdgeType> = new Set([
  "CONTAINS",
  "EXTENDS",
  "IMPLEMENTS",
]);
const SELF_LOOP_ALLOWED: ReadonlySet<GraphEdgeType> = new Set([
  "CALLS",
  "POSSIBLY_CALLS",
]);

export function validateGraph(graph: DependencyGraph): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const issue = (code: string, message: string) =>
    issues.push({ code, message });

  const nodes = new Map<string, DependencyGraph["nodes"][number]>();
  const filePaths = new Set<string>();

  for (const node of graph.nodes) {
    if (nodes.has(node.id))
      issue("DUPLICATE_NODE", `Duplicate node id ${node.id}.`);
    nodes.set(node.id, node);
    if (node.type === "FILE") filePaths.add(node.path);
  }

  for (const node of graph.nodes) {
    if (node.type !== "FILE" && !filePaths.has(node.path)) {
      issue(
        "NODE_WITHOUT_FILE",
        `Symbol node ${node.id} belongs to ${node.path}, which has no file node.`,
      );
    }
  }

  const edgeIds = new Set<string>();

  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id))
      issue("DUPLICATE_EDGE", `Duplicate edge ${edge.id}.`);
    edgeIds.add(edge.id);

    if (edge.id !== `${edge.type}|${edge.source}|${edge.target}`) {
      issue(
        "EDGE_ID_MISMATCH",
        `Edge ${edge.id} does not match its type, source and target.`,
      );
    }

    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);

    if (!source)
      issue(
        "DANGLING_SOURCE",
        `Edge ${edge.id} has missing source ${edge.source}.`,
      );
    if (!target)
      issue(
        "DANGLING_TARGET",
        `Edge ${edge.id} has missing target ${edge.target}.`,
      );
    if (!source || !target) continue;

    if (edge.source === edge.target && !SELF_LOOP_ALLOWED.has(edge.type)) {
      issue(
        "SELF_LOOP",
        `Edge ${edge.id} is a self-loop, which ${edge.type} does not allow.`,
      );
    }

    const sourceIsFile = source.type === "FILE";
    const targetIsFile = target.type === "FILE";

    if (FILE_TO_FILE.has(edge.type) && !(sourceIsFile && targetIsFile)) {
      issue(
        "EDGE_TYPE_MISMATCH",
        `${edge.type} edge ${edge.id} must connect two files.`,
      );
    }
    if (FILE_TO_SYMBOL.has(edge.type) && !(sourceIsFile && !targetIsFile)) {
      issue(
        "EDGE_TYPE_MISMATCH",
        `${edge.type} edge ${edge.id} must go from a file to a symbol.`,
      );
    }
    if (SYMBOL_TO_SYMBOL.has(edge.type) && (sourceIsFile || targetIsFile)) {
      issue(
        "EDGE_TYPE_MISMATCH",
        `${edge.type} edge ${edge.id} must connect two symbols.`,
      );
    }
    if (
      (edge.type === "CALLS" ||
        edge.type === "POSSIBLY_CALLS" ||
        edge.type === "REFERENCES") &&
      targetIsFile
    ) {
      issue(
        "EDGE_TYPE_MISMATCH",
        `${edge.type} edge ${edge.id} must target a symbol.`,
      );
    }

    if (edge.type === "CALLS" && edge.resolution !== "CONFIRMED") {
      issue("RESOLUTION_MISMATCH", `CALLS edge ${edge.id} must be CONFIRMED.`);
    }
    if (edge.type === "POSSIBLY_CALLS" && edge.resolution !== "POSSIBLE") {
      issue(
        "RESOLUTION_MISMATCH",
        `POSSIBLY_CALLS edge ${edge.id} must be POSSIBLE.`,
      );
    }
    if (
      edge.type !== "CALLS" &&
      edge.type !== "POSSIBLY_CALLS" &&
      edge.resolution !== "RESOLVED"
    ) {
      issue(
        "RESOLUTION_MISMATCH",
        `${edge.type} edge ${edge.id} must be RESOLVED.`,
      );
    }

    if (edge.evidence.length > ANALYSIS_LIMITS.MAX_EVIDENCE_PER_EDGE) {
      issue(
        "EVIDENCE_LIMIT",
        `Edge ${edge.id} keeps more evidence than allowed.`,
      );
    }
    if (edge.occurrences < edge.evidence.length) {
      issue(
        "EVIDENCE_COUNT",
        `Edge ${edge.id} has fewer occurrences than evidence entries.`,
      );
    }
  }

  if (
    graph.metadata.counts.nodes !== graph.nodes.length ||
    graph.metadata.counts.edges !== graph.edges.length
  ) {
    issue(
      "COUNT_MISMATCH",
      "Graph metadata counts do not match the graph contents.",
    );
  }

  return issues;
}
