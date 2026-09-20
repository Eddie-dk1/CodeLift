import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnalysisError } from "./errors.js";
import { isInsideRoot, toRealPath } from "./path-utils.js";
import type {
  ExportOptions,
  ExportResult,
  ExtractionPlan,
  PlannedRewrite,
} from "./workflow-types.js";
import { digestExtractionPlan, digestFile, stableJson } from "./workflow-utils.js";

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AnalysisError("EXPORT_ABORTED", "Export was cancelled.");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function verifyPlanDigest(plan: ExtractionPlan): void {
  if (digestExtractionPlan(plan) !== plan.digest) {
    throw new AnalysisError("PLAN_TAMPERED", "The extraction plan digest is invalid.");
  }
}

function verifySnapshot(plan: ExtractionPlan): void {
  for (const file of plan.files) {
    const absolute = path.join(plan.source.root, file.source);
    if (!fs.existsSync(absolute) || digestFile(absolute) !== file.digest) {
      throw new AnalysisError(
        "PLAN_STALE",
        `Source file changed after the plan was created: ${file.source}`,
      );
    }
  }
  const configPath = path.join(plan.source.root, plan.source.tsconfig);
  if (!fs.existsSync(configPath) || digestFile(configPath) !== plan.source.tsconfigDigest) {
    throw new AnalysisError("PLAN_STALE", "The TypeScript configuration changed after planning.");
  }
  const packagePath = path.join(plan.source.root, "package.json");
  if (
    plan.source.packageJsonDigest &&
    (!fs.existsSync(packagePath) || digestFile(packagePath) !== plan.source.packageJsonDigest)
  ) {
    throw new AnalysisError("PLAN_STALE", "package.json changed after planning.");
  }
  if (plan.source.lockfile) {
    const lockfilePath = path.join(plan.source.root, plan.source.lockfile.path);
    if (!fs.existsSync(lockfilePath) || digestFile(lockfilePath) !== plan.source.lockfile.digest) {
      throw new AnalysisError("PLAN_STALE", "The dependency lockfile changed after planning.");
    }
  }
}

function validateDestination(plan: ExtractionPlan): { destination: string; parent: string } {
  const destination = path.resolve(plan.target.destination);
  const sourceRoot = toRealPath(plan.source.root);
  const root = path.parse(destination).root;
  const home = path.resolve(os.homedir());
  if (destination === root || destination === home) {
    throw new AnalysisError(
      "DESTINATION_UNSAFE",
      "Filesystem roots and the home directory are unsafe destinations.",
    );
  }
  if (fs.existsSync(destination)) {
    throw new AnalysisError("DESTINATION_EXISTS", `Destination already exists: ${destination}`);
  }
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new AnalysisError(
      "DESTINATION_PARENT_MISSING",
      `Destination parent does not exist: ${parent}`,
    );
  }
  const realParent = toRealPath(parent);
  const realDestination = path.join(realParent, path.basename(destination));
  if (isInsideRoot(sourceRoot, realDestination) || isInsideRoot(realDestination, sourceRoot)) {
    throw new AnalysisError(
      "DESTINATION_OVERLAPS_SOURCE",
      "Destination must not be inside or contain the source project.",
    );
  }
  if (realParent === path.parse(realParent).root || realParent === home) {
    throw new AnalysisError(
      "DESTINATION_UNSAFE",
      "Choose a destination inside a dedicated working directory.",
    );
  }
  return { destination: realDestination, parent: realParent };
}

