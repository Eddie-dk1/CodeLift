import type { GraphNode as AnalysisNode, AnalysisResult } from "@codelift/core";
import dagre from "@dagrejs/dagre";
import { type Edge, MarkerType, type Node } from "@xyflow/react";

export interface DependencyNodeData extends Record<string, unknown> {
  dependency: AnalysisNode;
  issueCount: number;
  isEntrypoint: boolean;
}

const nodeWidth = 196;
const nodeHeight = 64;

export function layoutGraph(result: AnalysisResult): {
  nodes: Node<DependencyNodeData>[];
  edges: Edge[];
} {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "TB", ranksep: 70, nodesep: 38, marginx: 28, marginy: 28 });

  for (const node of result.nodes) graph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  for (const edge of result.edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const nodes: Node<DependencyNodeData>[] = result.nodes.map((dependency) => {
    const point = graph.node(dependency.id) as { x: number; y: number };
    return {
      id: dependency.id,
      type: "dependency",
      position: { x: point.x - nodeWidth / 2, y: point.y - nodeHeight / 2 },
      data: {
        dependency,
        issueCount: result.issues.filter(
          (issue) => issue.nodeId === dependency.id || issue.location?.path === dependency.path,
        ).length,
        isEntrypoint: dependency.path === result.entrypoint,
      },
    };
  });

  const edges: Edge[] = result.edges.map((edge) => {
    const target = result.nodes.find((node) => node.id === edge.target);
    const unresolved = target?.kind === "unresolved";
    const typeOnly = edge.kind === "type-only";
    const color = unresolved ? "#ff5a69" : typeOnly ? "#9c7bf4" : "#35cfe5";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: edge.kind === "literal-dynamic-import" ? "dynamic" : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: {
        stroke: color,
        strokeWidth: 1.5,
        strokeDasharray: typeOnly || unresolved ? "6 5" : undefined,
      },
      labelStyle: { fill: "#9aabbc", fontSize: 10 },
      labelBgStyle: { fill: "#0d141b", fillOpacity: 0.94 },
    };
  });

  return { nodes, edges };
}
