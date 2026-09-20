import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  AnalysisError,
  type AnalysisProfile,
  discoverProject,
  isInsideRoot,
  normalizeRelativePath,
} from "@codelift/core";
import ts from "typescript-compat";

export interface DoctorIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
}

export interface DoctorResult {
  schemaVersion: 1;
  status: "ready" | "attention" | "failed";
  runtime: {
    nodeVersion: string;
    nodeSupported: boolean;
    npmVersion: string | null;
  };
  project: {
    root: string;
    tsconfigs: string[];
    selectedTsconfig: string | null;
    entrypoints: string[];
    selectedEntrypoint: string | null;
    profile: AnalysisProfile | null;
  };
  issues: DoctorIssue[];
}

export interface DoctorRequest {
  projectRoot: string;
  tsconfigPath?: string;
  entrypoint?: string;
}

export interface DoctorRuntime {
  nodeVersion?: string;
  npmVersion?: () => string | null;
}

function installedNpmVersion(): string | null {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 2_000,
  });
  if (result.status !== 0) return null;
  const version = result.stdout.trim();
  return version || null;
}

function nodeIsSupported(version: string): boolean {
  const major = Number.parseInt(version.replace(/^v/u, "").split(".")[0] ?? "", 10);
  return Number.isInteger(major) && major >= 24;
}

function requireExistingProjectPath(projectRoot: string, candidate: string, label: string): string {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
  if (!fs.existsSync(absolute)) {
    throw new AnalysisError("DOCTOR_PATH_NOT_FOUND", `${label} does not exist: ${candidate}`);
  }
  const real = fs.realpathSync.native(absolute);
  if (!isInsideRoot(projectRoot, real)) {
    throw new AnalysisError("PATH_OUTSIDE_PROJECT", `${label} must stay inside the project root.`);
  }
  return normalizeRelativePath(projectRoot, real);
}

function profileFromConfig(
  projectRoot: string,
  tsconfigPath: string | null,
  entrypoint: string | null,
  issues: DoctorIssue[],
): AnalysisProfile | null {
  if (!tsconfigPath || !entrypoint) return null;
  const absoluteConfig = path.join(projectRoot, tsconfigPath);
  const config = ts.readConfigFile(absoluteConfig, ts.sys.readFile);
  if (config.error) {
    issues.push({
      code: "TSCONFIG_INVALID",
      severity: "error",
      message: ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
    });
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(absoluteConfig));
  if (parsed.errors.length > 0) {
    issues.push({
      code: "TSCONFIG_INVALID",
      severity: "error",
      message: parsed.errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        .join("\n"),
    });
    return null;
  }
  return entrypoint.endsWith(".tsx") || parsed.options.jsx !== undefined
    ? "react-library"
    : "node-esm";
}

export function diagnoseProject(request: DoctorRequest, runtime: DoctorRuntime = {}): DoctorResult {
  const nodeVersion = runtime.nodeVersion ?? process.versions.node;
  const npmVersion = (runtime.npmVersion ?? installedNpmVersion)();
  const issues: DoctorIssue[] = [];
  const nodeSupported = nodeIsSupported(nodeVersion);
  if (!nodeSupported) {
    issues.push({
      code: "NODE_UNSUPPORTED",
      severity: "error",
      message: `Node.js ${nodeVersion} is unsupported. CodeLift requires Node.js 24 or newer.`,
    });
  }
  if (!npmVersion) {
    issues.push({
      code: "NPM_NOT_FOUND",
      severity: "error",
      message:
        "npm was not found on PATH. Verification with dependency installation is unavailable.",
    });
  }

  const discovery = discoverProject({
    projectRoot: request.projectRoot,
    ...(request.entrypoint ? { entrypoint: request.entrypoint } : {}),
  });
  const selectedEntrypoint = request.entrypoint
    ? requireExistingProjectPath(discovery.projectRoot, request.entrypoint, "Entrypoint")
    : discovery.sourceFiles.length === 1
      ? (discovery.sourceFiles[0] ?? null)
      : null;
  const selectedTsconfig = request.tsconfigPath
    ? requireExistingProjectPath(discovery.projectRoot, request.tsconfigPath, "tsconfig")
    : discovery.selectedTsconfig;

  if (discovery.tsconfigs.length === 0) {
    issues.push({
      code: "TSCONFIG_NOT_FOUND",
      severity: "error",
      message: "No TypeScript configuration was found in the project.",
    });
  } else if (!selectedTsconfig) {
    issues.push({
      code: "TSCONFIG_AMBIGUOUS",
      severity: "warning",
      message: `Choose one compiler config: ${discovery.tsconfigs.join(", ")}`,
    });
  }

  if (discovery.sourceFiles.length === 0) {
    issues.push({
      code: "ENTRYPOINT_NOT_FOUND",
      severity: "error",
      message: "No supported .ts, .mts, or .tsx entrypoints were found.",
    });
  } else if (!selectedEntrypoint) {
    issues.push({
      code: "ENTRYPOINT_REQUIRED",
      severity: "warning",
      message: "Choose an entrypoint before analysis.",
    });
  }

  const profile = profileFromConfig(
    discovery.projectRoot,
    selectedTsconfig,
    selectedEntrypoint,
    issues,
  );
  const status = issues.some((issue) => issue.severity === "error")
    ? "failed"
    : issues.length > 0
      ? "attention"
      : "ready";

  return {
    schemaVersion: 1,
    status,
    runtime: { nodeVersion, nodeSupported, npmVersion },
    project: {
      root: discovery.projectRoot,
      tsconfigs: discovery.tsconfigs,
      selectedTsconfig,
      entrypoints: discovery.sourceFiles,
      selectedEntrypoint,
      profile,
    },
    issues,
  };
}

export function renderDoctorPretty(result: DoctorResult): string {
  const lines = [
    `CodeLift doctor — ${result.status}`,
    `Node.js: ${result.runtime.nodeVersion} (${result.runtime.nodeSupported ? "supported" : "unsupported"})`,
    `npm: ${result.runtime.npmVersion ?? "not found"}`,
    `Project: ${result.project.root}`,
    `Compiler config: ${result.project.selectedTsconfig ?? "not selected"}`,
    `Entrypoint: ${result.project.selectedEntrypoint ?? "not selected"}`,
    `Profile: ${result.project.profile ?? "unknown"}`,
  ];
  if (result.issues.length > 0) {
    lines.push("Issues:");
    for (const issue of result.issues) {
      lines.push(`  ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
