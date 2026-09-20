export { analyzeProject } from "./analyze.js";
export type {
  CompilerAdapter,
  LoadedCompilerProject,
  ModuleResolution,
} from "./compiler-adapter.js";
export { TypeScriptCompilerAdapter } from "./compiler-adapter.js";
export { discoverProject } from "./discovery.js";
export { AnalysisError } from "./errors.js";
export { exportPackage } from "./exporter.js";
export { isInsideRoot, normalizeRelativePath, resolveExistingInsideRoot } from "./path-utils.js";
export {
  CODELIFT_TOOL_VERSION,
  createExtractionPlan,
  serializeExtractionPlan,
} from "./planning.js";
export type {
  AnalysisIssue,
  AnalysisProfile,
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
export { verifyPackage } from "./verify.js";
export type {
  DependencyClassification,
  DependencyDecision,
  ExportOptions,
  ExportResult,
  ExtractionPlan,
  PlannedFile,
  PlannedRewrite,
  PlanRequest,
  PlanStatus,
  ProjectDiscovery,
  ProjectDiscoveryRequest,
  VerificationCheck,
  VerificationRequest,
  VerificationResult,
  VerificationStatus,
} from "./workflow-types.js";
