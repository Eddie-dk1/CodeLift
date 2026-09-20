import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const manifests = [
  "package.json",
  "packages/core/package.json",
  "packages/cli/package.json",
  "packages/studio-server/package.json",
  "apps/studio/package.json",
];

const packages = manifests.map((relativePath) => ({
  relativePath,
  manifest: JSON.parse(fs.readFileSync(path.join(workspaceRoot, relativePath), "utf8")),
}));
const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size !== 1) {
  throw new Error(
    `Release versions do not match: ${packages
      .map(({ relativePath, manifest }) => `${relativePath}=${manifest.version}`)
      .join(", ")}`,
  );
}

const version = [...versions][0];
if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`Unsupported release version: ${String(version)}`);
}
const releaseTag = process.env.RELEASE_TAG?.trim() ?? "";
if (releaseTag && releaseTag !== `v${version}`) {
  throw new Error(`Git tag ${releaseTag} does not match package version v${version}.`);
}

const cli = packages.find(
  ({ relativePath }) => relativePath === "packages/cli/package.json",
)?.manifest;
if (cli?.name !== "codelift-cli") throw new Error("The publishable package must be codelift-cli.");
if (!cli.exports?.["./core"]?.import || !cli.exports?.["./core"]?.types) {
  throw new Error("codelift-cli must publish JavaScript and types for the ./core subpath.");
}
const forbiddenLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepack",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "postpublish",
].filter((script) => cli.scripts?.[script]);
if (forbiddenLifecycleScripts.length > 0) {
  throw new Error(
    `Publishable package has lifecycle scripts: ${forbiddenLifecycleScripts.join(", ")}`,
  );
}
if (
  packages.find(({ relativePath }) => relativePath === "packages/core/package.json")?.manifest
    .private !== true
) {
  throw new Error("@codelift/core must remain private.");
}

const prerelease = version.split("-")[1]?.toLowerCase() ?? "";
let npmTag = "latest";
if (/^alpha(?:[.-]|$)/u.test(prerelease)) npmTag = "alpha";
else if (/^beta(?:[.-]|$)/u.test(prerelease)) npmTag = "beta";
else if (/^rc(?:[.-]|$)/u.test(prerelease)) npmTag = "next";
else if (prerelease) throw new Error(`Unsupported npm prerelease channel: ${prerelease}.`);
const changelog = fs.readFileSync(path.join(workspaceRoot, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## ${version}`)) {
  throw new Error(`CHANGELOG.md has no section for ${version}.`);
}

const result = {
  package: cli.name,
  version,
  gitTag: `v${version}`,
  npmTag,
  publishCommand: `npm publish --tag ${npmTag} --access public`,
};
console.log(JSON.stringify(result, null, 2));

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `${Object.entries(result)
      .map(
        ([key, value]) =>
          `${key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)}=${value}`,
      )
      .join("\n")}\n`,
  );
}
