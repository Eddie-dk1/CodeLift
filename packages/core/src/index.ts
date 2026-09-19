export { analyzeProject } from "./analyze.js";
export type {
  CompilerAdapter,
  LoadedCompilerProject,
  ModuleResolution,
} from "./compiler-adapter.js";
export { TypeScriptCompilerAdapter } from "./compiler-adapter.js";
export { AnalysisError } from "./errors.js";
export { isInsideRoot, normalizeRelativePath, resolveExistingInsideRoot } from "./path-utils.js";
export type {
  AnalysisIssue,
  AnalysisRequest,
  AnalysisResult,
  AnalysisStats,
  DependencyCycle,
  ExternalPackage,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  InclusionReason,
  IssueSeverity,
  SourceLocation,
} from "./types.js";
