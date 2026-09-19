import { startStudioServer } from "./server.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectRoot = argument("project") ?? process.cwd();
const port = Number.parseInt(argument("port") ?? "4317", 10);
const token = argument("token");
const tsconfigPath = argument("tsconfig");
const entrypoint = argument("entry");

const server = await startStudioServer({
  projectRoot,
  port,
  ...(tsconfigPath ? { tsconfigPath } : {}),
  ...(entrypoint ? { entrypoint } : {}),
  ...(token ? { token } : {}),
});

console.log(`CodeLift Studio: ${server.url}`);

const shutdown = async () => {
  await server.app.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
