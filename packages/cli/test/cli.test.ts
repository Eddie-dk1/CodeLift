import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diagnoseProject, runCli } from "../src/index.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (value: string) => {
        stdout += value;
      },
      stderr: (value: string) => {
        stderr += value;
      },
    },
    output: () => ({ stdout, stderr }),
  };
}

describe("CodeLift CLI", () => {
  it("reports a ready project through doctor pretty output", async () => {
    const stream = capture();
    const code = await runCli(
      ["doctor", path.join(workspaceRoot, "fixtures/node-library"), "--entry", "src/index.ts"],
      stream.io,
    );

    expect(code).toBe(0);
    expect(stream.output().stderr).toBe("");
    expect(stream.output().stdout).toContain("CodeLift doctor — ready");
    expect(stream.output().stdout).toContain("Profile: node-esm");
  });

  it("prints doctor schema one as JSON", async () => {
    const stream = capture();
    const code = await runCli(
      [
        "doctor",
        path.join(workspaceRoot, "fixtures/react-library"),
        "--entry",
        "src/Card.tsx",
        "--format",
        "json",
      ],
      stream.io,
    );
    const result = JSON.parse(stream.output().stdout) as {
      schemaVersion: number;
      status: string;
      project: { profile: string };
    };

    expect(code).toBe(0);
    expect(result.schemaVersion).toBe(1);
    expect(result.status).toBe("ready");
    expect(result.project.profile).toBe("react-library");
  });

  it("reports unsupported Node and missing npm without touching the project", () => {
    const result = diagnoseProject(
      {
        projectRoot: path.join(workspaceRoot, "fixtures/node-library"),
        entrypoint: "src/index.ts",
      },
      { nodeVersion: "22.14.0", npmVersion: () => null },
    );

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["NODE_UNSUPPORTED", "NPM_NOT_FOUND"]),
    );
  });

  it("reports ambiguous compiler configs", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-doctor-"));
    fs.mkdirSync(path.join(projectRoot, "src"));
    fs.writeFileSync(path.join(projectRoot, "src/index.ts"), "export const value = 1;\n");
    const config = JSON.stringify({ compilerOptions: { module: "NodeNext" }, include: ["src"] });
    fs.writeFileSync(path.join(projectRoot, "tsconfig.json"), config);
    fs.writeFileSync(path.join(projectRoot, "tsconfig.app.json"), config);

    const result = diagnoseProject(
      { projectRoot },
      { nodeVersion: "24.0.0", npmVersion: () => "11.0.0" },
    );

    expect(result.status).toBe("attention");
    expect(result.project.selectedTsconfig).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain("TSCONFIG_AMBIGUOUS");
  });

  it("returns two when doctor receives an invalid project path", async () => {
    const stream = capture();
    const code = await runCli(["doctor", path.join(workspaceRoot, "missing-project")], stream.io);

    expect(code).toBe(2);
    expect(stream.output().stderr).toContain("PROJECT_ROOT_INVALID");
  });

  it("discovers the compiler config, prints the fixture, and exits successfully", async () => {
    const stream = capture();
    const code = await runCli(
      ["inspect", "src/index.ts", "--project", path.join(workspaceRoot, "fixtures/node-esm-basic")],
      stream.io,
    );

    expect(code).toBe(0);
    expect(stream.output().stderr).toBe("");
    expect(stream.output().stdout).toContain("CodeLift analysis");
    expect(stream.output().stdout).toContain("External packages");
  });

  it("returns one when blocking analysis issues are found", async () => {
    const stream = capture();
    const code = await runCli(
      [
        "inspect",
        "src/index.ts",
        "--project",
        path.join(workspaceRoot, "fixtures/node-esm-issues"),
        "--tsconfig",
        "tsconfig.json",
        "--format",
        "json",
      ],
      stream.io,
    );

    expect(code).toBe(1);
    const result = JSON.parse(stream.output().stdout) as {
      schemaVersion: number;
      issues: unknown[];
    };
    expect(result.schemaVersion).toBe(2);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("returns two for invalid invocation paths", async () => {
    const stream = capture();
    const code = await runCli(
      ["inspect", "missing.ts", "--project", workspaceRoot, "--tsconfig", "missing.json"],
      stream.io,
    );

    expect(code).toBe(2);
    expect(stream.output().stderr).toContain("ENTRYPOINT_INVALID");
  });
});
