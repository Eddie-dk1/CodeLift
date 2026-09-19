import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisError, analyzeProject, isInsideRoot, normalizeRelativePath } from "@codelift/core";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

export interface StudioServerOptions {
  projectRoot: string;
  tsconfigPath?: string;
  entrypoint?: string;
  port?: number;
  host?: "127.0.0.1" | "::1";
  openBrowser?: boolean;
  webRoot?: string;
  token?: string;
}

export interface StudioServer {
  app: FastifyInstance;
  token: string;
  projectRoot: string;
  initialTsconfig?: string;
  initialEntrypoint?: string;
}

export interface RunningStudioServer extends StudioServer {
  port: number;
  url: string;
}

function realDirectory(candidate: string): string {
  const real = fs.realpathSync.native(path.resolve(candidate));
  if (!fs.statSync(real).isDirectory())
    throw new Error(`Project root is not a directory: ${candidate}`);
  return real;
}

function safeExistingPath(projectRoot: string, candidate: string): string {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
  const real = fs.realpathSync.native(absolute);
  if (!isInsideRoot(projectRoot, real))
    throw new AnalysisError("PATH_OUTSIDE_PROJECT", "Path is outside the Studio project root.");
  return real;
}

function optionalRelativePath(projectRoot: string, candidate?: string): string | undefined {
  if (!candidate) return undefined;
  return normalizeRelativePath(projectRoot, safeExistingPath(projectRoot, candidate));
}

function discoverFiles(projectRoot: string): { sourceFiles: string[]; tsconfigs: string[] } {
  const sourceFiles: string[] = [];
  const tsconfigs: string[] = [];
  const excluded = new Set([".git", "node_modules", "dist", "build", "coverage"]);

  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = normalizeRelativePath(projectRoot, absolute);
      if (/^tsconfig(?:\.[\w-]+)?\.json$/u.test(entry.name)) tsconfigs.push(relative);
      if (
        (entry.name.endsWith(".ts") || entry.name.endsWith(".mts")) &&
        !entry.name.endsWith(".d.ts")
      ) {
        sourceFiles.push(relative);
      }
    }
  };

  visit(projectRoot);
  return { sourceFiles: sourceFiles.sort(), tsconfigs: tsconfigs.sort() };
}

function defaultWebRoot(): string {
  return fileURLToPath(new URL("../../../apps/studio/dist/", import.meta.url));
}

export async function createStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const projectRoot = realDirectory(options.projectRoot);
  const token = options.token ?? randomUUID();
  const initialTsconfig = optionalRelativePath(projectRoot, options.tsconfigPath);
  const initialEntrypoint = optionalRelativePath(projectRoot, options.entrypoint);
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.headers["x-codelift-token"] !== token) {
      return reply.code(401).send({ error: "A valid CodeLift session token is required." });
    }
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin && host && origin !== `http://${host}` && origin !== `https://${host}`) {
      return reply.code(403).send({ error: "Cross-origin Studio requests are not allowed." });
    }
  });

  app.get("/api/session", async () => {
    const discovered = discoverFiles(projectRoot);
    return {
      projectName: path.basename(projectRoot),
      projectRoot,
      tsconfigs: discovered.tsconfigs,
      sourceFiles: discovered.sourceFiles,
      initialTsconfig: initialTsconfig ?? discovered.tsconfigs[0] ?? null,
      initialEntrypoint: initialEntrypoint ?? null,
      capabilities: {
        profile: "node-esm",
        sourcePreview: true,
        extraction: false,
      },
    };
  });

  app.post<{ Body: { tsconfigPath?: string; entrypoint?: string } }>(
    "/api/analyze",
    async (request, reply) => {
      const { tsconfigPath, entrypoint } = request.body ?? {};
      if (!tsconfigPath || !entrypoint) {
        return reply.code(400).send({ error: "tsconfigPath and entrypoint are required." });
      }
      try {
        safeExistingPath(projectRoot, tsconfigPath);
        safeExistingPath(projectRoot, entrypoint);
        return await analyzeProject({ projectRoot, tsconfigPath, entrypoint });
      } catch (error) {
        if (error instanceof AnalysisError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );

  app.get<{ Querystring: { path?: string } }>("/api/source", async (request, reply) => {
    const requestedPath = request.query.path;
    if (!requestedPath) return reply.code(400).send({ error: "path is required." });
    try {
      const absolute = safeExistingPath(projectRoot, requestedPath);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return reply.code(400).send({ error: "Source path is not a file." });
      if (stat.size > 1_000_000)
        return reply.code(413).send({ error: "Source file is too large to preview." });
      return {
        path: normalizeRelativePath(projectRoot, absolute),
        content: fs.readFileSync(absolute, "utf8"),
      };
    } catch (error) {
      if (error instanceof AnalysisError || (error instanceof Error && "code" in error)) {
        return reply
          .code(400)
          .send({ error: "Source path is unavailable or outside the project root." });
      }
      throw error;
    }
  });

  const webRoot = options.webRoot ?? defaultWebRoot();
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      name: "CodeLift Studio API",
      message: "Build apps/studio to serve the interface.",
    }));
  }

  return {
    app,
    token,
    projectRoot,
    ...(initialTsconfig ? { initialTsconfig } : {}),
    ...(initialEntrypoint ? { initialEntrypoint } : {}),
  };
}

export async function startStudioServer(
  options: StudioServerOptions,
): Promise<RunningStudioServer> {
  const studio = await createStudioServer(options);
  const host = options.host ?? "127.0.0.1";
  const address = await studio.app.listen({ host, port: options.port ?? 0 });
  const parsed = new URL(address);
  const port = Number.parseInt(parsed.port, 10);
  const url = `http://${host}:${port}/#token=${encodeURIComponent(studio.token)}`;
  return { ...studio, port, url };
}
