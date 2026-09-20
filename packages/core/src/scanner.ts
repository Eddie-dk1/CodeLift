import path from "node:path";
import ts from "typescript-compat";
import type { GraphEdgeKind, SourceLocation } from "./types.js";

export interface ImportRecord {
  specifier: string;
  kind: GraphEdgeKind;
  sourceText: string;
  location: SourceLocation;
}

export interface ScanIssue {
  code: string;
  message: string;
  detail?: string;
  blocking: boolean;
  location: SourceLocation;
}

export interface ScanResult {
  imports: ImportRecord[];
  issues: ScanIssue[];
}

function locationFor(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  relativePath: string,
): SourceLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    path: relativePath,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function importIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return Boolean(
    bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((item) => item.isTypeOnly),
  );
}

function calledName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function environmentName(node: ts.PropertyAccessExpression): string | undefined {
  const target = node.expression;
  if (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === "process" &&
    target.name.text === "env"
  ) {
    return node.name.text;
  }
  return undefined;
}

export function scanSourceFile(sourceFile: ts.SourceFile, relativePath: string): ScanResult {
  const imports: ImportRecord[] = [];
  const issues: ScanIssue[] = [];
  const fileReadCalls = new Set([
    "readFile",
    "readFileSync",
    "createReadStream",
    "open",
    "openSync",
  ]);
  let reportedGlobalThis = false;

  const addIssue = (issue: ScanIssue) => {
    const key = `${issue.code}:${issue.location.line}:${issue.location.column}:${issue.message}`;
    if (
      !issues.some(
        (existing) =>
          `${existing.code}:${existing.location.line}:${existing.location.column}:${existing.message}` ===
          key,
      )
    ) {
      issues.push(issue);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        kind: importIsTypeOnly(node) ? "type-only" : "static-import",
        sourceText: node.getText(sourceFile),
        location: locationFor(sourceFile, node.moduleSpecifier, relativePath),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        kind: node.isTypeOnly ? "type-only" : "re-export",
        sourceText: node.getText(sourceFile),
        location: locationFor(sourceFile, node.moduleSpecifier, relativePath),
      });
    } else if (ts.isImportEqualsDeclaration(node)) {
      addIssue({
        code: "CL006",
        message: "CommonJS-style import assignment is not supported by the node-esm profile.",
        blocking: true,
        location: locationFor(sourceFile, node, relativePath),
      });
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) {
          imports.push({
            specifier: argument.text,
            kind: "literal-dynamic-import",
            sourceText: node.getText(sourceFile),
            location: locationFor(sourceFile, argument, relativePath),
          });
        } else {
          addIssue({
            code: "CL005",
            message:
              "Dynamic import cannot be resolved because its argument is not a string literal.",
            blocking: true,
            location: locationFor(sourceFile, node, relativePath),
          });
        }
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        addIssue({
          code: "CL006",
          message: "require() is not supported by the node-esm profile.",
          blocking: true,
          location: locationFor(sourceFile, node, relativePath),
        });
      }

      const name = calledName(node.expression);
      const firstArgument = node.arguments[0];
      if (
        name &&
        fileReadCalls.has(name) &&
        firstArgument &&
        ts.isStringLiteralLike(firstArgument) &&
        (firstArgument.text.startsWith("./") || firstArgument.text.startsWith("../"))
      ) {
        addIssue({
          code: "CL007",
          message: `Relative file access may depend on the process working directory: ${firstArgument.text}`,
          detail: "The referenced resource is not included automatically.",
          blocking: false,
          location: locationFor(sourceFile, firstArgument, relativePath),
        });
      }
    }

    if (ts.isPropertyAccessExpression(node)) {
      const variableName = environmentName(node);
      if (variableName) {
        addIssue({
          code: "CL008",
          message: `Reads environment variable ${variableName}.`,
          detail: "Environment values are not transferred automatically.",
          blocking: false,
          location: locationFor(sourceFile, node, relativePath),
        });
      }
    }

    if (!reportedGlobalThis && ts.isIdentifier(node) && node.text === "globalThis") {
      reportedGlobalThis = true;
      addIssue({
        code: "CL009",
        message: "Reads from globalThis; required application state may not be portable.",
        blocking: false,
        location: locationFor(sourceFile, node, relativePath),
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { imports, issues };
}

export function isSupportedSourceFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".mts") ||
    lower.endsWith(".d.ts")
  );
}

export function looksLikeAssetSpecifier(specifier: string): boolean {
  const extension = path.extname(specifier).toLowerCase();
  return (
    extension.length > 0 &&
    ![".js", ".jsx", ".mjs", ".ts", ".tsx", ".mts", ".d.ts"].includes(extension)
  );
}
