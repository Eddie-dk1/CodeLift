# Releasing CodeLift

Publishing is intentionally separate from build and CI. No install or build script publishes a
package.

## Preflight

1. Run `pnpm run ci` and `pnpm test:e2e` on Node 24.
2. Run `npm pack --dry-run` in `packages/cli`.
3. Install the produced tarball in an empty directory and run `codelift --version` plus one Node and
   one React analysis.
4. For the first release, run `npm view codelift-cli`. A `404 Not Found` result confirms that the
   requested name is still unclaimed; any package result blocks release until ownership is verified.
5. Confirm that `CHANGELOG.md`, the package version, and schema versions are correct.

## Publish

Use the manual **Release package** GitHub Actions workflow. Its default `publish` input is `false`,
which performs the complete build and pack check without publishing. Set it to `true` only after npm
trusted publishing and the protected `npm` environment have been configured.

The publish step uses npm provenance and public access. Do not add lifecycle or postinstall scripts
to the package.
