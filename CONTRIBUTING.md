# Contributing to CodeLift

Thanks for helping improve CodeLift. Bug reports, focused pull requests, compatibility fixtures, and
documentation corrections are welcome.

## Before you start

- Search existing [issues](https://github.com/Eddie-dk1/CodeLift/issues) and pull requests first.
- Open an issue before beginning a large feature or public-schema change.
- Do not attach proprietary source, credentials, access tokens, usernames, or unsanitized absolute
  paths to issues or reports.
- Keep the source project read-only. Changes that execute analyzed project code or silently write
  into it are outside CodeLift's security model.

## Development setup

Requirements:

- Node.js 24 or newer;
- pnpm 12.4.

```bash
git clone https://github.com/Eddie-dk1/CodeLift.git
cd CodeLift
corepack enable
pnpm install
pnpm demo
```

If pnpm is unavailable, run the pinned version through npm:

```bash
npx pnpm@12.4.0 install
npx pnpm@12.4.0 demo
```

## Making a change

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Add a deterministic fixture when introducing a new resolution or asset case.
4. Update public documentation and schemas when an interface changes.
5. Keep diagnostics, CLI output, and Studio copy in English.

Do not edit generated `dist` output or commit local package tarballs. Avoid unrelated formatting or
refactoring in the same pull request.

## Required checks

Run the checks relevant to your change; before requesting review, the complete suite should pass:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm audit --prod
```

For packaging changes, also run:

```bash
cd packages/cli
npm pack --dry-run
```

CI repeats the quality suite on Node 24 across Ubuntu, macOS, and Windows and also exercises the
packed CLI and Studio.

## Pull requests

Describe the problem, the chosen approach, tests performed, and any security or compatibility
impact. Keep pull requests small enough to review. Maintainers may ask for a fixture or a schema
note when behavior affects generated plans, exports, or reports.

By contributing, you agree that your contribution is licensed under the repository's
[MIT License](LICENSE) and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).
