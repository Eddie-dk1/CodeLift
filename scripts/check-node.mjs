const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

if (major < 24) {
  console.error(
    `CodeLift requires Node.js 24 or newer. Current runtime: ${process.versions.node}. Run "nvm use" before installing.`,
  );
  process.exit(1);
}

if (major !== 24) {
  console.warn(
    `CodeLift accepts Node.js ${process.versions.node}, but Node.js 24 LTS is the recommended and CI-tested runtime.`,
  );
}
