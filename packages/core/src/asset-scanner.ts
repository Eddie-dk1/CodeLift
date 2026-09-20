import fs from "node:fs";
import path from "node:path";
import type ts from "typescript-compat";
import type { GraphEdgeKind, SourceLocation } from "./types.js";

export const supportedAssetExtensions = new Set([
  ".css",
  ".json",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

export interface AssetReference {
  specifier: string;
  kind: Extract<GraphEdgeKind, "style-import" | "asset-reference">;
  sourceText: string;
  location: SourceLocation;
}

export function isSupportedAsset(fileName: string): boolean {
  return supportedAssetExtensions.has(path.extname(fileName).toLowerCase());
}

function locationAt(
  text: string,
  relativePath: string,
  start: number,
  length: number,
): SourceLocation {
  const before = text.slice(0, start);
  const lines = before.split(/\r?\n/u);
  const line = lines.length;
  const column = (lines.at(-1)?.length ?? 0) + 1;
  const matched = text.slice(start, start + length);
  const matchedLines = matched.split(/\r?\n/u);
  return {
    path: relativePath,
    line,
    column,
    endLine: line + matchedLines.length - 1,
    endColumn: matchedLines.length === 1 ? column + length : (matchedLines.at(-1)?.length ?? 0) + 1,
  };
}

function ignoredSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("data:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    specifier.startsWith("#") ||
    specifier.startsWith("var(")
  );
}

export function scanCss(text: string, relativePath: string): AssetReference[] {
  const references: AssetReference[] = [];
  const seen = new Set<string>();
  const add = (
    specifier: string,
    kind: AssetReference["kind"],
    sourceText: string,
    start: number,
  ) => {
    const clean = specifier.trim();
    if (!clean || ignoredSpecifier(clean)) return;
    const key = `${kind}:${start}:${clean}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({
      specifier: clean,
      kind,
      sourceText,
      location: locationAt(text, relativePath, start, clean.length),
    });
  };

  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?[^;]*;/giu)) {
    const sourceText = match[0];
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    add(specifier, "style-import", sourceText, match.index + sourceText.indexOf(specifier));
  }

  for (const match of text.matchAll(/composes\s*:[^;]*?\sfrom\s+["']([^"']+)["'][^;]*;/giu)) {
    const sourceText = match[0];
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    add(specifier, "style-import", sourceText, match.index + sourceText.indexOf(specifier));
  }

  for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/giu)) {
    const sourceText = match[0];
    const specifier = match[1];
    if (specifier === undefined || match.index === undefined) continue;
    add(specifier, "asset-reference", sourceText, match.index + sourceText.indexOf(specifier));
  }

  return references;
}

function aliasCandidates(specifier: string, options: ts.CompilerOptions): string[] {
  const paths = options.paths;
  const baseUrl = options.baseUrl;
  if (!paths || !baseUrl) return [];
  const candidates: string[] = [];
  for (const [pattern, replacements] of Object.entries(paths)) {
    const star = pattern.indexOf("*");
    let match = "";
    if (star === -1) {
      if (pattern !== specifier) continue;
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      match = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const replacement of replacements) {
      candidates.push(path.resolve(baseUrl, replacement.replace("*", match)));
    }
  }
  return candidates;
}

export function resolveAsset(
  specifier: string,
  containingFile: string,
  options: ts.CompilerOptions,
): string | undefined {
  if (specifier.includes("?") || specifier.includes("#")) return undefined;
  const candidates = specifier.startsWith(".")
    ? [path.resolve(path.dirname(containingFile), specifier)]
    : aliasCandidates(specifier, options);
  const matches = candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile() && isSupportedAsset(candidate);
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0] : undefined;
}
