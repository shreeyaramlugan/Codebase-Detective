// components/explorer/GraphCanvas.tsx
//
// The only file that touches React Flow. It is loaded with next/dynamic
// (client only) from DependencyGraph.tsx.
"use client";

import "@xyflow/react/dist/style.css";

import { useEffect, useMemo } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";

import type {
  GraphEdge,
  GraphNode,
} from "@/features/code-intelligence/graph/graph.types";
import {
  edgeStyle,
  nodeColor,
  type Point,
} from "@/features/explorer/graph/graph-view";

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: Map<string, Point>;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onClear: () => void;
};

const LABEL_EDGE_LIMIT = 60;

function nodeLabel(node: GraphNode): string {
  if (node.type === "FILE") return node.path.split("/").pop() ?? node.path;
  return node.label;
}

export default function GraphCanvas({
  nodes,
  edges,
  positions,
  onSelectNode,
  onSelectEdge,
  onClear,
}: Props) {
  const flowNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: { label: nodeLabel(node) },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: "#1c1917",
          color: "#e7e5e4",
          border: `1.5px solid ${nodeColor(node.type)}`,
          borderRadius: node.type === "FILE" ? 6 : 14,
          fontSize: 12,
          padding: "6px 10px",
          width: 200,
        },
        ariaLabel: `${node.type.toLowerCase()} ${node.path}`,
      })),
    [nodes, positions],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => {
        const style = edgeStyle(edge);
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edges.length <= LABEL_EDGE_LIMIT ? style.label : undefined,
          labelStyle: { fill: "#a8a29e", fontSize: 10 },
          labelBgStyle: { fill: "#0c0a09" },
          interactionWidth: 18,
          markerEnd: { type: MarkerType.ArrowClosed, color: style.color },
          style: {
            stroke: style.color,
            strokeWidth: 1.5,
            strokeDasharray: style.dashed ? "6 4" : undefined,
          },
        };
      }),
    [edges],
  );

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(flowNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(flowEdges);

  useEffect(() => setRfNodes(flowNodes), [flowNodes, setRfNodes]);
  useEffect(() => setRfEdges(flowEdges), [flowEdges, setRfEdges]);

  // Re-fit the view whenever the visible set changes.
  const fitKey = `${nodes.length}:${edges.length}:${nodes[0]?.id ?? ""}:${nodes[nodes.length - 1]?.id ?? ""}`;

  return (
    <ReactFlow
      key={fitKey}
      nodes={rfNodes}
      edges={rfEdges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={(_event, node) => onSelectNode(node.id)}
      onEdgeClick={(_event, edge) => onSelectEdge(edge.id)}
      onPaneClick={onClear}
      nodesConnectable={false}
      elementsSelectable
      onlyRenderVisibleElements
      minZoom={0.05}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      colorMode="dark"
      proOptions={{ hideAttribution: false }}
    >
      <Background gap={20} />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        nodeColor={(node) => {
          const source = nodes.find((n) => n.id === node.id);
          return source ? nodeColor(source.type) : "#78716c";
        }}
      />
    </ReactFlow>
  );
}
