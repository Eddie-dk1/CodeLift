import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript-compat";
import { isSupportedAsset, resolveAsset, scanCss } from "./asset-scanner.js";
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
  AnalysisProfile,
  AnalysisRequest,
  AnalysisResult,
  ExternalPackage,
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  SourceLocation,
} from "./types.js";

interface AnalyzeDependencies {
  compilerAdapter?: CompilerAdapter;
  now?: () => number;
}

interface DependencyRecord {
  specifier: string;
  kind: GraphEdgeKind;
  sourceText: string;
  location: SourceLocation;
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
      if (entries && typeof entries === "object") Object.assign(result, entries);
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

function profileFor(entrypoint: string, options: ts.CompilerOptions): AnalysisProfile {
  return entrypoint.toLowerCase().endsWith(".tsx") || options.jsx !== undefined
    ? "react-library"
    : "node-esm";
}

function profileProblems(profile: AnalysisProfile, options: ts.CompilerOptions): string[] {
  if (profile === "node-esm") {
    return options.module === ts.ModuleKind.NodeNext &&
      options.moduleResolution === ts.ModuleResolutionKind.NodeNext
      ? []
      : ["The node-esm profile requires module and moduleResolution to be NodeNext."];
  }

  const problems: string[] = [];
  const validResolution = new Set([
    ts.ModuleResolutionKind.NodeNext,
    ts.ModuleResolutionKind.Bundler,
  ]);
  const validModule = new Set([
    ts.ModuleKind.NodeNext,
    ts.ModuleKind.ESNext,
    ts.ModuleKind.Preserve,
  ]);
  const validJsx = new Set([
    ts.JsxEmit.React,
    ts.JsxEmit.ReactJSX,
    ts.JsxEmit.ReactJSXDev,
    ts.JsxEmit.Preserve,
  ]);
  if (!validResolution.has(options.moduleResolution ?? ts.ModuleResolutionKind.Classic)) {
    problems.push("The react-library profile requires NodeNext or Bundler module resolution.");
  }
  if (!validModule.has(options.module ?? ts.ModuleKind.None)) {
    problems.push("The react-library profile requires NodeNext, ESNext, or Preserve modules.");
  }
  if (!validJsx.has(options.jsx ?? ts.JsxEmit.None)) {
    problems.push("The react-library profile requires a supported React JSX mode.");
  }
  if (options.jsxImportSource && options.jsxImportSource !== "react") {
    problems.push(`Unsupported jsxImportSource: ${options.jsxImportSource}.`);
  }
  return problems;
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
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new AnalysisError(
      "PROJECT_ROOT_INVALID",
      `Project root is not a directory: ${projectRoot}`,
    );
  }

