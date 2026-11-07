// features/code-intelligence/graph/graph.types.ts
//
// Graph JSON read model.
//
// EDGE DIRECTION: an edge points FROM the entity that holds the relationship
// TO the entity it relates to:
//   IMPORTS / RE_EXPORTS   importing (or re-exporting) file  -> imported file
//   EXPORTS / DECLARES     file                              -> symbol
//   CONTAINS               parent symbol                     -> child symbol
//   CALLS / POSSIBLY_CALLS caller symbol (or file, for top-level calls) -> callee
//   EXTENDS / IMPLEMENTS   subclass / implementer            -> parent / interface
//   REFERENCES             referencing symbol (or file)      -> referenced symbol
import type { SourceLocation, SymbolKind } from "../contracts";

export type GraphNodeType = "FILE" | SymbolKind;

export type GraphEdgeType =
  | "IMPORTS"
  | "EXPORTS"
  | "DECLARES"
  | "CONTAINS"
  | "CALLS"
  | "POSSIBLY_CALLS"
  | "EXTENDS"
  | "IMPLEMENTS"
  | "REFERENCES"
  | "RE_EXPORTS";

/** RESOLVED for structural/static edges; CONFIRMED/POSSIBLE for call edges. */
export type GraphEdgeResolution = "RESOLVED" | "CONFIRMED" | "POSSIBLE";

export interface GraphNode {
  /** `file:<path>` or `sym:<symbol key>`. */
  id: string;
  type: GraphNodeType;
  label: string;
  path: string;
  qualifiedName: string | null;
  location: SourceLocation | null;
  exported: boolean;
}

export interface GraphEvidence {
  path: string;
  line: number;
  column: number;
}

export interface GraphEdge {
  /** `<TYPE>|<source id>|<target id>` - unique, so duplicates cannot exist. */
  id: string;
  type: GraphEdgeType;
  source: string;
  target: string;
  resolution: GraphEdgeResolution;
  attributes: Record<string, unknown>;
  evidence: GraphEvidence[];
  /** Total occurrences, which can exceed the evidence kept. */
  occurrences: number;
}

export interface GraphMetadata {
  analysisId: string;
  snapshotId: string;
  commitSha: string;
  snapshotCompleteness: string | null;
  engineVersion: string;
  parserVersion: string;
  schemaVersion: number;
  edgeDirection: string;
  counts: {
    nodes: number;
    edges: number;
    nodesByType: Record<string, number>;
    edgesByType: Record<string, number>;
  };
  /** Relationships that exist in relational records but have no graph edge. */
  notRepresented: {
    unresolvedImports: number;
    ambiguousImports: number;
    externalImports: number;
    importsOfNonSourceFiles: number;
    unresolvedCalls: number;
  };
}

export interface DependencyGraph {
  metadata: GraphMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphContext {
  analysisId: string;
  snapshotId: string;
  commitSha: string;
  snapshotCompleteness: string | null;
  engineVersion: string;
  parserVersion: string;
}
