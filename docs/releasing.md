# Releasing CodeLift

Publishing is deliberately separated from builds, installs, and the manually dispatched workflow.
No lifecycle script publishes or contacts npm.

## Current release setup

The initial `codelift-cli@0.4.0-beta.0` publication is complete. Releases now use this guarded setup:

1. `main` rejects force pushes and deletion and requires the `CI / Quality gate` check.
2. The protected GitHub environment `npm` requires maintainer approval before publishing.
3. npm Trusted Publishing accepts only GitHub Actions runs from `Eddie-dk1/CodeLift`, workflow
   `release.yml`, and environment `npm`.
4. The workflow has `id-token: write` and publishes through short-lived GitHub OIDC credentials.
5. No npm publish token is stored in GitHub Actions.

If this setup is recreated for a fork, publish the package once with an authenticated maintainer
account, configure the fork's exact repository, workflow filename, and environment as the npm
Trusted Publisher, then remove every temporary bootstrap token. Never copy CodeLift's trusted
publisher identity to an unrelated package or repository.

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

Before every release, review the complete preflight report, tarball SHA-256, size, and file list.
After explicit approval, tag the reviewed commit with the new version, for example:

```bash
git tag v0.4.0-beta.1
git push origin v0.4.0-beta.1
```

The protected workflow then performs the equivalent of:

```bash
npm publish --tag beta --access public --provenance
```

Never rerun a release with a different artifact under the same version. Bump the prerelease number
instead.

After npm confirms publication:

1. verify the version and dist-tag with `npm view codelift-cli@VERSION`;
2. run `npx codelift-cli@TAG --version` from a clean temporary directory;
3. verify registry signatures and provenance;
4. create a GitHub prerelease with notes derived from `CHANGELOG.md`.
