# Security policy

CodeLift reads source code from a local project root. It does not execute the analyzed project or
send source code to a remote service. Dependency installation happens only after explicit
`verify --install` approval, inside a temporary copy, with lifecycle scripts disabled by default.

Please report security issues privately through GitHub Security Advisories rather than opening a
public issue. Include the affected version, reproduction steps, and the operating system.

The local Studio binds to `127.0.0.1`, requires a per-session token for API calls, and restricts
filesystem access to the project root passed to `codelift studio`.

Export accepts only digest-verified plans, refuses overlapping or existing destinations, writes to a
temporary sibling directory, and atomically renames the validated result into place.
