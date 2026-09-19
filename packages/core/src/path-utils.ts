import { realpathSync } from "node:fs";
import path from "node:path";
import { AnalysisError } from "./errors.js";

export function normalizeRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join("/") || ".";
}

export function isInsideRoot(projectRoot: string, candidate: string): boolean {
  const relative = path.relative(projectRoot, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function resolveExistingInsideRoot(projectRoot: string, candidate: string): string {
  const absolute = path.resolve(projectRoot, candidate);
  let real: string;

  try {
    real = realpathSync.native(absolute);
  } catch (error) {
    throw new AnalysisError("PROJECT_PATH_NOT_FOUND", `Path does not exist: ${absolute}`, {
      cause: error,
    });
  }

  if (!isInsideRoot(projectRoot, real)) {
    throw new AnalysisError(
      "PATH_OUTSIDE_PROJECT",
      `Path resolves outside the project root: ${candidate}`,
    );
  }

  return real;
}

export function toRealPath(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}
