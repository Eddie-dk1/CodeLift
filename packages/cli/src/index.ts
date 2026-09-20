import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisError,
  analyzeProject,
  createExtractionPlan,
  discoverProject,
  type ExtractionPlan,
  exportPackage,
  serializeExtractionPlan,
  verifyPackage,
} from "@codelift/core";
import { startStudioServer } from "@codelift/studio-server";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { renderJson, renderPretty } from "./render.js";

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

interface ProjectOptions {
  project?: string;
  tsconfig?: string;
}

const defaultIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
};

function portNumber(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new InvalidArgumentError("Port must be an integer between 0 and 65535.");
  }
  return parsed;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function webRoot(): string {
  return fileURLToPath(new URL("../studio/", import.meta.url));
}

function relativeEntrypoint(projectRoot: string, entrypoint: string): string {
  const absolute = path.isAbsolute(entrypoint) ? entrypoint : path.resolve(projectRoot, entrypoint);
  const relative = path.relative(projectRoot, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AnalysisError("ENTRYPOINT_INVALID", "Entrypoint must stay inside the project root.");
  }
  return relative.split(path.sep).join("/");
}

function analysisInput(entry: string, options: ProjectOptions) {
  const projectRoot = path.resolve(options.project ?? process.cwd());
  const entrypoint = relativeEntrypoint(projectRoot, entry);
  const discovery = discoverProject({ projectRoot, entrypoint });
  const tsconfigPath = options.tsconfig ?? discovery.selectedTsconfig;
  if (!tsconfigPath) {
    const detail = discovery.tsconfigs.length
      ? `Candidates: ${discovery.tsconfigs.join(", ")}`
      : "No tsconfig files were found.";
    throw new AnalysisError(
      discovery.ambiguous ? "TSCONFIG_AMBIGUOUS" : "TSCONFIG_NOT_FOUND",
      `CodeLift could not choose a TypeScript configuration. ${detail}`,
    );
  }
  return { projectRoot, tsconfigPath, entrypoint };
}

function launchTarget(input: string | undefined, options: { project?: string; entry?: string }) {
  let projectRoot = path.resolve(options.project ?? process.cwd());
  let entrypoint = options.entry;
  if (input) {
    const candidate = path.isAbsolute(input) ? input : path.resolve(projectRoot, input);
    if (!fs.existsSync(candidate))
      throw new AnalysisError("PROJECT_PATH_NOT_FOUND", `Path does not exist: ${candidate}`);
    if (fs.statSync(candidate).isDirectory()) projectRoot = candidate;
    else entrypoint = relativeEntrypoint(projectRoot, candidate);
  }
  if (entrypoint) entrypoint = relativeEntrypoint(projectRoot, entrypoint);
  const discovery = discoverProject({ projectRoot, ...(entrypoint ? { entrypoint } : {}) });
  return {
    projectRoot: discovery.projectRoot,
    entrypoint: discovery.entrypoint ?? entrypoint,
    selectedTsconfig: discovery.selectedTsconfig,
  };
}

