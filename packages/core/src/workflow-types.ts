import type {
  AnalysisIssue,
  AnalysisProfile,
  AnalysisRequest,
  AnalysisResult,
  GraphEdgeKind,
  SourceLocation,
} from "./types.js";

export interface ProjectDiscoveryRequest {
  projectRoot?: string;
  entrypoint?: string;
}

export interface ProjectDiscovery {
  projectRoot: string;
  sourceFiles: string[];
  tsconfigs: string[];
  selectedTsconfig: string | null;
  entrypoint: string | null;
  ambiguous: boolean;
}

export type PlanStatus = "blocked" | "review" | "ready";
export type DependencyClassification = "dependencies" | "peerDependencies" | "devDependencies";

export interface PlanRequest extends AnalysisRequest {
  packageName: string;
  destination: string;
  acceptedWarningIds?: string[];
  dependencyOverrides?: Record<string, DependencyClassification>;
  copyLicense?: boolean;
}

export interface PlannedFile {
  source: string;
  destination: string;
  digest: string;
  kind: "source" | "asset";
}

export interface PlannedRewrite {
  file: string;
  destinationFile: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  location: SourceLocation;
}

export interface DependencyDecision {
  name: string;
  range: string;
  classification: DependencyClassification;
  reason: string;
}

export interface ExtractionPlan {
  schemaVersion: 1;
  toolVersion: string;
  status: PlanStatus;
  source: {
    root: string;
    tsconfig: string;
    entrypoint: string;
    sourceBase: string;
    snapshotDigest: string;
    tsconfigDigest: string;
    packageJsonDigest?: string;
    lockfile?: {
      path: string;
      digest: string;
    };
  };
  target: {
    packageName: string;
    destination: string;
    profile: AnalysisProfile;
    packageManager: "npm";
    copyLicense: boolean;
  };
  analysis: AnalysisResult;
  files: PlannedFile[];
  rewrites: PlannedRewrite[];
  dependencyDecisions: DependencyDecision[];
  issues: AnalysisIssue[];
  acceptedWarningIds: string[];
  expectedFiles: string[];
  publicEntrypoint: string;
  entrypointHasDefaultExport: boolean;
  digest: string;
}

export interface ExportOptions {
  overwrite?: false;
}

export interface ExportResult {
  schemaVersion: 1;
  status: "exported" | "cancelled";
  destination: string;
  planDigest: string;
  files: string[];
  durationMs: number;
}

export type VerificationStatus = "passed" | "failed" | "not-run" | "unsupported" | "cancelled";

export interface VerificationCheck {
  id: string;
  label: string;
  status: VerificationStatus;
  detail?: string;
  output?: string;
}

export interface VerificationRequest {
  packageRoot: string;
  install?: boolean;
  allowInstallScripts?: boolean;
}

export interface VerificationResult {
  schemaVersion: 1;
  packageRoot: string;
  status: VerificationStatus;
  checks: VerificationCheck[];
  durationMs: number;
}
