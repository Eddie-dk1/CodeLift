# CodeLift CLI

Analyze, extract, and verify one TypeScript or React entrypoint without changing the source project.

Run CodeLift Studio for the current project:

```bash
npx codelift-cli
```

Inspect one entrypoint without opening a browser:

```bash
npx codelift-cli inspect src/index.ts
```

Create and export a reviewed package:

```bash
npx codelift-cli plan src/index.ts --name my-library --out ../my-library --save codelift.plan.json
npx codelift-cli extract --plan codelift.plan.json
npx codelift-cli verify ../my-library
```

Node.js 24 or newer is required. Studio runs only on loopback, source files stay read-only, and an
isolated dependency install occurs only with the explicit `verify --install` flag.
