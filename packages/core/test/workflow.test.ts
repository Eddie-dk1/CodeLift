import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExtractionPlan,
  discoverProject,
  exportPackage,
  verifyPackage,
} from "../src/index.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const temporaryDirectories: string[] = [];

function fixture(name: string): string {
  return path.join(workspaceRoot, "fixtures", name);
}

function digestDirectory(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        hash.update(path.relative(root, absolute)).update(fs.readFileSync(absolute));
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

describe("CodeLift extraction workflow", () => {
  it("discovers a single React project configuration and TSX entrypoint", () => {
    const project = discoverProject({
      projectRoot: fixture("react-library"),
      entrypoint: "src/Card.tsx",
    });

    expect(project.selectedTsconfig).toBe("tsconfig.json");
    expect(project.entrypoint).toBe("src/Card.tsx");
    expect(project.sourceFiles).toContain("src/Card.tsx");
    expect(project.ambiguous).toBe(false);
  });

  it("reports ambiguous compiler configurations instead of choosing silently", () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-discovery-"));
    temporaryDirectories.push(temporaryRoot);
    fs.cpSync(fixture("node-library"), temporaryRoot, { recursive: true });
    fs.copyFileSync(
      path.join(temporaryRoot, "tsconfig.json"),
      path.join(temporaryRoot, "tsconfig.library.json"),
    );

    const project = discoverProject({
      projectRoot: temporaryRoot,
      entrypoint: "src/index.ts",
    });
    expect(project.selectedTsconfig).toBeNull();
    expect(project.ambiguous).toBe(true);
    expect(project.tsconfigs).toEqual(["tsconfig.json", "tsconfig.library.json"]);
  });

  it("creates a deterministic plan, rewrites aliases, and never changes the source", async () => {
    const projectRoot = fixture("node-esm-basic");
    const before = digestDirectory(projectRoot);
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-export-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "invoice-kit");
    const initial = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "invoice-kit",
      destination,
    });

    expect(initial.status).toBe("review");
    const plan = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "invoice-kit",
      destination,
      acceptedWarningIds: initial.issues
        .filter((issue) => !issue.blocking)
        .map((issue) => issue.id),
    });
    expect(plan.status).toBe("ready");
    expect(plan.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "@fixture/shared/types.js", to: "./shared/types.js" }),
      ]),
    );

    const exported = await exportPackage(plan);
    expect(exported.status).toBe("exported");
    expect(fs.readFileSync(path.join(destination, "src/index.ts"), "utf8")).toContain(
      'from "./shared/types.js"',
    );
    expect(fs.readFileSync(path.join(destination, "tsconfig.json"), "utf8")).toContain('"node"');
    expect(before).toBe(digestDirectory(projectRoot));

    const verification = await verifyPackage({ packageRoot: destination });
    expect(verification.status).toBe("not-run");
    expect(verification.checks.filter((item) => item.status === "failed")).toHaveLength(0);
  });

  it("exports a React source package with copied CSS and assets", async () => {
    const projectRoot = fixture("react-library");
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-react-export-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "card-kit");
    const plan = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Card.tsx",
      packageName: "card-kit",
      destination,
    });

    expect(plan.status).toBe("ready");
    await exportPackage(plan);
    expect(fs.existsSync(path.join(destination, "src/Card.module.css"))).toBe(true);
    expect(fs.existsSync(path.join(destination, "src/mark.svg"))).toBe(true);
    expect(fs.readFileSync(path.join(destination, "src/index.ts"), "utf8")).toContain(
      'export * from "./Card.js";',
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(destination, "package.json"), "utf8"),
    ) as {
      peerDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(manifest.peerDependencies.react).toBe("^19.3.0");
    expect(manifest.peerDependencies["react-dom"]).toBe("^19.3.0");
    expect(manifest.scripts.build).toContain("vite build");
    expect(fs.readFileSync(path.join(destination, "vite.config.ts"), "utf8")).toContain(
      'id.startsWith(name + "/")',
    );
  });

  it("keeps the plan identity portable and invalidates it when the lockfile changes", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-portable-plan-"));
    temporaryDirectories.push(temporaryRoot);
    const firstRoot = path.join(temporaryRoot, "first");
    const secondRoot = path.join(temporaryRoot, "second");
    fs.cpSync(fixture("node-library"), firstRoot, { recursive: true });
    fs.cpSync(fixture("node-library"), secondRoot, { recursive: true });
    fs.writeFileSync(path.join(firstRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(secondRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
    const destination = path.join(temporaryRoot, "output");
    const request = {
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "portable-node-library",
      destination,
    };

    const first = await createExtractionPlan({ projectRoot: firstRoot, ...request });
    const second = await createExtractionPlan({ projectRoot: secondRoot, ...request });
    expect(first.digest).toBe(second.digest);
    expect(first.source.lockfile?.path).toBe("package-lock.json");

    fs.writeFileSync(
      path.join(firstRoot, "package-lock.json"),
      '{"lockfileVersion":3,"changed":true}\n',
    );
    await expect(exportPackage(first)).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("leaves no destination after cancellation and rejects source overlap", async () => {
    const projectRoot = fixture("node-library");
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-cancel-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "cancelled-package");
    const plan = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "cancelled-package",
      destination,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(exportPackage(plan, {}, controller.signal)).rejects.toMatchObject({
      code: "EXPORT_ABORTED",
    });
    expect(fs.existsSync(destination)).toBe(false);

    const overlapping = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "overlapping-package",
      destination: path.join(projectRoot, "generated-package"),
    });
    await expect(exportPackage(overlapping)).rejects.toMatchObject({
      code: "DESTINATION_OVERLAPS_SOURCE",
    });
  });
});