function offsetAt(text: string, line: number, column: number): number {
  const lines = text.split(/\r?\n/u);
  let offset = 0;
  for (let index = 0; index < line - 1; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset + column - 1;
}

function applyRewrites(text: string, rewrites: PlannedRewrite[]): string {
  const edits = rewrites.map((rewrite) => {
    const approximate = offsetAt(text, rewrite.location.line, rewrite.location.column);
    const searchWindow = text.slice(approximate, approximate + rewrite.from.length + 4);
    const relativeStart = searchWindow.indexOf(rewrite.from);
    if (relativeStart === -1) {
      throw new AnalysisError(
        "REWRITE_EVIDENCE_MISMATCH",
        `Could not locate ${rewrite.from} in ${rewrite.file}:${rewrite.location.line}.`,
      );
    }
    return { start: approximate + relativeStart, from: rewrite.from, to: rewrite.to };
  });
  edits.sort((left, right) => right.start - left.start);
  let result = text;
  for (const edit of edits) {
    if (result.slice(edit.start, edit.start + edit.from.length) !== edit.from) {
      throw new AnalysisError(
        "REWRITE_EVIDENCE_MISMATCH",
        "Overlapping import rewrites are not supported.",
      );
    }
    result = `${result.slice(0, edit.start)}${edit.to}${result.slice(edit.start + edit.from.length)}`;
  }
  return result;
}

function dependenciesFor(plan: ExtractionPlan): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {
    dependencies: {},
    peerDependencies: {},
    devDependencies: {},
  };
  for (const decision of plan.dependencyDecisions) {
    const group = result[decision.classification];
    if (group) group[decision.name] = decision.range;
  }
  const dev = result.devDependencies ?? {};
  dev.typescript = "^7.0.2";
  if (plan.target.profile === "react-library") {
    dev.vite = "^8.3.0";
    dev["@types/react"] = "^19.0.0";
    dev["@types/react-dom"] = "^19.0.0";
  } else if (plan.analysis.stats.nodeBuiltins > 0) {
    dev["@types/node"] = "^24.0.0";
  }
  return result;
}

function generatedPackageJson(plan: ExtractionPlan): string {
  const groups = dependenciesFor(plan);
  const hasStyles = plan.files.some((file) => file.destination.endsWith(".css"));
  const exportsMap: Record<string, unknown> = {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
  };
  if (plan.target.profile === "react-library" && hasStyles)
    exportsMap["./style.css"] = "./dist/style.css";
  return stableJson({
    name: plan.target.packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    files: ["dist"],
    exports: exportsMap,
    scripts: {
      build:
        plan.target.profile === "react-library"
          ? "vite build && tsc -p tsconfig.build.json --emitDeclarationOnly"
          : "tsc -p tsconfig.build.json",
      typecheck: "tsc -p tsconfig.json --noEmit",
    },
    ...(Object.keys(groups.dependencies ?? {}).length > 0
      ? { dependencies: groups.dependencies }
      : {}),
    ...(Object.keys(groups.peerDependencies ?? {}).length > 0
      ? { peerDependencies: groups.peerDependencies }
      : {}),
    devDependencies: groups.devDependencies,
  });
}

function generatedTsconfig(plan: ExtractionPlan, build: boolean): string {
  const compilerOptions: Record<string, unknown> = {
    target: "ES2022",
    module: plan.target.profile === "react-library" ? "ESNext" : "NodeNext",
    moduleResolution: plan.target.profile === "react-library" ? "Bundler" : "NodeNext",
    strict: true,
    rootDir: "src",
    ...(build ? { outDir: "dist", declaration: true, declarationMap: true, sourceMap: true } : {}),
    ...(plan.target.profile === "react-library"
      ? { jsx: "react-jsx", resolveJsonModule: true, types: ["vite/client"] }
      : plan.analysis.stats.nodeBuiltins > 0
        ? { types: ["node"] }
        : {}),
    skipLibCheck: true,
    verbatimModuleSyntax: true,
  };
  return stableJson({
    ...(build ? { extends: "./tsconfig.json" } : {}),
    compilerOptions,
    include: ["src/**/*.ts", "src/**/*.tsx"],
  });
}

function generatedViteConfig(plan: ExtractionPlan): string {
  const external = [...new Set(plan.dependencyDecisions.map((decision) => decision.name))].sort();
  return `import { defineConfig } from "vite";\n\nconst externalDependencies = ${JSON.stringify(external)};\n\nexport default defineConfig({\n  build: {\n    lib: {\n      entry: "src/index.ts",\n      formats: ["es"],\n      fileName: "index",\n      cssFileName: "style",\n    },\n    rollupOptions: {\n      external: (id) => externalDependencies.some((name) => id === name || id.startsWith(name + "/")),\n    },\n  },\n});\n`;
}

