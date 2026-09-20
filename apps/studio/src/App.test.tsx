// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { AnalysisResult } from "@codelift/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  Position: { Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  BackgroundVariant: { Dots: "dots" },
  ReactFlow: ({
    nodes,
    onNodeClick,
  }: {
    nodes: Array<{ id: string; data: { dependency: { label: string } } }>;
    onNodeClick: (event: unknown, node: { id: string }) => void;
  }) => (
    <div data-testid="graph">
      {nodes.map((node) => (
        <button key={node.id} type="button" onClick={() => onNodeClick({}, node)}>
          graph-{node.data.dependency.label}
        </button>
      ))}
    </div>
  ),
}));

const analysis: AnalysisResult = {
  schemaVersion: 2,
  project: {
    root: "/projects/invoice",
    tsconfig: "tsconfig.json",
    typescriptVersion: "6.0.0",
    profile: "node-esm",
    profileStatus: "supported",
  },
  entrypoint: "src/index.ts",
  nodes: [
    {
      id: "file:src/index.ts",
      kind: "local-file",
      label: "index.ts",
      included: true,
      path: "src/index.ts",
    },
    {
      id: "file:src/format.ts",
      kind: "local-file",
      label: "format.ts",
      included: true,
      path: "src/format.ts",
    },
  ],
  edges: [
    {
      id: "edge:format",
      source: "file:src/index.ts",
      target: "file:src/format.ts",
      kind: "static-import",
      specifier: "./format.js",
      sourceText: 'import { format } from "./format.js";',
      location: { path: "src/index.ts", line: 1, column: 24, endLine: 1, endColumn: 37 },
    },
  ],
  issues: [],
  cycles: [],
  externalPackages: [],
  reasons: [
    { nodeId: "file:src/index.ts", nodePath: ["file:src/index.ts"], edgePath: [] },
    {
      nodeId: "file:src/format.ts",
      nodePath: ["file:src/index.ts", "file:src/format.ts"],
      edgePath: ["edge:format"],
    },
  ],
  stats: {
    localFiles: 2,
    localAssets: 0,
    externalPackages: 0,
    nodeBuiltins: 0,
    unresolvedImports: 0,
    issues: 0,
    durationMs: 12,
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  window.location.hash = "token=test-token";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session") {
        return response({
          projectName: "invoice",
          projectRoot: "/projects/invoice",
          tsconfigs: ["tsconfig.json"],
          sourceFiles: ["src/index.ts", "src/format.ts"],
          initialTsconfig: "tsconfig.json",
          initialEntrypoint: "src/index.ts",
          ambiguousTsconfig: false,
          capabilities: {
            profiles: ["node-esm", "react-library"],
            sourcePreview: true,
            extraction: true,
            verification: true,
          },
        });
      }
      if (url === "/api/analyze") return response(analysis);
      if (url.startsWith("/api/source"))
        return response({ path: "src/format.ts", content: "export const format = true;" });
      return response({ error: "Not found" }, 404);
    }),
  );
});

describe("CodeLift Studio", () => {
  it("renders the real analysis state and inclusion evidence", async () => {
    render(<App />);

    expect(await screen.findByText("Analysis complete")).toBeInTheDocument();
    expect(screen.getByText("Compiler config")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Explain compiler config" })).toBeInTheDocument();
    expect(
      screen.getByText(/Controls import resolution, path aliases, and module settings/),
    ).toBeInTheDocument();
    expect(screen.getByText("2 files included")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "graph-format.ts" }));
    expect(screen.getByText('import { format } from "./format.js";')).toBeInTheDocument();
    expect(screen.getByText("No issues are attached to this node.")).toBeInTheDocument();
  });

  it("shows session failures in the status bar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "Invalid session" }, 401)),
    );
    render(<App />);
    expect(await screen.findByText("Invalid session")).toBeInTheDocument();
  });
});
