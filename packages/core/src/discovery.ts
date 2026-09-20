import fs from "node:fs";
import path from "node:path";
import ts from "typescript-compat";
import { AnalysisError } from "./errors.js";
import { isInsideRoot, normalizeRelativePath, toRealPath } from "./path-utils.js";
import type { ProjectDiscovery, ProjectDiscoveryRequest } from "./workflow-types.js";

const excludedDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

function collectProjectFiles(projectRoot: string): { sourceFiles: string[]; tsconfigs: string[] } {
  const sourceFiles: string[] = [];
  const tsconfigs: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || excludedDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = normalizeRelativePath(projectRoot, absolute);
      if (/^tsconfig(?:\.[\w-]+)?\.json$/u.test(entry.name)) tsconfigs.push(relative);
      if (
        (entry.name.endsWith(".ts") ||
          entry.name.endsWith(".tsx") ||
          entry.name.endsWith(".mts")) &&
        !entry.name.endsWith(".d.ts")
      ) {
        sourceFiles.push(relative);
      }
    }
  };
  visit(projectRoot);
  return { sourceFiles, tsconfigs };
}

function configIncludes(configPath: string, entrypoint: string): boolean {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return false;
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
    undefined,
    configPath,
  );
  const normalizedEntry = path.resolve(entrypoint);
  return parsed.fileNames.some((fileName) => path.resolve(fileName) === normalizedEntry);
}

export function discoverProject(request: ProjectDiscoveryRequest = {}): ProjectDiscovery {
  const candidateRoot = path.resolve(request.projectRoot ?? process.cwd());
  const projectRoot = toRealPath(candidateRoot);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new AnalysisError(
      "PROJECT_ROOT_INVALID",
      `Project root is not a directory: ${candidateRoot}`,
    );
  }
  const discovered = collectProjectFiles(projectRoot);
  const entrypoint = request.entrypoint
    ? toRealPath(path.resolve(projectRoot, request.entrypoint))
    : undefined;
  if (entrypoint && (!fs.existsSync(entrypoint) || !isInsideRoot(projectRoot, entrypoint))) {
    throw new AnalysisError(
      "ENTRYPOINT_INVALID",
      "Entrypoint does not exist or is outside the project root.",
    );
  }

  let candidates = discovered.tsconfigs;
  if (entrypoint) {
    candidates = candidates.filter((config) =>
      configIncludes(path.join(projectRoot, config), entrypoint),
    );
  }
  const selectedTsconfig = candidates.length === 1 ? (candidates[0] ?? null) : null;
  return {
    projectRoot,
    sourceFiles: discovered.sourceFiles,
    tsconfigs: discovered.tsconfigs,
    selectedTsconfig,
    entrypoint: entrypoint ? normalizeRelativePath(projectRoot, entrypoint) : null,
    ambiguous: candidates.length > 1,
  };
}
