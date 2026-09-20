# Releasing CodeLift

Publishing is deliberately separated from builds, installs, and the manually dispatched workflow.
No lifecycle script publishes or contacts npm.

## One-time GitHub and npm setup

1. Protect `main`: disallow force pushes and deletion, require the `CI / Quality gate` check, and
   require pull requests if that matches the maintainer workflow.
2. Create the protected GitHub environment `npm`. Add required reviewers before a stable release.
3. Create the `codelift-cli` package with the first authenticated npm publication. If npm requires a
   bootstrap token, store it temporarily as the `NPM_TOKEN_BOOTSTRAP` environment secret and remove
   it after Trusted Publishing is active.
4. In npm package settings, configure this repository's `release.yml` workflow as a Trusted
   Publisher. Later releases use GitHub OIDC provenance rather than a long-lived token.

The package name is intentional. If `npm view codelift-cli` returns an existing package, stop and
verify ownership; do not silently rename the project.

## Local preflight

Use Node 24 or newer and run:

```bash
pnpm install --frozen-lockfile
pnpm run release:preflight
pnpm run ci
pnpm test:e2e
pnpm audit --prod
cd packages/cli && npm pack --dry-run
```

The release preflight verifies that the root, core, CLI, Studio, and server versions match and that
the package has no lifecycle scripts. The packed tarball must also be installed into an empty npm
project and checked through `codelift --version`, `codelift doctor`, `codelift inspect`,
`codelift-cli/core`, and the packaged Studio HTTP endpoint.

## GitHub dry run

Run **Release package** manually from GitHub Actions. A manual run always performs a dry run and can
never publish. It executes lint, typecheck, tests, build, Playwright, production audit, dry-run pack,
real tarball installation, CLI/API smoke checks, and a packaged Studio HTTP check.

## Tag release

Only a `v*` tag whose commit is contained in `main` may publish. The workflow requires the tag,
root version, and all workspace package versions to match exactly. It selects the npm dist-tag from
the version:

- `alpha` → `alpha`
- `beta` → `beta`
- `rc` → `next`
- stable version → `latest`

For `0.4.0-beta.0`, review the complete preflight report, tarball SHA-256, size, and file list first.
After explicit approval, tag the reviewed commit:

```bash
git tag v0.4.0-beta.0
git push origin v0.4.0-beta.0
```

The protected workflow then performs the equivalent of:

```bash
npm publish --tag beta --access public --provenance
```

Never rerun a release with a different artifact under the same version. Bump the prerelease number
instead.
