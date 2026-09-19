import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProject } from "../src/index.js";

const temporaryDirectories: string[] = [];
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function fixture(name: string): string {
  return path.join(workspaceRoot, "fixtures", name);
}

function digestDirectory(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        hash.update(path.relative(root, absolute));
        hash.update(fs.readFileSync(absolute));
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("analyzeProject", () => {
  it("builds a deterministic, explainable graph for the supported profile", async () => {
    const projectRoot = fixture("node-esm-basic");
    const before = digestDirectory(projectRoot);
    const request = {
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    };

    const first = await analyzeProject(request, undefined, { now: () => 10 });
    const second = await analyzeProject(request, undefined, { now: () => 10 });

    expect(first.project.profileStatus).toBe("supported");
    expect(first.nodes).toEqual(second.nodes);
    expect(first.edges).toEqual(second.edges);
    expect(first.cycles).toEqual(second.cycles);
    expect(first.stats.localFiles).toBe(5);
    expect(first.externalPackages).toEqual([
      { name: "@scope/client", specifiers: ["@scope/client/http"], declaredRange: "^2.4.0" },
      { name: "date-fns", specifiers: ["date-fns"], declaredRange: "^4.1.0" },
    ]);
    expect(first.edges.some((edge) => edge.kind === "type-only")).toBe(true);
    expect(first.edges.some((edge) => edge.kind === "re-export")).toBe(true);
    expect(first.edges.some((edge) => edge.kind === "literal-dynamic-import")).toBe(true);
    expect(first.cycles).toHaveLength(1);
    expect(first.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CL007", "CL008", "CL009"]),
    );
    expect(first.issues.some((issue) => issue.blocking)).toBe(false);

    const formatNode = first.nodes.find((node) => node.path === "src/format.ts");
    const reason = first.reasons.find((candidate) => candidate.nodeId === formatNode?.id);
    expect(reason?.nodePath).toEqual(["file:src/index.ts", "file:src/format.ts"]);
    expect(before).toBe(digestDirectory(projectRoot));
  });

  it("reports unsupported imports without executing source code", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("node-esm-issues"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });

    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["CL003", "CL005", "CL006"]),
    );
    expect(result.issues.filter((issue) => issue.blocking)).toHaveLength(3);
    expect(result.stats.unresolvedImports).toBe(1);
  });

  it("detects a symlink that resolves outside the configured root", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-symlink-"));
    temporaryDirectories.push(temporaryRoot);
    const projectRoot = path.join(temporaryRoot, "project");
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2024" },
        include: ["src/**/*.ts"],
      }),
    );
    fs.writeFileSync(path.join(projectRoot, "src", "index.ts"), 'export * from "./outside.js";');
    const outsidePath = path.join(temporaryRoot, "outside.ts");
    fs.writeFileSync(outsidePath, "export const outside = true;");
    fs.symlinkSync(outsidePath, path.join(projectRoot, "src", "outside.ts"));

    const result = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });

    expect(result.issues.some((issue) => issue.code === "CL004" && issue.blocking)).toBe(true);
  });
});
