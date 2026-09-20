import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeProject } from "./analyze.js";
import { AnalysisError } from "./errors.js";
import type {
  ExtractionPlan,
  VerificationCheck,
  VerificationRequest,
  VerificationResult,
} from "./workflow-types.js";
import { stableJson } from "./workflow-utils.js";

interface ExportReport {
  schemaVersion: number;
  status: string;
  plan: ExtractionPlan;
  verification: VerificationResult | null;
}

function check(
  id: string,
  label: string,
  status: VerificationCheck["status"],
  detail?: string,
  output?: string,
): VerificationCheck {
  return { id, label, status, ...(detail ? { detail } : {}), ...(output ? { output } : {}) };
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  visit(root);
  return result.sort();
}

function textFilesContain(root: string, needle: string): string[] {
  const matches: string[] = [];
  for (const relative of listFiles(root)) {
    if (relative === "codelift-report.json") continue;
    if (!/\.(?:css|json|md|mjs|ts|tsx)$/u.test(relative)) continue;
    const content = fs.readFileSync(path.join(root, relative), "utf8");
    if (content.includes(needle)) matches.push(relative);
  }
  return matches;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.NODE_PATH;
    delete environment.INIT_CWD;
    const child = spawn(command, args, {
      cwd,
      env: environment,
      shell: false,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-40_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function readReport(packageRoot: string): ExportReport {
  const reportPath = path.join(packageRoot, "codelift-report.json");
  if (!fs.existsSync(reportPath)) {
    throw new AnalysisError("VERIFY_REPORT_MISSING", "codelift-report.json was not found.");
  }
  return JSON.parse(fs.readFileSync(reportPath, "utf8")) as ExportReport;
}

function structuralChecks(packageRoot: string, report: ExportReport): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  const manifestPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(manifestPath)) {
    checks.push(check("manifest", "Package manifest", "failed", "package.json is missing."));
    return checks;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    exports?: Record<string, { import?: string; types?: string } | string>;
  };
  const rootExport = manifest.exports?.["."];
  const importPath = typeof rootExport === "object" ? rootExport.import : undefined;
  const typesPath = typeof rootExport === "object" ? rootExport.types : undefined;
  checks.push(
    check(
      "manifest",
      "Package manifest",
      importPath && typesPath ? "passed" : "failed",
      importPath && typesPath
        ? undefined
        : "The root export must declare import and types targets.",
    ),
  );

  const leaked = textFilesContain(packageRoot, report.plan.source.root);
  checks.push(
    check(
      "source-boundary",
      "No source-project references",
      leaked.length === 0 ? "passed" : "failed",
      leaked.length === 0 ? undefined : `Absolute source path appears in: ${leaked.join(", ")}`,
    ),
  );

  const expected = new Set(report.plan.expectedFiles);
  const unexpected = listFiles(packageRoot).filter(
    (file) => !expected.has(file) && file !== "codelift-report.json",
  );
  checks.push(
    check(
      "file-manifest",
      "Exported file manifest",
      unexpected.length === 0 ? "passed" : "failed",
      unexpected.length === 0 ? undefined : `Unexpected files: ${unexpected.join(", ")}`,
    ),
  );
  return checks;
}

function overallStatus(checks: VerificationCheck[]): VerificationResult["status"] {
  if (checks.some((item) => item.status === "cancelled")) return "cancelled";
  if (checks.some((item) => item.status === "failed")) return "failed";
  if (checks.some((item) => item.status === "not-run")) return "not-run";
  if (checks.every((item) => item.status === "unsupported")) return "unsupported";
  return "passed";
}

async function analyzeExport(packageRoot: string): Promise<VerificationCheck> {
  try {
    const result = await analyzeProject({
      projectRoot: packageRoot,
      tsconfigPath: "tsconfig.json",
      entrypoint: "src/index.ts",
    });
    const blocking = result.issues.filter((issue) => issue.blocking);
    return check(
      "imports",
      "Local import resolution",
      blocking.length === 0 ? "passed" : "failed",
      blocking.length === 0 ? undefined : blocking.map((issue) => issue.message).join("\n"),
    );
  } catch (error) {
    return check(
      "imports",
      "Local import resolution",
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function verifyPackage(
  request: VerificationRequest,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const startedAt = performance.now();
  const packageRoot = path.resolve(request.packageRoot);
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) {
    throw new AnalysisError(
      "VERIFY_ROOT_INVALID",
      `Package directory does not exist: ${packageRoot}`,
    );
  }
  const report = readReport(packageRoot);
  const checks = structuralChecks(packageRoot, report);
  checks.push(await analyzeExport(packageRoot));
  let sandbox: string | undefined;

  try {
    if (!request.install) {
      checks.push(
        check(
          "install",
          "Dependency installation",
          "not-run",
          "Pass --install or approve installation in Studio.",
        ),
        check("build", "Package build", "not-run", "Dependencies were not installed."),
        check("smoke", "Public export smoke test", "not-run", "The package was not built."),
      );
    } else {
      sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "codelift-verify-"));
      fs.cpSync(packageRoot, sandbox, { recursive: true });
      const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
      const installArgs = [
        "install",
        ...(request.allowInstallScripts ? [] : ["--ignore-scripts"]),
        "--no-audit",
        "--no-fund",
      ];
      const install = await runCommand(npmCommand, installArgs, sandbox, signal);
      checks.push(
        check(
          "install",
          "Dependency installation",
          install.code === 0 ? "passed" : "failed",
          install.code === 0 ? undefined : `npm exited with code ${install.code}.`,
          install.output,
        ),
      );
      if (install.code === 0) {
        const build = await runCommand(npmCommand, ["run", "build"], sandbox, signal);
        checks.push(
          check(
            "build",
            "Package build",
            build.code === 0 ? "passed" : "failed",
            build.code === 0 ? undefined : `Build exited with code ${build.code}.`,
            build.output,
          ),
        );
        if (build.code === 0) {
          const entryUrl = pathToFileURL(path.join(sandbox, "dist", "index.js")).href;
          const smokeProgram =
            report.plan.target.profile === "react-library"
              ? `const library = await import(${JSON.stringify(entryUrl)}); const React = await import("react"); const { renderToStaticMarkup } = await import("react-dom/server"); const component = Object.entries(library).find(([name, value]) => /^[A-Z]/u.test(name) && typeof value === "function")?.[1]; if (!component) throw new Error("No exported React component was found for the smoke test."); renderToStaticMarkup(React.createElement(component, {}));`
              : `await import(${JSON.stringify(entryUrl)});`;
          const smoke = await runCommand(
            process.execPath,
            ["--input-type=module", "--eval", smokeProgram],
            sandbox,
            signal,
          );
          checks.push(
            check(
              "smoke",
              "Public export smoke test",
              smoke.code === 0 ? "passed" : "failed",
              smoke.code === 0 ? undefined : `Smoke import exited with code ${smoke.code}.`,
              smoke.output,
            ),
          );
        } else {
          checks.push(check("smoke", "Public export smoke test", "not-run", "The build failed."));
        }
      } else {
        checks.push(
          check("build", "Package build", "not-run", "Dependency installation failed."),
          check("smoke", "Public export smoke test", "not-run", "Dependency installation failed."),
        );
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      checks.push(
        check("operation", "Verification operation", "cancelled", "Verification was cancelled."),
      );
    } else {
      checks.push(
        check(
          "operation",
          "Verification operation",
          "failed",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  } finally {
    if (sandbox && fs.existsSync(sandbox)) fs.rmSync(sandbox, { recursive: true, force: true });
  }

  const result: VerificationResult = {
    schemaVersion: 1,
    packageRoot,
    status: overallStatus(checks),
    checks,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
  report.verification = result;
  fs.writeFileSync(path.join(packageRoot, "codelift-report.json"), stableJson(report));
  return result;
}
