import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProject } from "@codelift/core";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioServer, type StudioServer } from "../src/index.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const projectRoot = path.join(workspaceRoot, "fixtures/node-esm-basic");
const servers: StudioServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

async function studio(): Promise<StudioServer> {
  const server = await createStudioServer({
    projectRoot,
    tsconfigPath: "tsconfig.json",
    entrypoint: "src/index.ts",
    webRoot: path.join(workspaceRoot, "does-not-exist"),
    token: "test-token",
  });
  servers.push(server);
  return server;
}

describe("Studio server", () => {
  it("requires a session token", async () => {
    const server = await studio();
    const response = await server.app.inject({ method: "GET", url: "/api/session" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects cross-origin API calls", async () => {
    const server = await studio();
    const response = await server.app.inject({
      method: "GET",
      url: "/api/session",
      headers: {
        host: "127.0.0.1:4317",
        origin: "https://malicious.example",
        "x-codelift-token": server.token,
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns the same analysis contract as the core engine", async () => {
    const server = await studio();
    const response = await server.app.inject({
      method: "POST",
      url: "/api/analyze",
      headers: { "x-codelift-token": server.token },
      payload: { tsconfigPath: "tsconfig.json", entrypoint: "src/index.ts" },
    });
    const apiResult = response.json();
    const coreResult = await analyzeProject({
      projectRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });

    expect(response.statusCode).toBe(200);
    expect(apiResult.nodes).toEqual(coreResult.nodes);
    expect(apiResult.edges).toEqual(coreResult.edges);
    expect(apiResult.issues).toEqual(coreResult.issues);
  });

  it("allows source preview only inside the project root", async () => {
    const server = await studio();
    const allowed = await server.app.inject({
      method: "GET",
      url: "/api/source?path=src/index.ts",
      headers: { "x-codelift-token": server.token },
    });
    const denied = await server.app.inject({
      method: "GET",
      url: "/api/source?path=../../CodeLift.md",
      headers: { "x-codelift-token": server.token },
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().content).toContain("renderInvoice");
    expect(denied.statusCode).toBe(400);
  });

  it("binds plan, export, and verify jobs to the active Studio session", async () => {
    const server = await studio();
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-studio-"));
    temporaryDirectories.push(temporaryRoot);
    const destination = path.join(temporaryRoot, "invoice-kit");
    const headers = { "x-codelift-token": server.token };
    const planRequest = {
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
      packageName: "invoice-kit",
      destination,
    };
    const firstPlan = await server.app.inject({
      method: "POST",
      url: "/api/plan",
      headers,
      payload: planRequest,
    });
    expect(firstPlan.statusCode).toBe(200);
    const warningIds = firstPlan
      .json()
      .plan.issues.filter((issue: { blocking: boolean }) => !issue.blocking)
      .map((issue: { id: string }) => issue.id);
    const readyPlan = await server.app.inject({
      method: "POST",
      url: "/api/plan",
      headers,
      payload: { ...planRequest, acceptedWarningIds: warningIds },
    });
    const { planId, plan } = readyPlan.json();
    expect(plan.status).toBe("ready");

    const denied = await server.app.inject({
      method: "POST",
      url: "/api/export",
      headers,
      payload: { planId, confirmation: "wrong-name" },
    });
    expect(denied.statusCode).toBe(400);

    const started = await server.app.inject({
      method: "POST",
      url: "/api/export",
      headers,
      payload: { planId, confirmation: "invoice-kit" },
    });
    expect(started.statusCode).toBe(202);
    const jobId = started.json().jobId as string;
    let exportJob: { status: string } = { status: "running" };
    for (let attempt = 0; attempt < 20 && exportJob.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      exportJob = (
        await server.app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers })
      ).json();
    }
    expect(exportJob.status).toBe("completed");
    expect(fs.existsSync(path.join(destination, "package.json"))).toBe(true);

    const verification = await server.app.inject({
      method: "POST",
      url: "/api/verify",
      headers,
      payload: { packageRoot: destination, install: false },
    });
    expect(verification.statusCode).toBe(202);
  });

  it("reuses analysis results and invalidates the compiler cache after a source change", async () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-studio-cache-"));
    temporaryDirectories.push(temporaryRoot);
    const copiedProject = path.join(temporaryRoot, "project");
    fs.cpSync(path.join(workspaceRoot, "fixtures/node-library"), copiedProject, {
      recursive: true,
    });
    const server = await createStudioServer({
      projectRoot: copiedProject,
      webRoot: path.join(workspaceRoot, "does-not-exist"),
      token: "cache-token",
    });
    servers.push(server);
    const request = {
      method: "POST" as const,
      url: "/api/analyze",
      headers: { "x-codelift-token": server.token },
      payload: { tsconfigPath: "tsconfig.json", entrypoint: "src/index.ts" },
    };

    const first = (await server.app.inject(request)).json();
    const cached = (await server.app.inject(request)).json();
    expect(cached).toEqual(first);

    fs.appendFileSync(
      path.join(copiedProject, "src/normalize.ts"),
      '\nexport const locale = process.env.CODELIFT_LOCALE ?? "en";\n',
    );
    const changed = (await server.app.inject(request)).json();
    expect(changed.issues.some((issue: { code: string }) => issue.code === "CL008")).toBe(true);
  });
});
