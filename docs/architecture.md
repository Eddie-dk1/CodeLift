# Architecture

CodeLift has one analysis engine and two delivery surfaces.

```text
CLI ───────────────┐
                   ├── @codelift/core ── CompilerAdapter ── TypeScript 6 compatibility API
Local Studio API ──┘
        │
        └── React Studio
```

`@codelift/core` owns project loading, module resolution, graph traversal, issue detection, cycle
analysis, and the versioned result contract. The CLI calls it directly. The Studio server exposes
the same result over a loopback-only API and never executes analyzed code.

The compiler integration is isolated behind `CompilerAdapter`. TypeScript 7.0 does not expose a
programmatic compiler API, so the first release uses the official TypeScript 6 compatibility
package. The adapter boundary is the migration point for the future TypeScript 7.1 API.

## Trust boundary

The source project is untrusted input. All Studio paths are resolved through `realpath`, must stay
inside the configured project root, and are opened read-only. Symlinks cannot escape that root.
The server binds to loopback, checks request origin, and requires a random per-session token.
