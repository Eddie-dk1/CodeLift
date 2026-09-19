import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript-compat";
import { type CompilerAdapter, TypeScriptCompilerAdapter } from "./compiler-adapter.js";
import { AnalysisError } from "./errors.js";
import {
  computeCycles,
  computeInclusionReasons,
  sortAnalysisCollections,
  stableId,
} from "./graph.js";
import { isInsideRoot, normalizeRelativePath, toRealPath } from "./path-utils.js";
import { isSupportedSourceFile, looksLikeAssetSpecifier, scanSourceFile } from "./scanner.js";
import type {
  AnalysisIssue,
  AnalysisRequest,
  AnalysisResult,
  ExternalPackage,
  GraphEdge,
  GraphNode,
  SourceLocation,
} from "./types.js";

interface AnalyzeDependencies {
  compilerAdapter?: CompilerAdapter;
  now?: () => number;
}

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisError("ANALYSIS_ABORTED", "Analysis was cancelled.");
}

function packageNameFromSpecifier(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function pathAliasMatches(specifier: string, paths: ts.MapLike<string[]> | undefined): boolean {
  if (!paths) return false;
  return Object.keys(paths).some((pattern) => {
    if (!pattern.includes("*")) return pattern === specifier;
    const [prefix = "", suffix = ""] = pattern.split("*");
    return specifier.startsWith(prefix) && specifier.endsWith(suffix);
  });
}

function loadDeclaredRanges(projectRoot: string): Record<string, string> {
  const packagePath = path.join(projectRoot, "package.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    const result: Record<string, string> = {};
    for (const field of [
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
      "devDependencies",
    ]) {
      const entries = manifest[field];
      if (entries && typeof entries === "object") {
        Object.assign(result, entries);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function makeIssue(input: Omit<AnalysisIssue, "id">): AnalysisIssue {
  const location = input.location;
  const identity = [
    input.code,
    location?.path ?? "",
    String(location?.line ?? 0),
    String(location?.column ?? 0),
    input.message,
  ].join(":");
  return { ...input, id: stableId("issue", identity) };
}

function edgeId(
  source: string,
  target: string,
  specifier: string,
  location: SourceLocation,
): string {
  return stableId(
    "edge",
    `${source}|${target}|${specifier}|${location.path}|${location.line}|${location.column}`,
  );
}

function isNodeNextProfile(options: ts.CompilerOptions): boolean {
  return (
    options.module === ts.ModuleKind.NodeNext &&
    options.moduleResolution === ts.ModuleResolutionKind.NodeNext
  );
}

export async function analyzeProject(
  request: AnalysisRequest,
  signal?: AbortSignal,
  dependencies: AnalyzeDependencies = {},
): Promise<AnalysisResult> {
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  throwIfAborted(signal);

  const projectRoot = toRealPath(path.resolve(request.projectRoot));
  if (!fs.statSync(projectRoot).isDirectory()) {
    throw new AnalysisError(
      "PROJECT_ROOT_INVALID",
      `Project root is not a directory: ${projectRoot}`,
    );
  }

  const configCandidate = path.resolve(projectRoot, request.tsconfigPath);
  const entryCandidate = path.resolve(projectRoot, request.entrypoint);
  const configPath = toRealPath(configCandidate);
  const entrypoint = toRealPath(entryCandidate);

  if (!isInsideRoot(projectRoot, configPath) || !isInsideRoot(projectRoot, entrypoint)) {
    throw new AnalysisError(
      "PATH_OUTSIDE_PROJECT",
      "tsconfig and entrypoint must stay inside the project root.",
    );
  }
  if (!fs.existsSync(configPath) || !fs.existsSync(entrypoint)) {
    throw new AnalysisError("PROJECT_PATH_NOT_FOUND", "tsconfig or entrypoint does not exist.");
  }
  if (!isSupportedSourceFile(entrypoint) || entrypoint.endsWith(".d.ts")) {
    throw new AnalysisError(
      "ENTRYPOINT_UNSUPPORTED",
      "Entrypoint must be a .ts or .mts source file.",
    );
  }

  const adapter = dependencies.compilerAdapter ?? new TypeScriptCompilerAdapter();
  const project = adapter.loadProject(configPath, entrypoint);
  const profileSupported = isNodeNextProfile(project.compilerOptions);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const issues: AnalysisIssue[] = [];
  const issueKeys = new Set<string>();
  const externalSpecifiers = new Map<string, Set<string>>();
  const declaredRanges = loadDeclaredRanges(projectRoot);

  const addIssue = (issue: Omit<AnalysisIssue, "id">) => {
    const completed = makeIssue(issue);
    if (!issueKeys.has(completed.id)) {
      issueKeys.add(completed.id);
      issues.push(completed);
    }
  };

  if (!profileSupported) {
    addIssue({
      code: "CL001",
      severity: "error",
      blocking: true,
      message: "The first CodeLift profile requires module and moduleResolution to be NodeNext.",
      detail: "Other TypeScript module profiles are intentionally unsupported in this release.",
    });
  }

  const entryRelative = normalizeRelativePath(projectRoot, entrypoint);
  const entryNodeId = `file:${entryRelative}`;
  nodes.set(entryNodeId, {
    id: entryNodeId,
    kind: "local-file",
    label: path.basename(entryRelative),
    included: true,
    path: entryRelative,
  });

  const queue = [entrypoint];
  const visited = new Set<string>();

  while (queue.length > 0) {
    throwIfAborted(signal);
    const current = queue.shift();
    if (!current) break;
    const currentReal = toRealPath(current);
    if (visited.has(currentReal)) continue;
    visited.add(currentReal);
    const currentRelative = normalizeRelativePath(projectRoot, currentReal);
    const currentNodeId = `file:${currentRelative}`;
    const sourceFile = adapter.getSourceFile(project, currentReal);

    if (!sourceFile) {
      addIssue({
        code: "CL012",
        severity: "error",
        blocking: true,
        message: `TypeScript did not load source file ${currentRelative}.`,
        nodeId: currentNodeId,
      });
      continue;
    }

    const scan = scanSourceFile(sourceFile, currentRelative);
    for (const issue of scan.issues) {
      addIssue({
        code: issue.code,
        severity: issue.blocking ? "error" : "warning",
        blocking: issue.blocking,
        message: issue.message,
        ...(issue.detail ? { detail: issue.detail } : {}),
        location: issue.location,
        nodeId: currentNodeId,
      });
    }

    for (const imported of scan.imports) {
      throwIfAborted(signal);
      const normalizedBuiltin = imported.specifier.replace(/^node:/, "");
      let targetNode: GraphNode;

      if (builtins.has(normalizedBuiltin)) {
        targetNode = {
          id: `builtin:${normalizedBuiltin}`,
          kind: "node-builtin",
          label: imported.specifier,
          included: false,
          builtinName: normalizedBuiltin,
        };
      } else {
        const resolution = adapter.resolveModule(project, imported.specifier, currentReal);
        const resolvedPath = resolution.resolvedFileName
          ? toRealPath(resolution.resolvedFileName)
          : undefined;
        const resolvesToNodeModules =
          resolvedPath?.split(path.sep).includes("node_modules") ?? false;

        if (resolvedPath && !resolution.isExternalLibraryImport && !resolvesToNodeModules) {
          if (!isInsideRoot(projectRoot, resolvedPath)) {
            targetNode = {
              id: stableId("outside", `${currentRelative}:${imported.specifier}`),
              kind: "unresolved",
              label: imported.specifier,
              included: false,
            };
            addIssue({
              code: "CL004",
              severity: "error",
              blocking: true,
              message: `Import resolves outside the project root: ${imported.specifier}`,
              detail: resolvedPath,
              location: imported.location,
              nodeId: currentNodeId,
            });
          } else {
            const relative = normalizeRelativePath(projectRoot, resolvedPath);
            targetNode = {
              id: `file:${relative}`,
              kind: "local-file",
              label: path.basename(relative),
              included: true,
              path: relative,
            };
            if (!isSupportedSourceFile(resolvedPath)) {
              addIssue({
                code: "CL002",
                severity: "error",
                blocking: true,
                message: `Unsupported local file type: ${relative}`,
                location: imported.location,
                nodeId: targetNode.id,
              });
            } else if (!visited.has(resolvedPath)) {
              queue.push(resolvedPath);
            }
          }
        } else if (
          resolution.isExternalLibraryImport ||
          resolvesToNodeModules ||
          (!imported.specifier.startsWith(".") &&
            !pathAliasMatches(imported.specifier, project.compilerOptions.paths))
        ) {
          const packageName = packageNameFromSpecifier(imported.specifier);
          targetNode = {
            id: `package:${packageName}`,
            kind: "external-package",
            label: packageName,
            included: false,
            packageName,
          };
          const specifiers = externalSpecifiers.get(packageName) ?? new Set<string>();
          specifiers.add(imported.specifier);
          externalSpecifiers.set(packageName, specifiers);
        } else {
          targetNode = {
            id: stableId("unresolved", `${currentRelative}:${imported.specifier}`),
            kind: "unresolved",
            label: imported.specifier,
            included: false,
          };
          const asset = looksLikeAssetSpecifier(imported.specifier);
          addIssue({
            code: asset ? "CL010" : "CL003",
            severity: "error",
            blocking: true,
            message: asset
              ? `Asset import is unsupported: ${imported.specifier}`
              : `Import could not be resolved: ${imported.specifier}`,
            location: imported.location,
            nodeId: currentNodeId,
          });
        }
      }

      nodes.set(targetNode.id, targetNode);
      edges.push({
        id: edgeId(currentNodeId, targetNode.id, imported.specifier, imported.location),
        source: currentNodeId,
        target: targetNode.id,
        kind: imported.kind,
        specifier: imported.specifier,
        sourceText: imported.sourceText,
        location: imported.location,
      });
    }
  }

  const nodeList = [...nodes.values()];
  sortAnalysisCollections({ nodes: nodeList, edges, issues });
  const cycles = computeCycles(nodeList, edges);
  const reasons = computeInclusionReasons(entryNodeId, nodeList, edges);
  const externalPackages: ExternalPackage[] = [...externalSpecifiers.entries()]
    .map(([name, specifiers]) => ({
      name,
      specifiers: [...specifiers].sort(),
      ...(declaredRanges[name] ? { declaredRange: declaredRanges[name] } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    schemaVersion: 1,
    project: {
      root: projectRoot,
      tsconfig: normalizeRelativePath(projectRoot, configPath),
      typescriptVersion: project.typescriptVersion,
      profile: "node-esm",
      profileStatus: profileSupported ? "supported" : "unsupported",
    },
    entrypoint: entryRelative,
    nodes: nodeList,
    edges,
    issues,
    cycles,
    externalPackages,
    reasons,
    stats: {
      localFiles: nodeList.filter((node) => node.kind === "local-file" && node.included).length,
      externalPackages: externalPackages.length,
      nodeBuiltins: nodeList.filter((node) => node.kind === "node-builtin").length,
      unresolvedImports: nodeList.filter((node) => node.kind === "unresolved").length,
      issues: issues.length,
      durationMs: Math.max(0, Math.round((now() - startedAt) * 100) / 100),
    },
  };
}
