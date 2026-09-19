import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

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
  it("prints the supported fixture and exits successfully", async () => {
    const stream = capture();
    const code = await runCli(
      [
        "inspect",
        "src/index.ts",
        "--project",
        path.join(workspaceRoot, "fixtures/node-esm-basic"),
        "--tsconfig",
        "tsconfig.json",
      ],
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
    expect(result.schemaVersion).toBe(1);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("returns two for invalid invocation paths", async () => {
    const stream = capture();
    const code = await runCli(
      ["inspect", "missing.ts", "--project", workspaceRoot, "--tsconfig", "missing.json"],
      stream.io,
    );

    expect(code).toBe(2);
    expect(stream.output().stderr).toContain("PROJECT_PATH_NOT_FOUND");
  });
});
