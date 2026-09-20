import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisError,
  type AnalysisResult,
  analyzeProject,
  createExtractionPlan,
  type DependencyClassification,
  discoverProject,
  type ExportResult,
  type ExtractionPlan,
  exportPackage,
  isInsideRoot,
  normalizeRelativePath,
  TypeScriptCompilerAdapter,
  type VerificationResult,
  verifyPackage,
} from "@codelift/core";
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

type JobType = "export" | "verify";
type JobStatus = "running" | "completed" | "failed" | "cancelled";

interface StudioJob {
  id: string;
  type: JobType;
  status: JobStatus;
  message: string;
  createdAt: string;
  planDigest?: string;
  destination?: string;
  result?: ExportResult | VerificationResult;
  error?: string;
  controller: AbortController;
}

function publicJob(job: StudioJob) {
  const { controller: _controller, ...result } = job;
  return result;
}

function realDirectory(candidate: string): string {
  const real = fs.realpathSync.native(path.resolve(candidate));
  if (!fs.statSync(real).isDirectory()) {
    throw new Error(`Project root is not a directory: ${candidate}`);
  }
  return real;
}

function safeExistingPath(projectRoot: string, candidate: string): string {
  const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
  const real = fs.realpathSync.native(absolute);
  if (!isInsideRoot(projectRoot, real)) {
    throw new AnalysisError("PATH_OUTSIDE_PROJECT", "Path is outside the Studio project root.");
  }
  return real;
}

function optionalRelativePath(projectRoot: string, candidate?: string): string | undefined {
  if (!candidate) return undefined;
  return normalizeRelativePath(projectRoot, safeExistingPath(projectRoot, candidate));
}

function defaultWebRoot(): string {
  return fileURLToPath(new URL("../../../apps/studio/dist/", import.meta.url));
}

function contentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".ico": "image/x-icon",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".map": "application/json; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[extension] ?? "application/octet-stream"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectFingerprint(projectRoot: string): string {
  const hash = createHash("sha256");
  const excluded = new Set([
    ".git",
    ".next",
    ".turbo",
    "build",
    "coverage",
    "dist",
    "node_modules",
  ]);
  const relevant = /\.(?:avif|css|gif|ico|jpe?g|json|mts|otf|png|svg|ts|tsx|ttf|webp|woff2?)$/u;
  const visit = (directory: string) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink() || excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        entry.isFile() &&
        (relevant.test(entry.name) ||
          new Set([
            "bun.lock",
            "package-lock.json",
            "package.json",
            "pnpm-lock.yaml",
            "yarn.lock",
          ]).has(entry.name))
      ) {
        hash.update(normalizeRelativePath(projectRoot, absolute)).update("\0");
        hash.update(fs.readFileSync(absolute)).update("\0");
      }
    }
  };
  visit(projectRoot);
  return hash.digest("hex");
}