  const configPath = toRealPath(path.resolve(projectRoot, request.tsconfigPath));
  const entrypoint = toRealPath(path.resolve(projectRoot, request.entrypoint));
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
      "Entrypoint must be a .ts, .tsx, or .mts source file.",
    );
  }

  const adapter = dependencies.compilerAdapter ?? new TypeScriptCompilerAdapter();
  const project = adapter.loadProject(configPath, entrypoint);
  const profile = profileFor(entrypoint, project.compilerOptions);
  const problems = profileProblems(profile, project.compilerOptions);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const issues: AnalysisIssue[] = [];
  const issueKeys = new Set<string>();
  const externalSpecifiers = new Map<string, Set<string>>();
  const declaredRanges = loadDeclaredRanges(projectRoot);
  const queue = [entrypoint];
  const visited = new Set<string>();

  const addIssue = (issue: Omit<AnalysisIssue, "id">) => {
    const completed = makeIssue(issue);
    if (!issueKeys.has(completed.id)) {
      issueKeys.add(completed.id);
      issues.push(completed);
    }
  };

  for (const problem of problems) {
    addIssue({
      code: "CL001",
      severity: "error",
      blocking: true,
      message: problem,
      detail: "Choose a supported compiler configuration before creating an extraction plan.",
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

  const addEdge = (source: string, target: string, dependency: DependencyRecord) => {
    edges.push({
      id: edgeId(source, target, dependency.specifier, dependency.location),
      source,
      target,
      kind: dependency.kind,
      specifier: dependency.specifier,
      sourceText: dependency.sourceText,
      location: dependency.location,
    });
  };

  const addExternal = (source: string, dependency: DependencyRecord) => {
    const packageName = packageNameFromSpecifier(dependency.specifier);
    const target: GraphNode = {
      id: `package:${packageName}`,
      kind: "external-package",
      label: packageName,
      included: false,
      packageName,
    };
    nodes.set(target.id, target);
    const specifiers = externalSpecifiers.get(packageName) ?? new Set<string>();
    specifiers.add(dependency.specifier);
    externalSpecifiers.set(packageName, specifiers);
    addEdge(source, target.id, dependency);
  };

  const addUnresolvedAsset = (source: string, dependency: DependencyRecord) => {
    const target: GraphNode = {
      id: stableId("unresolved", `${dependency.location.path}:${dependency.specifier}`),
      kind: "unresolved",
      label: dependency.specifier,
      included: false,
    };
    nodes.set(target.id, target);
    addIssue({
      code: "CL010",
      severity: "error",
      blocking: true,
      message: `Asset import is unsupported or unresolved: ${dependency.specifier}`,
      location: dependency.location,
      nodeId: source,
    });
    addEdge(source, target.id, dependency);
  };

  const recordAsset = (
    source: string,
    containingFile: string,
    dependency: DependencyRecord,
  ): boolean => {
    const resolved = resolveAsset(dependency.specifier, containingFile, project.compilerOptions);
    if (resolved) {
      const real = toRealPath(resolved);
      if (!isInsideRoot(projectRoot, real)) {
        addUnresolvedAsset(source, dependency);
        addIssue({
          code: "CL004",
          severity: "error",
          blocking: true,
          message: `Asset resolves outside the project root: ${dependency.specifier}`,
          detail: real,
          location: dependency.location,
          nodeId: source,
        });
        return true;
      }
      const relative = normalizeRelativePath(projectRoot, real);
      const target: GraphNode = {
        id: `asset:${relative}`,
        kind: "local-asset",
        label: path.basename(relative),
        included: true,
        path: relative,
      };
      nodes.set(target.id, target);
      addEdge(source, target.id, {
        ...dependency,
        kind:
          dependency.kind === "style-import" || dependency.kind === "asset-reference"
            ? dependency.kind
            : "asset-import",
      });
      if (!visited.has(real)) queue.push(real);
      return true;
    }
    if (
      dependency.specifier.startsWith(".") ||
      pathAliasMatches(dependency.specifier, project.compilerOptions.paths)
    ) {
      addUnresolvedAsset(source, dependency);
      return true;
    }
    return false;
  };

  while (queue.length > 0) {
    throwIfAborted(signal);
    const current = queue.shift();
    if (!current) break;
    const currentReal = toRealPath(current);
    if (visited.has(currentReal)) continue;
    visited.add(currentReal);
    const currentRelative = normalizeRelativePath(projectRoot, currentReal);

    if (isSupportedAsset(currentReal)) {
      if (path.extname(currentReal).toLowerCase() !== ".css") continue;
      const currentNodeId = `asset:${currentRelative}`;
      const css = fs.readFileSync(currentReal, "utf8");
      for (const reference of scanCss(css, currentRelative)) {
        const dependency: DependencyRecord = reference;
        if (!recordAsset(currentNodeId, currentReal, dependency))
          addExternal(currentNodeId, dependency);
      }
      continue;
    }

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
      const dependency: DependencyRecord = imported;
      const normalizedBuiltin = imported.specifier.replace(/^node:/, "");
      if (builtins.has(normalizedBuiltin)) {
        const target: GraphNode = {
          id: `builtin:${normalizedBuiltin}`,
          kind: "node-builtin",
          label: imported.specifier,
          included: false,
          builtinName: normalizedBuiltin,
        };
        nodes.set(target.id, target);
        addEdge(currentNodeId, target.id, dependency);
        continue;
      }

      if (
        looksLikeAssetSpecifier(imported.specifier) &&
        recordAsset(currentNodeId, currentReal, dependency)
      ) {
        continue;
      }

      const resolution = adapter.resolveModule(project, imported.specifier, currentReal);
      const resolvedPath = resolution.resolvedFileName
        ? toRealPath(resolution.resolvedFileName)
        : undefined;
      const resolvesToNodeModules = resolvedPath?.split(path.sep).includes("node_modules") ?? false;

      if (resolvedPath && !resolution.isExternalLibraryImport && !resolvesToNodeModules) {
        if (!isInsideRoot(projectRoot, resolvedPath)) {
          const target: GraphNode = {
            id: stableId("outside", `${currentRelative}:${imported.specifier}`),
            kind: "unresolved",
            label: imported.specifier,
            included: false,
          };
          nodes.set(target.id, target);
          addIssue({
            code: "CL004",
            severity: "error",
            blocking: true,
            message: `Import resolves outside the project root: ${imported.specifier}`,
            detail: resolvedPath,
            location: imported.location,
            nodeId: currentNodeId,
          });
          addEdge(currentNodeId, target.id, dependency);
          continue;
        }

        const relative = normalizeRelativePath(projectRoot, resolvedPath);
        const target: GraphNode = {
          id: `file:${relative}`,
          kind: "local-file",
          label: path.basename(relative),
          included: true,
          path: relative,
        };
        nodes.set(target.id, target);
        if (!isSupportedSourceFile(resolvedPath)) {
          addIssue({
            code: "CL002",
            severity: "error",
            blocking: true,
            message: `Unsupported local file type: ${relative}`,
            location: imported.location,
            nodeId: target.id,
          });
        } else if (!visited.has(resolvedPath)) {
          queue.push(resolvedPath);
        }
        addEdge(currentNodeId, target.id, dependency);
        continue;
      }

      if (
        resolution.isExternalLibraryImport ||
        resolvesToNodeModules ||
        (!imported.specifier.startsWith(".") &&
          !pathAliasMatches(imported.specifier, project.compilerOptions.paths))
      ) {
        addExternal(currentNodeId, dependency);
        continue;
      }

      const target: GraphNode = {
        id: stableId("unresolved", `${currentRelative}:${imported.specifier}`),
        kind: "unresolved",
        label: imported.specifier,
        included: false,
      };
      nodes.set(target.id, target);
      addIssue({
        code: "CL003",
        severity: "error",
        blocking: true,
        message: `Import could not be resolved: ${imported.specifier}`,
        location: imported.location,
        nodeId: currentNodeId,
      });
      addEdge(currentNodeId, target.id, dependency);
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

  const result: AnalysisResult = {
    schemaVersion: 2,
    project: {
      root: projectRoot,
      tsconfig: normalizeRelativePath(projectRoot, configPath),
      typescriptVersion: project.typescriptVersion,
      profile,
      profileStatus: problems.length === 0 ? "supported" : "unsupported",
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
      localAssets: nodeList.filter((node) => node.kind === "local-asset" && node.included).length,
      externalPackages: externalPackages.length,
      nodeBuiltins: nodeList.filter((node) => node.kind === "node-builtin").length,
      unresolvedImports: nodeList.filter((node) => node.kind === "unresolved").length,
      issues: issues.length,
      durationMs: Math.max(0, Math.round((now() - startedAt) * 100) / 100),
    },
  };

  return result;
}
