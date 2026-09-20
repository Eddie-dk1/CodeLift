# Architecture

CodeLift ships one self-contained CLI package with a shared core and a loopback Studio.

```text
                         ┌─ analyzer ─ TypeScript 6 compatibility adapter
codelift CLI ────────────┼─ planner ── versioned snapshot + decisions
                         ├─ exporter ─ staging + atomic rename
                         └─ verifier ─ isolated temporary copy
                                  ▲
React Studio ─ Fastify jobs ──────┘
```

## Packages

- `@codelift/core` owns discovery, module/resource resolution, graph traversal, issue detection,
  planning, export, and verification.
- `@codelift/studio-server` exposes the core over a token-protected loopback API. Plans and jobs are
  in-memory and scoped to one server session.
- `@codelift/studio` provides the React graph, evidence inspector, plan review, export confirmation,
  and verification report.
- `codelift-cli` embeds the compiled outputs of all three packages plus the Studio static files. A
  tarball therefore runs with npm/npx and does not require pnpm or the monorepo.

## Contracts

Analysis, plan, export, and verification results have independent schema versions. CLI discovery is
convenient and may be interactive, while `analyzeProject()` keeps explicit paths so library calls
remain deterministic.

An extraction plan contains SHA-256 hashes of sources, assets, the TypeScript configuration, package
manifest, and lockfile when present. Its portable digest deliberately excludes the absolute source
root. Export recalculates every hash before writing.

## Trust boundary

The source project is untrusted, read-only input. Paths are resolved through `realpath`, symlink
escapes are rejected, and source code and project scripts are never executed.

The Studio server binds to loopback, rejects cross-origin API requests, and requires a random
session token. Export accepts only a plan previously created in the same session and requires an
exact package-name confirmation. Studio verification accepts only a destination exported in that
session.

Export writes a temporary sibling directory and atomically renames it only after validation.
Verification copies the result into a separate temporary directory, removes environment links to
the source, disables lifecycle scripts by default, and runs only CodeLift-generated commands.

## Compiler boundary

CodeLift itself builds with TypeScript 7. Project analysis is isolated behind `CompilerAdapter` and
currently uses the TypeScript 6 compatibility package. This boundary is the migration point for a
future TypeScript compiler API.
