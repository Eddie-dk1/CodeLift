import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanCss } from "../src/asset-scanner.js";
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
    expect(first.schemaVersion).toBe(3);
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

  it("follows React TSX, CSS Modules, JSON, SVG, and font assets", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Card.tsx",
    });

    expect(result.project).toMatchObject({
      profile: "react-library",
      profileStatus: "supported",
    });
    expect(result.stats.localFiles).toBe(2);
    expect(result.stats.localAssets).toBe(6);
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "local-asset", path: "src/Card.module.css" }),
        expect.objectContaining({ kind: "local-asset", path: "src/copy.json" }),
        expect.objectContaining({ kind: "local-asset", path: "src/mark.svg" }),
        expect.objectContaining({ kind: "local-asset", path: "src/fixture.woff2" }),
      ]),
    );
    expect(result.edges.map((edge) => edge.kind)).toEqual(
      expect.arrayContaining(["asset-import", "style-import", "asset-reference"]),
    );
    expect(result.externalPackages).toEqual([
      { name: "react", specifiers: ["react"], declaredRange: "^19.3.0" },
    ]);
    expect(result.issues).toHaveLength(0);
  });

  it("keeps pure TypeScript in a JSX/Bundler project on the Node output profile", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/math.ts",
    });
    expect(result.project.profile).toBe("node-esm");
    expect(result.stats.localAssets).toBe(0);
    expect(result.externalPackages).toHaveLength(0);
    expect(result.issues).toHaveLength(0);
  });

  it("does not add Vite solely for a type-only React dependency", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/ReactTypes.ts",
    });
    expect(result.project.profile).toBe("node-esm");
    expect(result.externalPackages.map((dependency) => dependency.name)).toEqual(["react"]);
    expect(result.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "type-only", specifier: "react" })]),
    );
  });

  it("follows re-exports and nested aliases without a baseUrl", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("alias-no-baseurl"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });
    expect(result.project.profile).toBe("node-esm");
    expect(result.stats.localFiles).toBe(4);
    expect(result.issues).toHaveLength(0);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "re-export", specifier: "@lib/normalize.js" }),
        expect.objectContaining({ kind: "type-only", specifier: "@lib/types.js" }),
        expect.objectContaining({ kind: "static-import", specifier: "@lib/trim.js" }),
      ]),
    );
  });

  it("parses CSS syntax, aliases and query suffixes without tracing comments", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Query.tsx",
    });
    expect(result.project.profile).toBe("react-library");
    expect(result.issues).toHaveLength(0);
    expect(result.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ specifier: "@ui/mark.svg?url", kind: "asset-import" }),
        expect.objectContaining({ specifier: "@ui/theme.css", kind: "style-import" }),
        expect.objectContaining({ specifier: "@ui/surface.module.css", kind: "style-import" }),
        expect.objectContaining({ specifier: "./mark.svg?v=1", kind: "asset-reference" }),
      ]),
    );
    expect(result.edges.some((edge) => edge.specifier.includes("missing"))).toBe(false);
    const cssImport = result.edges.find((edge) => edge.specifier === "@ui/theme.css");
    expect(cssImport?.location).toMatchObject({
      path: "src/Query.module.css",
      line: 2,
      column: 14,
    });
  });

  it("retains CSS evidence coordinates with CRLF line endings", () => {
    const references = scanCss('/* ignored */\r\n@import url("./theme.css");\r\n', "src/test.css");
    expect(references).toEqual([
      expect.objectContaining({
        specifier: "./theme.css",
        location: expect.objectContaining({ line: 2, column: 14 }),
      }),
    ]);
  });

  it("reports unsupported asset queries and malformed CSS instead of omitting them", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-css-issue-"));
    temporaryDirectories.push(projectRoot);
    fs.cpSync(fixture("react-library"), projectRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, "src/Query.tsx"),
      'import mark from "./mark.svg?component";\nexport const value = mark;\n',
    );
    fs.writeFileSync(path.join(projectRoot, "src/Card.module.css"), ".card { color: red;");
    const query = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Query.tsx",
    });
    const css = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Card.tsx",
    });
    expect(query.issues.some((issue) => issue.code === "CL010" && issue.blocking)).toBe(true);
    expect(css.issues.some((issue) => issue.code === "CL013" && issue.blocking)).toBe(true);
  });

  it("reports local ambient declarations as a blocking portability dependency", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("ambient-local"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "CL014",
          blocking: true,
          location: expect.objectContaining({ line: 1 }),
        }),
      ]),
    );
  });

  it("requires manual styling review for app-global Tailwind classes", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("react-tailwind"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Badge.tsx",
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CL015", blocking: false })]),
    );
    expect(result.stats.localAssets).toBe(0);
  });

  it("blocks server actions while preserving portable use-client components", async () => {
    const projectRoot = fixture("framework-boundary");
    const server = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/server.ts",
    });
    const client = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/client.tsx",
    });
    expect(server.issues.some((issue) => issue.code === "CL016" && issue.blocking)).toBe(true);
    expect(client.issues.some((issue) => issue.code === "CL016")).toBe(false);
  });

  it("reports framework-specific glob loading instead of silently omitting dependencies", async () => {
    const result = await analyzeProject({
      projectRoot: fixture("framework-boundary"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/glob.ts",
    });
    expect(result.issues.some((issue) => issue.code === "CL019" && issue.blocking)).toBe(true);
  });

  it("reports NodeNext CommonJS interpretation as unsupported", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-commonjs-"));
    temporaryDirectories.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, "package.json"), '{"private":true,"type":"commonjs"}');
    fs.writeFileSync(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" },
        include: ["src/**/*.ts"],
      }),
    );
    fs.writeFileSync(path.join(projectRoot, "src/index.ts"), "export const value = 1;");
    const result = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });
    expect(result.issues.some((issue) => issue.code === "CL017" && issue.blocking)).toBe(true);
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
