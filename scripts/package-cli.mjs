import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
const cliRoot = path.join(workspaceRoot, "packages", "cli");
const cliDist = path.join(cliRoot, "dist");

function copyDirectory(source, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function rewriteFiles(directory, replacements) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteFiles(absolute, replacements);
      continue;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;
    let content = fs.readFileSync(absolute, "utf8");
    for (const [from, to] of replacements) content = content.replaceAll(from, to);
    fs.writeFileSync(absolute, content);
  }
}

function removeSourceMaps(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removeSourceMaps(absolute);
      continue;
    }
    if (entry.name.endsWith(".map")) {
      fs.rmSync(absolute);
      continue;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;
    const content = fs.readFileSync(absolute, "utf8");
    const cleaned = content.replace(/^\/\/[#@] sourceMappingURL=.*(?:\r?\n|$)/gm, "");
    if (cleaned !== content) fs.writeFileSync(absolute, cleaned);
  }
}

fs.rmSync(path.join(cliDist, "core"), { recursive: true, force: true });
fs.rmSync(path.join(cliDist, "studio-server"), { recursive: true, force: true });
rewriteFiles(cliDist, [
  ['from "@codelift/core"', 'from "./core/index.js"'],
  ['from "@codelift/studio-server"', 'from "./studio-server/index.js"'],
]);

copyDirectory(path.join(workspaceRoot, "packages", "core", "dist"), path.join(cliDist, "core"));
copyDirectory(
  path.join(workspaceRoot, "packages", "studio-server", "dist"),
  path.join(cliDist, "studio-server"),
);
rewriteFiles(path.join(cliDist, "studio-server"), [
  ['from "@codelift/core"', 'from "../core/index.js"'],
]);
copyDirectory(path.join(workspaceRoot, "apps", "studio", "dist"), path.join(cliRoot, "studio"));
removeSourceMaps(cliDist);
removeSourceMaps(path.join(cliRoot, "studio"));
