import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const suppliedTarball = process.argv[2];
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-export-smoke-"));
process.env.npm_config_cache = path.join(temporaryRoot, "npm-cache");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const cases = [
  {
    fixture: "node-library",
    entrypoint: "src/index.ts",
    packageName: "codelift-smoke-node",
    expectedStatus: "passed",
  },
  {
    fixture: "alias-no-baseurl",
    entrypoint: "src/index.ts",
    packageName: "codelift-smoke-alias-bundler",
    expectedStatus: "passed",
  },
  {
    fixture: "react-library",
    entrypoint: "src/Card.tsx",
    packageName: "codelift-smoke-react",
    expectedStatus: "passed",
    expectedRender: "passed",
  },
  {
    fixture: "react-library",
    entrypoint: "src/NeedsProps.tsx",
    packageName: "codelift-smoke-react-props",
    expectedStatus: "unsupported",
    expectedRender: "unsupported",
  },
  {
    fixture: "react-library",
    entrypoint: "src/math.ts",
    packageName: "codelift-smoke-pure-ts",
    expectedStatus: "passed",
  },
  {
    fixture: "react-library",
    entrypoint: "src/ReactTypes.ts",
    packageName: "codelift-smoke-react-types",
    expectedStatus: "passed",
  },
  {
    fixture: "react-library",
    entrypoint: "src/StyleOnly.ts",
    packageName: "codelift-smoke-style-only",
    expectedStatus: "passed",
  },
  {
    fixture: "react-library",
    entrypoint: "src/Query.tsx",
    packageName: "codelift-smoke-resource-query",
    expectedStatus: "passed",
    expectedRender: "passed",
  },
];

function digestDirectory(root) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        hash.update(path.relative(root, absolute));
        hash.update("\0");
        hash.update(fs.readFileSync(absolute));
        hash.update("\0");
      } else {
        throw new Error(`Unsupported fixture entry: ${absolute}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    ...(process.platform === "win32" && command === npm ? { shell: true } : {}),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit ${result.status}:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function parseJsonOutput(output) {
  const start = output.indexOf("{");
  assert.ok(start >= 0, `Expected JSON output, received:\n${output}`);
  return JSON.parse(output.slice(start));
}

try {
  const tarball = suppliedTarball
    ? path.resolve(suppliedTarball)
    : path.join(
        temporaryRoot,
        run(
          npm,
          ["pack", "--silent", "--pack-destination", temporaryRoot],
          path.join(workspaceRoot, "packages", "cli"),
        ).trim(),
      );
  assert.ok(fs.existsSync(tarball), `CLI tarball does not exist: ${tarball}`);
  const toolRoot = path.join(temporaryRoot, "tool");
  fs.mkdirSync(toolRoot);
  fs.writeFileSync(path.join(toolRoot, "package.json"), '{"private":true,"type":"module"}\n');
  run(npm, ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], toolRoot);
  const cli = path.join(toolRoot, "node_modules", "codelift-cli", "dist", "bin.js");
  assert.ok(fs.existsSync(cli), "The packed CLI did not install its executable.");
  assert.equal(
    fs.existsSync(
      path.join(toolRoot, "node_modules", "codelift-cli", "dist", "studio-server", "dev.js"),
    ),
    false,
    "The packed CLI must not contain its development-only Studio launcher.",
  );

  for (const item of cases) {
    const fixtureRoot = path.join(workspaceRoot, "fixtures", item.fixture);
    const before = digestDirectory(fixtureRoot);
    const caseRoot = path.join(temporaryRoot, item.packageName);
    const destination = path.join(caseRoot, item.packageName);
    const planPath = path.join(caseRoot, "plan.json");
    fs.mkdirSync(caseRoot);

    const analysis = parseJsonOutput(
      run(
        process.execPath,
        [cli, "inspect", item.entrypoint, "--project", fixtureRoot, "--format", "json"],
        caseRoot,
      ),
    );
    assert.equal(analysis.entrypoint, item.entrypoint);
    assert.equal(analysis.issues.filter((issue) => issue.blocking).length, 0);

    run(
      process.execPath,
      [
        cli,
        "plan",
        item.entrypoint,
        "--project",
        fixtureRoot,
        "--name",
        item.packageName,
        "--out",
        destination,
        "--save",
        planPath,
        "--accept-warnings",
      ],
      caseRoot,
    );
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    assert.equal(plan.status, "ready");
    if (item.entrypoint === "src/math.ts" || item.entrypoint === "src/ReactTypes.ts") {
      assert.equal(plan.target.profile, "node-esm");
      assert.equal(plan.expectedFiles.includes("vite.config.ts"), false);
      if (item.entrypoint === "src/math.ts") {
        assert.equal(
          plan.dependencyDecisions.some((decision) => decision.name === "react"),
          false,
        );
      }
    }
    if (item.entrypoint === "src/StyleOnly.ts") {
      assert.equal(plan.target.profile, "vite-library");
      assert.equal(
        plan.dependencyDecisions.some((decision) => decision.name === "react"),
        false,
      );
    }
    run(process.execPath, [cli, "extract", "--plan", planPath], caseRoot);
    assert.ok(fs.existsSync(path.join(destination, "codelift-report.json")));

    const verification = parseJsonOutput(
      run(
        process.execPath,
        [cli, "verify", destination, "--install", "--format", "json"],
        caseRoot,
      ),
    );
    assert.equal(
      verification.status,
      item.expectedStatus,
      `${item.fixture} verification failed: ${JSON.stringify(verification.checks, null, 2)}`,
    );
    for (const id of [
      "manifest",
      "source-boundary",
      "file-manifest",
      "imports",
      "install",
      "build",
      "smoke",
    ]) {
      assert.equal(
        verification.checks.find((check) => check.id === id)?.status,
        "passed",
        `${item.fixture}: ${id} did not pass`,
      );
    }
    assert.equal(
      verification.checks.find((check) => check.id === "react-render")?.status,
      item.expectedRender,
      `${item.packageName}: unexpected React render result`,
    );
    assert.equal(digestDirectory(fixtureRoot), before, `${item.fixture} source fixture changed`);
    process.stdout.write(
      `${item.packageName}: install/build/import passed; verify ${item.expectedStatus}\n`,
    );
  }
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
