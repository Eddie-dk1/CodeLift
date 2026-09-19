import type { AnalysisResult, GraphNode } from "@codelift/core";

function nodeDescription(node: GraphNode): string {
  if (node.kind === "local-file") return node.path ?? node.label;
  if (node.kind === "external-package") return `${node.packageName ?? node.label} (npm)`;
  if (node.kind === "node-builtin") return `${node.builtinName ?? node.label} (Node.js)`;
  return `${node.label} (unresolved)`;
}

export function renderJson(result: AnalysisResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function renderPretty(result: AnalysisResult): string {
  const lines: string[] = [];
  const blockingIssues = result.issues.filter((issue) => issue.blocking).length;
  lines.push(`CodeLift analysis — ${result.entrypoint}`);
  lines.push(
    `${result.stats.localFiles} files · ${result.stats.externalPackages} packages · ${result.cycles.length} cycles · ${result.issues.length} issues`,
  );
  lines.push("");
  lines.push("Included files");
  for (const node of result.nodes.filter((candidate) => candidate.kind === "local-file")) {
    const marker = node.path === result.entrypoint ? "→" : " ";
    lines.push(`${marker} ${nodeDescription(node)}`);
  }

  if (result.externalPackages.length > 0) {
    lines.push("");
    lines.push("External packages");
    for (const dependency of result.externalPackages) {
      lines.push(
        `  ${dependency.name}${dependency.declaredRange ? ` ${dependency.declaredRange}` : " (version unknown)"}`,
      );
    }
  }

  if (result.issues.length > 0) {
    lines.push("");
    lines.push("Issues");
    for (const issue of result.issues) {
      const location = issue.location
        ? `${issue.location.path}:${issue.location.line}:${issue.location.column}`
        : "project";
      lines.push(
        `  ${issue.blocking ? "ERROR" : "WARN "} ${issue.code} ${location} — ${issue.message}`,
      );
    }
  }

  lines.push("");
  lines.push(
    blockingIssues > 0
      ? `Analysis completed with ${blockingIssues} blocking issue${blockingIssues === 1 ? "" : "s"}.`
      : `Analysis completed in ${result.stats.durationMs} ms.`,
  );
  return `${lines.join("\n")}\n`;
}