export async function createStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const projectRoot = realDirectory(options.projectRoot);
  const token = options.token ?? randomUUID();
  const initialTsconfig = optionalRelativePath(projectRoot, options.tsconfigPath);
  const initialEntrypoint = optionalRelativePath(projectRoot, options.entrypoint);
  const app = Fastify({ logger: false });
  const plans = new Map<string, ExtractionPlan>();
  const jobs = new Map<string, StudioJob>();
  const exportedDestinations = new Set<string>();
  let compilerAdapter = new TypeScriptCompilerAdapter();
  let compilerFingerprint = "";
  const analysisCache = new Map<string, AnalysisResult>();

  const analyze = async (tsconfigPath: string, entrypoint: string) => {
    const fingerprint = projectFingerprint(projectRoot);
    if (fingerprint !== compilerFingerprint) {
      compilerFingerprint = fingerprint;
      compilerAdapter = new TypeScriptCompilerAdapter();
      analysisCache.clear();
    }
    const cacheKey = `${tsconfigPath}\0${entrypoint}`;
    const cached = analysisCache.get(cacheKey);
    if (cached) return cached;
    const result = await analyzeProject({ projectRoot, tsconfigPath, entrypoint }, undefined, {
      compilerAdapter,
    });
    analysisCache.set(cacheKey, result);
    return result;
  };

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
    const discovered = discoverProject({
      projectRoot,
      ...(initialEntrypoint ? { entrypoint: initialEntrypoint } : {}),
    });
    return {
      projectName: path.basename(projectRoot),
      projectRoot,
      tsconfigs: discovered.tsconfigs,
      sourceFiles: discovered.sourceFiles,
      initialTsconfig: initialTsconfig ?? discovered.selectedTsconfig,
      initialEntrypoint: initialEntrypoint ?? discovered.entrypoint,
      ambiguousTsconfig: discovered.ambiguous,
      capabilities: {
        profiles: ["node-esm", "react-library"],
        sourcePreview: true,
        extraction: true,
        verification: true,
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
        return await analyze(tsconfigPath, entrypoint);
      } catch (error) {
        if (error instanceof AnalysisError) {
          return reply.code(400).send({ error: error.message, code: error.code });
        }
        throw error;
      }
    },
  );

  app.post<{
    Body: {
      tsconfigPath?: string;
      entrypoint?: string;
      packageName?: string;
      destination?: string;
      acceptedWarningIds?: string[];
      copyLicense?: boolean;
      dependencyOverrides?: Record<string, DependencyClassification>;
    };
  }>("/api/plan", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.tsconfigPath || !body.entrypoint || !body.packageName || !body.destination) {
      return reply.code(400).send({
        error: "tsconfigPath, entrypoint, packageName, and destination are required.",
      });
    }
    try {
      safeExistingPath(projectRoot, body.tsconfigPath);
      safeExistingPath(projectRoot, body.entrypoint);
      const plan = await createExtractionPlan({
        projectRoot,
        tsconfigPath: body.tsconfigPath,
        entrypoint: body.entrypoint,
        packageName: body.packageName,
        destination: body.destination,
        ...(body.acceptedWarningIds ? { acceptedWarningIds: body.acceptedWarningIds } : {}),
        ...(body.copyLicense !== undefined ? { copyLicense: body.copyLicense } : {}),
        ...(body.dependencyOverrides ? { dependencyOverrides: body.dependencyOverrides } : {}),
      });
      plans.set(plan.digest, plan);
      return { planId: plan.digest, plan };
    } catch (error) {
      if (error instanceof AnalysisError) {
        return reply.code(400).send({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.post<{ Body: { planId?: string; confirmation?: string } }>(
    "/api/export",
    async (request, reply) => {
      const { planId, confirmation } = request.body ?? {};
      const plan = planId ? plans.get(planId) : undefined;
      if (!plan)
        return reply.code(404).send({ error: "The extraction plan is unknown or expired." });
      if (confirmation !== plan.target.packageName) {
        return reply.code(400).send({ error: "Type the package name exactly to confirm export." });
      }
      const controller = new AbortController();
      const job: StudioJob = {
        id: randomUUID(),
        type: "export",
        status: "running",
        message: "Creating the package in a staging directory…",
        createdAt: new Date().toISOString(),
        planDigest: plan.digest,
        destination: plan.target.destination,
        controller,
      };
      jobs.set(job.id, job);
      void exportPackage(plan, {}, controller.signal)
        .then((result) => {
          job.result = result;
          job.status = "completed";
          job.message = "Package exported successfully.";
          exportedDestinations.add(path.resolve(result.destination));
        })
        .catch((error: unknown) => {
          job.status = controller.signal.aborted ? "cancelled" : "failed";
          job.message = controller.signal.aborted ? "Export cancelled." : "Export failed.";
          job.error = errorMessage(error);
        });
      return reply.code(202).send({ jobId: job.id, job: publicJob(job) });
    },
  );

  app.post<{
    Body: { packageRoot?: string; install?: boolean; allowInstallScripts?: boolean };
  }>("/api/verify", async (request, reply) => {
    const body = request.body ?? {};
    if (!body.packageRoot) return reply.code(400).send({ error: "packageRoot is required." });
    const packageRoot = fs.existsSync(body.packageRoot)
      ? fs.realpathSync.native(body.packageRoot)
      : path.resolve(body.packageRoot);
    if (!exportedDestinations.has(packageRoot)) {
      return reply
        .code(403)
        .send({ error: "Studio can verify only a package exported in this session." });
    }
    const controller = new AbortController();
    const job: StudioJob = {
      id: randomUUID(),
      type: "verify",
      status: "running",
      message: body.install
        ? "Installing dependencies in an isolated copy…"
        : "Running safe structural checks…",
      createdAt: new Date().toISOString(),
      destination: packageRoot,
      controller,
    };
    jobs.set(job.id, job);
    void verifyPackage(
      {
        packageRoot,
        ...(body.install !== undefined ? { install: body.install } : {}),
        ...(body.allowInstallScripts !== undefined
          ? { allowInstallScripts: body.allowInstallScripts }
          : {}),
      },
      controller.signal,
    )
      .then((result) => {
        job.result = result;
        job.status = result.status === "cancelled" ? "cancelled" : "completed";
        job.message = `Verification finished with status: ${result.status}.`;
      })
      .catch((error: unknown) => {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.message = controller.signal.aborted
          ? "Verification cancelled."
          : "Verification failed.";
        job.error = errorMessage(error);
      });
    return reply.code(202).send({ jobId: job.id, job: publicJob(job) });
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    return publicJob(job);
  });

  app.delete<{ Params: { id: string } }>("/api/jobs/:id", async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) return reply.code(404).send({ error: "Job not found." });
    if (job.status === "running") {
      job.controller.abort();
      job.status = "cancelled";
      job.message = "Cancellation requested.";
    }
    return publicJob(job);
  });

  app.get<{ Querystring: { path?: string } }>("/api/source", async (request, reply) => {
    const requestedPath = request.query.path;
    if (!requestedPath) return reply.code(400).send({ error: "path is required." });
    try {
      const absolute = safeExistingPath(projectRoot, requestedPath);
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) return reply.code(400).send({ error: "Source path is not a file." });
      if (stat.size > 1_000_000) {
        return reply.code(413).send({ error: "Source file is too large to preview." });
      }
      if (!/\.(?:css|json|md|mts|svg|ts|tsx)$/u.test(absolute)) {
        return reply.code(415).send({ error: "Binary assets cannot be previewed as source." });
      }
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
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found." });
      const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
      const requested = path.resolve(webRoot, pathname.replace(/^\/+/, ""));
      const candidate =
        isInsideRoot(webRoot, requested) &&
        fs.existsSync(requested) &&
        fs.statSync(requested).isFile()
          ? requested
          : path.join(webRoot, "index.html");
      return reply.type(contentType(candidate)).send(fs.createReadStream(candidate));
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
