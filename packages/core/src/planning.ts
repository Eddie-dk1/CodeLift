import fs from "node:fs";
import path from "node:path";
import ts from "typescript-compat";
import { analyzeProject } from "./analyze.js";
import { AnalysisError } from "./errors.js";
import { stableId } from "./graph.js";
import type { AnalysisIssue, GraphNode } from "./types.js";
import type {
  DependencyClassification,
  DependencyDecision,
  ExtractionPlan,
  PlannedFile,
  PlannedRewrite,
  PlanRequest,
  PlanStatus,
} from "./workflow-types.js";
import { digestExtractionPlan, digestFile, sha256, stableJson } from "./workflow-utils.js";

export const CODELIFT_TOOL_VERSION = "0.4.0-beta.0";

function assertPackageName(packageName: string): void {
  const valid = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
  if (!valid.test(packageName) || packageName.length > 214) {
    throw new AnalysisError("PACKAGE_NAME_INVALID", `Invalid npm package name: ${packageName}`);
  }
}

function commonDirectory(paths: string[]): string {
  if (paths.length === 0) return ".";
  const directories = paths.map((fileName) => fileName.split("/").slice(0, -1));
  const first = directories[0] ?? [];
  const common: string[] = [];
  for (let index = 0; index < first.length; index += 1) {
    const segment = first[index];
    if (segment && directories.every((directory) => directory[index] === segment))
      common.push(segment);
    else break;
  }
  return common.join("/") || ".";
}

function destinationFor(source: string, sourceBase: string): string {
  const relative = sourceBase === "." ? source : path.posix.relative(sourceBase, source);
  return path.posix.join("src", relative);
}

function outputSpecifier(destination: string): string {
  if (destination.endsWith(".d.ts")) return `${destination.slice(0, -5)}.js`;
  if (destination.endsWith(".tsx") || destination.endsWith(".ts")) {
    return destination.replace(/\.tsx?$/u, ".js");
  }
  if (destination.endsWith(".mts")) return `${destination.slice(0, -4)}.mjs`;
  return destination;
}

function relativeSpecifier(
  fromFile: string,
  targetFile: string,
  targetKind: GraphNode["kind"],
): string {
  const outputTarget = targetKind === "local-file" ? outputSpecifier(targetFile) : targetFile;
  let relative = path.posix.relative(path.posix.dirname(fromFile), outputTarget);
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

function planIssue(
  code: string,
  message: string,
  blocking: boolean,
  detail?: string,
): AnalysisIssue {
  return {
    id: stableId("issue", `${code}:${message}:${detail ?? ""}`),
    code,
    severity: blocking ? "error" : "warning",
    blocking,
    message,
    ...(detail ? { detail } : {}),
  };
}

function dependencyDecisions(
  externalPackages: ExtractionPlan["analysis"]["externalPackages"],
  overrides: Record<string, DependencyClassification>,
  issues: AnalysisIssue[],
): DependencyDecision[] {
  const decisions: DependencyDecision[] = [];
  for (const dependency of externalPackages) {
    const range = dependency.declaredRange;
    if (!range) {
      issues.push(
        planIssue(
          "CLP002",
          `No declared version range was found for ${dependency.name}.`,
          true,
          "Add the dependency to the source package.json or provide a supported range.",
        ),
      );
      continue;
    }
    if (/^(?:workspace:|link:|file:)/u.test(range)) {
      issues.push(
        planIssue(
          "CLP003",
          `Dependency ${dependency.name} uses an unsupported local range: ${range}`,
          true,
        ),
      );
      continue;
    }
    if (
      range.includes("||") ||
      range.includes("/") ||
      /^[a-z][a-z+.-]*:/iu.test(range.trim()) ||
      /^(?:\*|alpha|beta|latest|next)$/iu.test(range.trim()) ||
      !/[0-9]/u.test(range)
    ) {
      issues.push(
        planIssue(
          "CLP004",
          `Dependency ${dependency.name} uses an ambiguous or unsupported range: ${range}`,
          true,
          "Choose an explicit semver range before exporting the package.",
        ),
      );
      continue;
    }
    if (dependency.name === "react" || dependency.name === "react-dom") {
      decisions.push({
        name: dependency.name,
        range,
        classification: "peerDependencies",
        reason: "React runtimes are provided by the consuming application.",
      });
      decisions.push({
        name: dependency.name,
        range,
        classification: "devDependencies",
        reason: "React is required to build and verify the extracted package.",
      });
      continue;
    }
    decisions.push({
      name: dependency.name,
      range,
      classification: overrides[dependency.name] ?? "dependencies",
      reason: "Imported by an included source file.",
    });
  }
  return decisions.sort((left, right) =>
    `${left.classification}:${left.name}`.localeCompare(`${right.classification}:${right.name}`),
  );
}

function hasDefaultExport(fileName: string): boolean {
  const source = fs.readFileSync(fileName, "utf8");
  const kind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".mts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  return sourceFile.statements.some((statement) => {
    if (ts.isExportAssignment(statement)) return true;
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    return Boolean(
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) &&
        modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword),
    );
  });
}