function generatedIndex(plan: ExtractionPlan): string {
  const entry = plan.files.find((file) => file.source === plan.source.entrypoint);
  if (!entry)
    throw new AnalysisError("PLAN_ENTRYPOINT_MISSING", "Entrypoint is missing from plan files.");
  let target = entry.destination.replace(/\.tsx?$/u, ".js").replace(/\.mts$/u, ".mjs");
  target = path.posix.relative("src", target);
  if (!target.startsWith(".")) target = `./${target}`;
  const lines = [`export * from ${JSON.stringify(target)};`];
  if (plan.entrypointHasDefaultExport)
    lines.push(`export { default } from ${JSON.stringify(target)};`);
  return `${lines.join("\n")}\n`;
}

function writeGeneratedFiles(stage: string, plan: ExtractionPlan): void {
  fs.writeFileSync(path.join(stage, "package.json"), generatedPackageJson(plan));
  fs.writeFileSync(path.join(stage, "tsconfig.json"), generatedTsconfig(plan, false));
  fs.writeFileSync(path.join(stage, "tsconfig.build.json"), generatedTsconfig(plan, true));
  fs.writeFileSync(path.join(stage, ".gitignore"), "node_modules/\ndist/\n*.tsbuildinfo\n");
  fs.writeFileSync(
    path.join(stage, "README.md"),
    `# ${plan.target.packageName}\n\nExtracted with CodeLift from \`${plan.source.entrypoint}\`.\n\n## Build\n\n\`\`\`bash\nnpm install\nnpm run build\n\`\`\`\n`,
  );
  if (plan.target.profile === "react-library") {
    fs.writeFileSync(path.join(stage, "vite.config.ts"), generatedViteConfig(plan));
  }
  const entry = plan.files.find((file) => file.source === plan.source.entrypoint);
  if (entry?.destination !== plan.publicEntrypoint) {
    fs.mkdirSync(path.join(stage, path.dirname(plan.publicEntrypoint)), { recursive: true });
    fs.writeFileSync(path.join(stage, plan.publicEntrypoint), generatedIndex(plan));
  }
  if (plan.target.copyLicense) {
    const license = path.join(plan.source.root, "LICENSE");
    if (fs.existsSync(license)) fs.copyFileSync(license, path.join(stage, "LICENSE"));
  }
  fs.writeFileSync(
    path.join(stage, "codelift-report.json"),
    stableJson({ schemaVersion: 1, status: "exported", plan, verification: null }),
  );
}

export async function exportPackage(
  plan: ExtractionPlan,
  _options: ExportOptions = {},
  signal?: AbortSignal,
): Promise<ExportResult> {
  const startedAt = performance.now();
  throwIfAborted(signal);
  verifyPlanDigest(plan);
  if (plan.status !== "ready") {
    throw new AnalysisError(
      "PLAN_NOT_READY",
      `Plan status is ${plan.status}; resolve blocking issues and accept warnings first.`,
    );
  }
  verifySnapshot(plan);
  const { destination, parent } = validateDestination(plan);
  const stage = path.join(parent, `.codelift-${path.basename(destination)}-${randomUUID()}`);
  const caseInsensitivePaths = new Set<string>();

  try {
    fs.mkdirSync(stage, { recursive: false });
    for (const file of plan.files) {
      await yieldToEventLoop();
      throwIfAborted(signal);
      const collisionKey = file.destination.toLocaleLowerCase("en-US");
      if (caseInsensitivePaths.has(collisionKey)) {
        throw new AnalysisError(
          "DESTINATION_COLLISION",
          `Case-insensitive path collision: ${file.destination}`,
        );
      }
      caseInsensitivePaths.add(collisionKey);
      const source = path.join(plan.source.root, file.source);
      const target = path.join(stage, file.destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const rewrites = plan.rewrites.filter((rewrite) => rewrite.file === file.source);
      if (rewrites.length > 0) {
        fs.writeFileSync(target, applyRewrites(fs.readFileSync(source, "utf8"), rewrites));
      } else {
        fs.copyFileSync(source, target);
      }
    }
    writeGeneratedFiles(stage, plan);
    for (const expected of plan.expectedFiles) {
      if (!fs.existsSync(path.join(stage, expected))) {
        throw new AnalysisError("EXPORT_INCOMPLETE", `Expected file was not created: ${expected}`);
      }
    }
    await yieldToEventLoop();
    throwIfAborted(signal);
    fs.renameSync(stage, destination);
    return {
      schemaVersion: 1,
      status: "exported",
      destination,
      planDigest: plan.digest,
      files: plan.expectedFiles,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    };
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}
