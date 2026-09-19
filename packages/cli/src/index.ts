import { spawn } from "node:child_process";
import path from "node:path";
import { AnalysisError, analyzeProject } from "@codelift/core";
import { startStudioServer } from "@codelift/studio-server";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { renderJson, renderPretty } from "./render.js";

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
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

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let resultCode = 0;
  const program = new Command();
  program
    .name("codelift")
    .description("Explain the dependencies required to lift a TypeScript module into a library.")
    .version("0.1.0")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr,
    });

  program
    .command("inspect")
    .description("Analyze one TypeScript entrypoint without modifying the source project.")
    .argument("<entry>", "entrypoint relative to the project root")
    .requiredOption("--project <path>", "project root")
    .requiredOption("--tsconfig <path>", "tsconfig relative to the project root")
    .option("--format <format>", "pretty or json", "pretty")
    .action(
      async (entry: string, options: { project: string; tsconfig: string; format: string }) => {
        if (!new Set(["pretty", "json"]).has(options.format)) {
          io.stderr(`Unknown output format: ${options.format}\n`);
          resultCode = 2;
          return;
        }
        try {
          const result = await analyzeProject({
            projectRoot: path.resolve(options.project),
            tsconfigPath: options.tsconfig,
            entrypoint: entry,
          });
          io.stdout(options.format === "json" ? renderJson(result) : renderPretty(result));
          resultCode = result.issues.some((issue) => issue.blocking) ? 1 : 0;
        } catch (error) {
          const message =
            error instanceof AnalysisError ? `${error.code}: ${error.message}` : String(error);
          io.stderr(`${message}\n`);
          resultCode = 2;
        }
      },
    );

  program
    .command("studio")
    .description("Start the local CodeLift Studio on a loopback address.")
    .requiredOption("--project <path>", "project root")
    .option("--tsconfig <path>", "initial tsconfig")
    .option("--entry <path>", "initial entrypoint")
    .option("--port <number>", "loopback port; use 0 for an available port", portNumber, 0)
    .option("--no-open", "do not open the browser automatically")
    .action(
      async (options: {
        project: string;
        tsconfig?: string;
        entry?: string;
        port: number;
        open: boolean;
      }) => {
        try {
          const server = await startStudioServer({
            projectRoot: path.resolve(options.project),
            port: options.port,
            ...(options.tsconfig ? { tsconfigPath: options.tsconfig } : {}),
            ...(options.entry ? { entrypoint: options.entry } : {}),
          });
          io.stdout(`CodeLift Studio is running at ${server.url}\n`);
          io.stdout("Press Ctrl+C to stop.\n");
          if (options.open) openBrowser(server.url);
          const close = async () => {
            await server.app.close();
          };
          process.once("SIGINT", close);
          process.once("SIGTERM", close);
        } catch (error) {
          io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
          resultCode = 2;
        }
      },
    );

  try {
    await program.parseAsync(["node", "codelift", ...argv], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return 0;
      return 2;
    }
    throw error;
  }
  return resultCode;
}

export { renderJson, renderPretty } from "./render.js";
