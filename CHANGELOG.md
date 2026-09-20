# Changelog

All notable changes to CodeLift are documented here. The project follows Semantic Versioning while
public JSON schemas are versioned independently.

## 0.4.0-beta.0 — unreleased

### Added

- One-command Studio launch with automatic project and `tsconfig` discovery.
- Self-contained `codelift-cli` npm package with the `codelift` binary.
- React/TSX, CSS/CSS Modules, JSON, SVG, image, and font dependency analysis.
- `AnalysisResult` schema 2 with profiles, local assets, and resource edge kinds.
- Deterministic Extraction Plan schema 1 with source digests and dependency decisions.
- Safe staging exporter with precise import-specifier rewrites and atomic destination creation.
- Structural and optional isolated install/build/smoke verification.
- Studio Plan → Review → Export → Verify workflow with cancellable jobs.
- Read-only `codelift doctor` diagnostics with stable JSON output and explicit exit codes.
- Public `codelift-cli/core` API export for analysis, planning, export, and verification.

### Changed

- Release automation now validates tags and package versions, runs the complete quality and packed
  artifact smoke suite, and selects npm prerelease tags automatically.
- The distributable package no longer includes JavaScript or declaration source maps.

### Security

- Export destinations are checked against source overlap, filesystem roots, home, existing paths,
  symlink escapes, and case-insensitive collisions.
- Studio jobs and plans are scoped to one token-protected loopback session.
- Dependency lifecycle scripts remain disabled during verification unless explicitly allowed.

## 0.1.0 — initial local increment

- Read-only Node ESM dependency analysis, CLI reports, and graph Studio.