export async function createExtractionPlan(
  request: PlanRequest,
  signal?: AbortSignal,
): Promise<ExtractionPlan> {
  assertPackageName(request.packageName);
  if (!request.destination.trim()) {
    throw new AnalysisError("DESTINATION_REQUIRED", "A destination directory is required.");
  }
  const analysis = await analyzeProject(request, signal);
  const deterministicAnalysis = {
    ...analysis,
    stats: { ...analysis.stats, durationMs: 0 },
  };
  const localNodes = analysis.nodes.filter(
    (node) => (node.kind === "local-file" || node.kind === "local-asset") && node.path,
  );
  const sourcePaths = localNodes.map((node) => node.path as string).sort();
  const sourceBase = commonDirectory(sourcePaths);
  const files: PlannedFile[] = localNodes
    .map<PlannedFile>((node) => ({
      source: node.path as string,
      destination: destinationFor(node.path as string, sourceBase),
      digest: digestFile(path.join(analysis.project.root, node.path as string)),
      kind: node.kind === "local-asset" ? "asset" : "source",
    }))
    .sort((left, right) => left.source.localeCompare(right.source));
  const destinationBySource = new Map(files.map((file) => [file.source, file.destination]));
  const nodeById = new Map(analysis.nodes.map((node) => [node.id, node]));
  const rewrites: PlannedRewrite[] = [];

  for (const edge of analysis.edges) {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    if (!sourceNode?.path || !targetNode?.path) continue;
    if (targetNode.kind !== "local-file" && targetNode.kind !== "local-asset") continue;
    const sourceDestination = destinationBySource.get(sourceNode.path);
    const targetDestination = destinationBySource.get(targetNode.path);
    if (!sourceDestination || !targetDestination) continue;
    const rewritten = relativeSpecifier(sourceDestination, targetDestination, targetNode.kind);
    if (rewritten === edge.specifier) continue;
    rewrites.push({
      file: sourceNode.path,
      destinationFile: sourceDestination,
      from: edge.specifier,
      to: rewritten,
      kind: edge.kind,
      location: edge.location,
    });
  }
  rewrites.sort((left, right) =>
    `${left.file}:${left.location.line}:${left.location.column}`.localeCompare(
      `${right.file}:${right.location.line}:${right.location.column}`,
    ),
  );

  const tsconfigPath = path.join(analysis.project.root, analysis.project.tsconfig);
  const packageJsonPath = path.join(analysis.project.root, "package.json");
  const tsconfigDigest = digestFile(tsconfigPath);
  const packageJsonDigest = fs.existsSync(packageJsonPath)
    ? digestFile(packageJsonPath)
    : undefined;
  const lockfilePath = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]
    .map((candidate) => path.join(analysis.project.root, candidate))
    .find((candidate) => fs.existsSync(candidate));
  const lockfile = lockfilePath
    ? { path: path.basename(lockfilePath), digest: digestFile(lockfilePath) }
    : undefined;
  const snapshotDigest = sha256(
    stableJson({
      files: files.map(({ source, digest }) => ({ source, digest })),
      tsconfig: tsconfigDigest,
      packageJson: packageJsonDigest ?? null,
      lockfile: lockfile ?? null,
    }),
  );
  const issues = [...analysis.issues];
  const planningPackages = [...analysis.externalPackages];
  if (analysis.project.profile === "react-library" && fs.existsSync(packageJsonPath)) {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const name of ["react", "react-dom"]) {
      if (planningPackages.some((dependency) => dependency.name === name)) continue;
      const range =
        manifest.dependencies?.[name] ??
        manifest.peerDependencies?.[name] ??
        manifest.devDependencies?.[name];
      if (range) {
        planningPackages.push({
          name,
          specifiers: [name === "react" ? "react/jsx-runtime" : name],
          declaredRange: range,
        });
      }
    }
  }
  const decisions = dependencyDecisions(
    planningPackages,
    request.dependencyOverrides ?? {},
    issues,
  );
  const acceptedWarningIds = [...new Set(request.acceptedWarningIds ?? [])].sort();
  const unacceptedWarnings = issues.filter(
    (issue) => !issue.blocking && !acceptedWarningIds.includes(issue.id),
  );
  const status: PlanStatus = issues.some((issue) => issue.blocking)
    ? "blocked"
    : unacceptedWarnings.length > 0
      ? "review"
      : "ready";
  const entrypointDestination = destinationBySource.get(analysis.entrypoint);
  if (!entrypointDestination) {
    throw new AnalysisError("PLAN_ENTRYPOINT_MISSING", "Entrypoint is missing from the file plan.");
  }
  const publicEntrypoint = "src/index.ts";
  const generatedFiles = [
    ".gitignore",
    "README.md",
    "codelift-report.json",
    "package.json",
    "tsconfig.build.json",
    "tsconfig.json",
    ...(analysis.project.profile === "react-library" ? ["vite.config.ts"] : []),
    ...(entrypointDestination === publicEntrypoint ? [] : [publicEntrypoint]),
  ];
  if (request.copyLicense && fs.existsSync(path.join(analysis.project.root, "LICENSE"))) {
    generatedFiles.push("LICENSE");
  }

  const planWithoutDigest = {
    schemaVersion: 1 as const,
    toolVersion: CODELIFT_TOOL_VERSION,
    status,
    source: {
      root: analysis.project.root,
      tsconfig: analysis.project.tsconfig,
      entrypoint: analysis.entrypoint,
      sourceBase,
      snapshotDigest,
      tsconfigDigest,
      ...(packageJsonDigest ? { packageJsonDigest } : {}),
      ...(lockfile ? { lockfile } : {}),
    },
    target: {
      packageName: request.packageName,
      destination: path.resolve(analysis.project.root, request.destination),
      profile: analysis.project.profile,
      packageManager: "npm" as const,
      copyLicense: request.copyLicense ?? false,
    },
    analysis: deterministicAnalysis,
    files,
    rewrites,
    dependencyDecisions: decisions,
    issues: issues.sort((left, right) => left.id.localeCompare(right.id)),
    acceptedWarningIds,
    expectedFiles: [...files.map((file) => file.destination), ...generatedFiles].sort(),
    publicEntrypoint,
    entrypointHasDefaultExport: hasDefaultExport(
      path.join(analysis.project.root, analysis.entrypoint),
    ),
  };
  return {
    ...planWithoutDigest,
    digest: digestExtractionPlan(planWithoutDigest),
  };
}

export function serializeExtractionPlan(plan: ExtractionPlan): string {
  return stableJson(plan);
}
