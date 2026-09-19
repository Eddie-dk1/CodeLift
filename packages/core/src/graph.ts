import { createHash } from "node:crypto";
import type {
  AnalysisIssue,
  DependencyCycle,
  GraphEdge,
  GraphNode,
  InclusionReason,
} from "./types.js";

export function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export function computeInclusionReasons(
  entryNodeId: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): InclusionReason[] {
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }
  for (const list of outgoing.values()) list.sort((left, right) => left.id.localeCompare(right.id));

  const reasons = new Map<string, InclusionReason>();
  reasons.set(entryNodeId, { nodeId: entryNodeId, nodePath: [entryNodeId], edgePath: [] });
  const queue = [entryNodeId];

  while (queue.length > 0) {
    const source = queue.shift();
    if (!source) break;
    const sourceReason = reasons.get(source);
    if (!sourceReason) continue;
    for (const edge of outgoing.get(source) ?? []) {
      if (reasons.has(edge.target)) continue;
      reasons.set(edge.target, {
        nodeId: edge.target,
        nodePath: [...sourceReason.nodePath, edge.target],
        edgePath: [...sourceReason.edgePath, edge.id],
      });
      queue.push(edge.target);
    }
  }

  return nodes
    .map((node) => reasons.get(node.id))
    .filter((reason): reason is InclusionReason => Boolean(reason))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function computeCycles(nodes: GraphNode[], edges: GraphEdge[]): DependencyCycle[] {
  const localNodeIds = new Set(
    nodes.filter((node) => node.kind === "local-file").map((node) => node.id),
  );
  const adjacency = new Map<string, string[]>();
  for (const nodeId of localNodeIds) adjacency.set(nodeId, []);
  for (const edge of edges) {
    if (localNodeIds.has(edge.source) && localNodeIds.has(edge.target)) {
      adjacency.get(edge.source)?.push(edge.target);
    }
  }
  for (const neighbors of adjacency.values()) neighbors.sort();

  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const connect = (nodeId: string) => {
    indices.set(nodeId, index);
    lowLinks.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const target of adjacency.get(nodeId) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId) ?? 0, lowLinks.get(target) ?? 0));
      } else if (onStack.has(target)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId) ?? 0, indices.get(target) ?? 0));
      }
    }

    if (lowLinks.get(nodeId) === indices.get(nodeId)) {
      const component: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (!current) break;
        onStack.delete(current);
        component.push(current);
      } while (current !== nodeId);

      const selfLoop =
        component.length === 1 &&
        (adjacency.get(component[0] ?? "") ?? []).includes(component[0] ?? "");
      if (component.length > 1 || selfLoop) components.push(component.sort());
    }
  };

  for (const nodeId of [...localNodeIds].sort()) {
    if (!indices.has(nodeId)) connect(nodeId);
  }

  return components
    .map((nodeIds) => ({ id: stableId("cycle", nodeIds.join("|")), nodeIds }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function sortAnalysisCollections(collections: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  issues: AnalysisIssue[];
}): void {
  collections.nodes.sort((left, right) => left.id.localeCompare(right.id));
  collections.edges.sort((left, right) => left.id.localeCompare(right.id));
  collections.issues.sort((left, right) => {
    const pathCompare = (left.location?.path ?? "").localeCompare(right.location?.path ?? "");
    if (pathCompare !== 0) return pathCompare;
    const lineCompare = (left.location?.line ?? 0) - (right.location?.line ?? 0);
    if (lineCompare !== 0) return lineCompare;
    return left.code.localeCompare(right.code);
  });
}
