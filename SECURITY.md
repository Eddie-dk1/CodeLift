# Security policy

CodeLift reads source code from a local project root. It does not execute the analyzed project,
install dependencies, or send source code to a remote service.

Please report security issues privately through GitHub Security Advisories rather than opening a
public issue. Include the affected version, reproduction steps, and the operating system.

The local Studio binds to `127.0.0.1`, requires a per-session token for API calls, and restricts
filesystem access to the project root passed to `codelift studio`.
