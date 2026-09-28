import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import valueParser from "postcss-value-parser";
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
  const add = (
    specifier: string,
    kind: AssetReference["kind"],
    sourceText: string,
    start: number,
  ) => {
    const clean = specifier.trim();
    if (!clean || ignoredSpecifier(clean)) return;
    references.push({
      specifier: clean,
      kind,
      sourceText,
      location: locationAt(text, relativePath, start, clean.length),
    });
  };

  const root = postcss.parse(text, { from: relativePath });
  const startOffset = (line: number, column: number) => {
    let offset = 0;
    for (let index = 0; index < line - 1; index += 1) {
      const next = text.indexOf("\n", offset);
      if (next < 0) break;
      offset = next + 1;
    }
    return offset + column - 1;
  };
  const addValue = (
    value: string,
    sourceText: string,
    base: number,
    kind: AssetReference["kind"],
  ) => {
    const parsed = valueParser(value);
    parsed.walk((node) => {
      if (node.type === "function" && node.value.toLowerCase() === "url") {
        const inner = node.nodes.find((part) => part.type === "string" || part.type === "word");
        if (inner)
          add(
            inner.value,
            kind,
            sourceText,
            base + inner.sourceIndex + (inner.type === "string" ? 1 : 0),
          );
        return false;
      }
      return undefined;
    });
  };
  root.walkAtRules("import", (rule) => {
    if (!rule.source?.start) return;
    const sourceText = rule.toString();
    const offset = startOffset(rule.source.start.line, rule.source.start.column);
    const paramsStart = sourceText.indexOf(rule.params);
    const parsed = valueParser(rule.params);
    const first = parsed.nodes.find((node) => node.type === "string" || node.type === "function");
    if (first?.type === "string")
      add(first.value, "style-import", sourceText, offset + paramsStart + first.sourceIndex + 1);
    else if (first?.type === "function" && first.value.toLowerCase() === "url") {
      addValue(rule.params, sourceText, offset + paramsStart, "style-import");
    }
  });
  root.walkDecls((declaration) => {
    if (!declaration.source?.start) return;
    const sourceText = declaration.toString();
    const offset = startOffset(declaration.source.start.line, declaration.source.start.column);
    const valueStart = sourceText.indexOf(declaration.value, declaration.prop.length);
    if (valueStart < 0) return;
    const valueOffset = offset + valueStart;
    if (declaration.prop.toLowerCase() === "composes") {
      const parsed = valueParser(declaration.value);
      const fromIndex = parsed.nodes.findIndex(
        (node) => node.type === "word" && node.value === "from",
      );
      const target = parsed.nodes.slice(fromIndex + 1).find((node) => node.type === "string");
      if (fromIndex >= 0 && target)
        add(target.value, "style-import", sourceText, valueOffset + target.sourceIndex + 1);
    }
    addValue(declaration.value, sourceText, valueOffset, "asset-reference");
  });
  references.sort(
    (left, right) =>
      left.location.line - right.location.line || left.location.column - right.location.column,
  );
  return references;
}

function aliasCandidates(specifier: string, options: ts.CompilerOptions): string[] {
  const paths = options.paths;
  const baseUrl =
    options.baseUrl ??
    (typeof options.pathsBasePath === "string" ? options.pathsBasePath : undefined);
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
  const pathname = specifier.split(/[?#]/u, 1)[0] ?? "";
  const query = specifier.slice(pathname.length);
  if (
    !pathname ||
    (query &&
      !/^(?:\?(?:url|raw|inline|no-inline|[a-z][a-z0-9_-]*=[a-z0-9._-]+))?(?:#[a-z0-9._-]+)?$/iu.test(
        query,
      ))
  )
    return undefined;
  const candidates = pathname.startsWith(".")
    ? [path.resolve(path.dirname(containingFile), pathname)]
    : aliasCandidates(pathname, options);
  const matches = candidates.filter((candidate) => {
    try {
      return fs.statSync(candidate).isFile() && isSupportedAsset(candidate);
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0] : undefined;
}
