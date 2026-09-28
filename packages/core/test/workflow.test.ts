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

    expect(initial.schemaVersion).toBe(2);
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
    const verification = await verifyPackage({ packageRoot: destination });
    expect(verification.status).toBe("not-run");
    expect(verification.checks.find((item) => item.id === "react-render")?.status).toBe("not-run");
  });

  it("uses TypeScript build without React/Vite for a pure TS graph in a React project", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-pure-ts-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "math-kit");
    const plan = await createExtractionPlan({
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/math.ts",
      packageName: "math-kit",
      destination,
    });
    expect(plan.target.profile).toBe("node-esm");
    expect(plan.expectedFiles).not.toContain("vite.config.ts");
    await exportPackage(plan);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(destination, "package.json"), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
      peerDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.devDependencies.vite).toBeUndefined();
    expect(manifest.scripts.build).toBe("tsc -p tsconfig.build.json");
  });

  it("rejects a plan created by an older beta before writing a destination", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-old-plan-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "old-kit");
    const plan = await createExtractionPlan({
      projectRoot: fixture("node-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "old-kit",
      destination,
    });
    const oldPlan = {
      ...plan,
      schemaVersion: 1,
      toolVersion: "0.4.0-beta.0",
    } as unknown as typeof plan;
    await expect(exportPackage(oldPlan)).rejects.toMatchObject({
      code: "PLAN_VERSION_UNSUPPORTED",
    });
    expect(fs.existsSync(destination)).toBe(false);
  });

  it("uses a Vite output profile for CSS without introducing React peers", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-vite-only-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "style-kit");
    const plan = await createExtractionPlan({
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/StyleOnly.ts",
      packageName: "style-kit",
      destination,
    });
    expect(plan.target.profile).toBe("vite-library");
    await exportPackage(plan);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(destination, "package.json"), "utf8"),
    ) as {
      devDependencies: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(manifest.devDependencies.vite).toBeDefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(plan.expectedFiles).toContain("vite.config.ts");
  });

  it("preserves resource queries while rewriting aliases in a deterministic plan", async () => {
    const request = {
      projectRoot: fixture("react-library"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Query.tsx",
      packageName: "query-kit",
      destination: path.join(os.tmpdir(), "codelift-query-plan-not-exported"),
    };
    const first = await createExtractionPlan(request);
    const second = await createExtractionPlan(request);
    expect(first.digest).toBe(second.digest);
    expect(first.rewrites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "@ui/mark.svg?url", to: "./mark.svg?url" }),
        expect.objectContaining({ from: "@ui/theme.css", to: "./theme.css" }),
      ]),
    );
  });

  it("requires explicit acceptance of global Tailwind styling warnings", async () => {
    const request = {
      projectRoot: fixture("react-tailwind"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/Badge.tsx",
      packageName: "badge-kit",
      destination: path.join(os.tmpdir(), "codelift-badge-plan-not-exported"),
    };
    const initial = await createExtractionPlan(request);
    expect(initial.status).toBe("review");
    const warning = initial.issues.find((issue) => issue.code === "CL015");
    expect(warning).toBeDefined();
    const accepted = await createExtractionPlan({
      ...request,
      acceptedWarningIds: [warning?.id ?? ""],
    });
    expect(accepted.status).toBe("ready");
  });

  it("blocks server-only package imports", async () => {
    const plan = await createExtractionPlan({
      projectRoot: fixture("framework-boundary"),
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/server-only.ts",
      packageName: "server-kit",
      destination: path.join(os.tmpdir(), "codelift-server-plan-not-exported"),
    });
    expect(plan.status).toBe("blocked");
    expect(plan.issues.some((issue) => issue.code === "CLP005")).toBe(true);
  });

  it("validates imported ranges against npm lockfile versions", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-lock-ranges-"));
    temporaryDirectories.push(projectRoot);
    fs.cpSync(fixture("node-esm-basic"), projectRoot, { recursive: true });
    const lockPath = path.join(projectRoot, "package-lock.json");
    const lock = {
      lockfileVersion: 3,
      packages: {
        "node_modules/@scope/client": { version: "2.4.0" },
        "node_modules/date-fns": { version: "4.1.0" },
      },
    };
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const request = {
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "locked-kit",
      destination: path.join(os.tmpdir(), "codelift-locked-plan-not-exported"),
    };
    const valid = await createExtractionPlan(request);
    expect(valid.issues.some((issue) => issue.code === "CLP006" || issue.code === "CLP007")).toBe(
      false,
    );
    lock.packages["node_modules/date-fns"].version = "3.0.0";
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    const invalid = await createExtractionPlan(request);
    expect(invalid.status).toBe("blocked");
    expect(invalid.issues.some((issue) => issue.code === "CLP006")).toBe(true);
  });

  it("reads direct dependency versions from a pnpm lockfile", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-pnpm-lock-"));
    temporaryDirectories.push(projectRoot);
    fs.cpSync(fixture("node-esm-basic"), projectRoot, { recursive: true });
    const lockPath = path.join(projectRoot, "pnpm-lock.yaml");
    fs.writeFileSync(
      lockPath,
      [
        "lockfileVersion: '9.0'",
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@scope/client':",
        "        specifier: ^2.4.0",
        "        version: 2.4.1",
        "      date-fns:",
        "        specifier: ^4.1.0",
        "        version: 4.1.2",
        "",
      ].join("\n"),
    );
    const plan = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "pnpm-locked-kit",
      destination: path.join(os.tmpdir(), "codelift-pnpm-plan-not-exported"),
    });
    expect(plan.issues.some((issue) => issue.code === "CLP006" || issue.code === "CLP007")).toBe(
      false,
    );
  });

  it("rejects local dependency ranges rather than silently resolving them", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-workspace-range-"));
    temporaryDirectories.push(projectRoot);
    fs.cpSync(fixture("node-esm-basic"), projectRoot, { recursive: true });
    const manifestPath = path.join(projectRoot, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies["date-fns"] = "workspace:*";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const plan = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "workspace-kit",
      destination: path.join(os.tmpdir(), "codelift-workspace-plan-not-exported"),
    });
    expect(plan.status).toBe("blocked");
    expect(plan.issues.some((issue) => issue.code === "CLP003")).toBe(true);
  });

  it("blocks Next.js runtime modules from standalone React library export", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-next-plan-"));
    temporaryDirectories.push(projectRoot);
    fs.mkdirSync(path.join(projectRoot, "src"));
    fs.writeFileSync(
      path.join(projectRoot, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { next: "^16.0.0", react: "^19.0.0", "react-dom": "^19.0.0" },
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          jsx: "react-jsx",
          module: "ESNext",
          moduleResolution: "Bundler",
          target: "ES2022",
        },
        include: ["src/**/*.tsx"],
      }),
    );
    fs.writeFileSync(
      path.join(projectRoot, "src", "page.tsx"),
      'import { useRouter } from "next/navigation";\nexport function Page() { return useRouter(); }\n',
    );

    const plan = await createExtractionPlan({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/page.tsx",
      packageName: "next-page-trial",
      destination: path.join(os.tmpdir(), "codelift-next-page-trial"),
    });

    expect(plan.status).toBe("blocked");
    expect(plan.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "CLP005", blocking: true })]),
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
