export type GraphNodeKind = "local-file" | "external-package" | "node-builtin" | "unresolved";

export type GraphEdgeKind = "static-import" | "re-export" | "type-only" | "literal-dynamic-import";

export type IssueSeverity = "warning" | "error";

export interface AnalysisRequest {
  projectRoot: string;
  tsconfigPath: string;
  entrypoint: string;
}

export interface SourceLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  included: boolean;
  path?: string;
  packageName?: string;
  builtinName?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeKind;
  specifier: string;
  sourceText: string;
  location: SourceLocation;
}

export interface AnalysisIssue {
  id: string;
  code: string;
  severity: IssueSeverity;
  blocking: boolean;
  message: string;
  detail?: string;
  location?: SourceLocation;
  nodeId?: string;
}

export interface DependencyCycle {
  id: string;
  nodeIds: string[];
}

export interface ExternalPackage {
  name: string;
  specifiers: string[];
  declaredRange?: string;
}

export interface InclusionReason {
  nodeId: string;
  nodePath: string[];
  edgePath: string[];
}

export interface AnalysisStats {
  localFiles: number;
  externalPackages: number;
  nodeBuiltins: number;
  unresolvedImports: number;
  issues: number;
  durationMs: number;
}

export interface AnalysisResult {
  schemaVersion: 1;
  project: {
    root: string;
    tsconfig: string;
    typescriptVersion: string;
    profile: "node-esm";
    profileStatus: "supported" | "unsupported";
  };
  entrypoint: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  issues: AnalysisIssue[];
  cycles: DependencyCycle[];
  externalPackages: ExternalPackage[];
  reasons: InclusionReason[];
  stats: AnalysisStats;
}