async function launchStudio(
  input: string | undefined,
  options: {
    project?: string;
    tsconfig?: string;
    entry?: string;
    port: number;
    open: boolean;
  },
  io: CliIo,
): Promise<void> {
  const target = launchTarget(input, options);
  const selectedTsconfig = options.tsconfig ?? target.selectedTsconfig;
  const server = await startStudioServer({
    projectRoot: target.projectRoot,
    port: options.port,
    webRoot: webRoot(),
    ...(selectedTsconfig ? { tsconfigPath: selectedTsconfig } : {}),
    ...(target.entrypoint ? { entrypoint: target.entrypoint } : {}),
  });
  io.stdout(`CodeLift Studio is running at ${server.url}\n`);
  io.stdout(`Project: ${target.projectRoot}\n`);
  io.stdout("Press Ctrl+C to stop.\n");
  if (options.open) openBrowser(server.url);
  const close = async () => server.app.close();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function defaultPackageName(entrypoint: string): string {
  const base = path.basename(entrypoint).replace(/\.(?:mts|tsx|ts)$/u, "");
  return base
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .toLowerCase();
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let resultCode = 0;
  const program = new Command();
  program.enablePositionalOptions();
  program
    .name("codelift")
    .description("Analyze and extract a TypeScript or React module into a standalone package.")
    .version("0.4.0-beta.0")
    .argument("[path]", "project directory or TypeScript entrypoint")
    .option("--project <path>", "project root; defaults to the current directory")
    .option("--tsconfig <path>", "initial TypeScript configuration")
    .option("--entry <path>", "initial entrypoint")
    .option("--port <number>", "loopback port; use 0 for an available port", portNumber, 0)
    .option("--no-open", "do not open the browser automatically")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .action(
      async (
        input: string | undefined,
        options: {
          project?: string;
          tsconfig?: string;
          entry?: string;
          port: number;
          open: boolean;
        },
      ) => {
        await launchStudio(input, options, io);
      },
    );

  program
    .command("inspect")
    .description("Analyze one entrypoint without modifying the source project.")
    .argument("<entry>", "entrypoint relative to the current project")
    .option("--project <path>", "project root; defaults to the current directory")
    .option("--tsconfig <path>", "TypeScript configuration; discovered when omitted")
    .option("--format <format>", "pretty or json", "pretty")
    .action(async (entry: string, options: ProjectOptions & { format: string }) => {
      if (!new Set(["pretty", "json"]).has(options.format)) {
        throw new AnalysisError("FORMAT_INVALID", `Unknown output format: ${options.format}`);
      }
      const result = await analyzeProject(analysisInput(entry, options));
      io.stdout(options.format === "json" ? renderJson(result) : renderPretty(result));
      resultCode = result.issues.some((issue) => issue.blocking) ? 1 : 0;
    });

  program
    .command("studio")
    .description("Start Studio; the current directory is used when project is omitted.")
    .argument("[path]", "project directory or TypeScript entrypoint")
    .option("--project <path>", "project root")
    .option("--tsconfig <path>", "initial TypeScript configuration")
    .option("--entry <path>", "initial entrypoint")
    .option("--port <number>", "loopback port", portNumber, 0)
    .option("--no-open", "do not open the browser automatically")
    .action(
      async (
        input: string | undefined,
        options: {
          project?: string;
          tsconfig?: string;
          entry?: string;
          port: number;
          open: boolean;
        },
      ) => launchStudio(input, options, io),
    );

  program
    .command("plan")
    .description("Create a versioned extraction plan.")
    .argument("<entry>", "entrypoint relative to the current project")
    .option("--project <path>", "project root; defaults to the current directory")
    .option("--tsconfig <path>", "TypeScript configuration; discovered when omitted")
    .option("--name <name>", "target package name")
    .requiredOption("--out <path>", "new package destination")
    .option("--save <path>", "plan output path", "codelift.plan.json")
    .option("--accept-warnings", "accept non-blocking analysis warnings")
    .option("--copy-license", "copy the source LICENSE into the new private package")
    .action(
      async (
        entry: string,
        options: ProjectOptions & {
          name?: string;
          out: string;
          save: string;
          acceptWarnings?: boolean;
          copyLicense?: boolean;
        },
      ) => {
        const input = analysisInput(entry, options);
        const request = {
          ...input,
          packageName: options.name ?? defaultPackageName(input.entrypoint),
          destination: options.out,
          copyLicense: options.copyLicense ?? false,
        };
        let plan = await createExtractionPlan(request);
        if (options.acceptWarnings && plan.status === "review") {
          plan = await createExtractionPlan({
            ...request,
            acceptedWarningIds: plan.issues
              .filter((issue) => !issue.blocking)
              .map((issue) => issue.id),
          });
        }
        const output = path.resolve(options.save);
        fs.writeFileSync(output, serializeExtractionPlan(plan));
        io.stdout(`Extraction plan (${plan.status}) written to ${output}\n`);
        resultCode = plan.status === "ready" ? 0 : 1;
      },
    );

  program
    .command("extract")
    .description("Create a standalone package from a reviewed plan.")
    .requiredOption("--plan <path>", "extraction plan JSON")
    .action(async (options: { plan: string }) => {
      const plan = JSON.parse(
        fs.readFileSync(path.resolve(options.plan), "utf8"),
      ) as ExtractionPlan;
      if (plan.status !== "ready") {
        io.stderr(`Plan status is ${plan.status}; export was not started.\n`);
        resultCode = 1;
        return;
      }
      const result = await exportPackage(plan);
      io.stdout(`Package exported to ${result.destination}\n`);
    });

  program
    .command("verify")
    .description("Verify an exported package in an isolated temporary directory.")
    .argument("<package>", "exported package directory")
    .option("--install", "install dependencies before build verification")
    .option("--allow-install-scripts", "allow dependency lifecycle scripts during npm install")
    .option("--format <format>", "pretty or json", "pretty")
    .action(
      async (
        packageRoot: string,
        options: { install?: boolean; allowInstallScripts?: boolean; format: string },
      ) => {
        if (options.install) {
          const installCommand = options.allowInstallScripts
            ? "npm install --no-audit --no-fund"
            : "npm install --ignore-scripts --no-audit --no-fund";
          io.stdout(`Isolated install command: ${installCommand}\n`);
        }
        const result = await verifyPackage({
          packageRoot,
          install: options.install ?? false,
          allowInstallScripts: options.allowInstallScripts ?? false,
        });
        if (options.format === "json") io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        else {
          io.stdout(`CodeLift verification — ${result.status}\n`);
          for (const item of result.checks)
            io.stdout(`  ${item.status.padEnd(11)} ${item.label}\n`);
        }
        resultCode = result.status === "failed" || result.status === "cancelled" ? 1 : 0;
      },
    );

  try {
    await program.parseAsync(["node", "codelift", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      return 2;
    }
    const message =
      error instanceof AnalysisError ? `${error.code}: ${error.message}` : String(error);
    io.stderr(`${message}\n`);
    return 2;
  }
  return resultCode;
}

export { renderJson, renderPretty } from "./render.js";
