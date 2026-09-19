import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProject } from "@codelift/core";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioServer, type StudioServer } from "../src/index.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const projectRoot = path.join(workspaceRoot, "fixtures/node-esm-basic");
const servers: StudioServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.app.close();
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
});
