# CodeLift CLI

Analyze, extract, and verify one TypeScript or React entrypoint without changing the source project.

> CodeLift is beta software. Use the `beta` dist-tag until the first stable release.

![CodeLift Studio showing a React dependency graph](https://raw.githubusercontent.com/Eddie-dk1/CodeLift/main/docs/assets/codelift-studio.png)

## Quick start

Open Studio for the current project:

```bash
cd /path/to/project
npx codelift-cli@beta
```

Useful short forms:

```bash
npx codelift-cli@beta ./another-project
npx codelift-cli@beta src/index.ts
npx codelift-cli@beta inspect src/index.ts
```

Node.js 24 or newer is required. CodeLift discovers the project root and a single unambiguous
`tsconfig` automatically. When several configurations match, it asks for an explicit choice instead
of guessing.

## Check compatibility

`doctor` performs a local, read-only check and does not use the network:

```bash
npx codelift-cli@beta doctor
npx codelift-cli@beta doctor ./project --entry src/index.ts
npx codelift-cli@beta doctor --entry src/Card.tsx --tsconfig tsconfig.json --format json
```

It reports the Node/npm versions, compiler config candidates, entrypoints, detected profile, and
compatibility issues.

## Analyze in the terminal

```bash
npx codelift-cli@beta inspect src/index.ts
npx codelift-cli@beta inspect src/index.ts --format json
```

Advanced overrides remain available:

```bash
npx codelift-cli@beta inspect src/index.ts \
  --project /path/to/project \
  --tsconfig tsconfig.library.json
```

## Plan, export, and verify

The destination is always explicit and must not already exist:

```bash
npx codelift-cli@beta plan src/index.ts \
  --name my-library \
  --out ../my-library \
  --save codelift.plan.json

npx codelift-cli@beta extract --plan codelift.plan.json
npx codelift-cli@beta verify ../my-library
```

Safe structural verification does not install dependencies. To build and smoke-test the exported
package in an isolated temporary copy:

```bash
npx codelift-cli@beta verify ../my-library --install
```

Dependency lifecycle scripts remain disabled unless `--allow-install-scripts` is supplied
explicitly.

## Programmatic API

The same deterministic engine used by the CLI and Studio is available through a package subpath:

```ts
import {
  analyzeProject,
  createExtractionPlan,
  exportPackage,
  verifyPackage,
} from "codelift-cli/core";
```

`analyzeProject` remains explicit and requires a project root, `tsconfig`, and entrypoint. Automatic
project discovery belongs to the CLI and Studio.

## Supported beta profile

- Node ESM with `.ts` and `.mts`;
- React with `.tsx` and standard JSX modes;
- relative imports, TypeScript `paths`, re-exports, type-only imports, package subpaths, Node
  built-ins, and literal `import()`;
- CSS, CSS Modules, JSON, SVG, common image formats, and fonts;
- one entrypoint and one TypeScript configuration per extraction.

Not yet supported: CommonJS, Sass/Less, React Native, arbitrary bundler plugins, multiple
entrypoints, project references, workspace package transfer, and automatic test migration.

## Security model

- The source project is read-only and its scripts are never executed.
- Studio binds only to `127.0.0.1` and requires a random session token for API calls.
- Export requires a new destination outside the source project.
- Plans contain source digests and are revalidated before export.
- Export uses a temporary sibling directory and an atomic final rename.
- Isolated verification requires explicit approval before installing dependencies.
- CodeLift has no accounts, telemetry, cloud upload, or postinstall script.

## Troubleshooting

Run `doctor` first when project detection fails. If several configs are listed, pass the intended
one with `--tsconfig`. If npm is missing, install a supported Node.js distribution; npm ships with
Node and is used only for optional isolated verification.

Bug reports and compatibility examples belong in the
[CodeLift issue tracker](https://github.com/Eddie-dk1/CodeLift/issues). Remove credentials,
proprietary source, usernames, and absolute paths before attaching output.

CodeLift is released under the MIT license.
