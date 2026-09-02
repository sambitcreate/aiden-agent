# Design Workspace package acceptance — 2026-09-01

Status: Passed for the development package built from the current `feature/design-workspace` working tree.

## Artifact identity

- App: `release/development/mac-arm64/Aiden Agent.app`
- Version: `0.36.0`
- Identifier: `com.sambitcreate.aiden-agent`
- Signing identity: `Developer ID Application: Sambit Biswas (5WP229CBB8)`
- Team identifier: `5WP229CBB8`
- CDHash: `83c78a53372d69b214c8f97a5d7ac42010970863`
- Executable SHA-256: `2f65cf7802bca5018a8b1bb20186c00075ac22a967d61d083c2d70386d144714`
- Build command: `npm run package && npm run package:verify`
- Package verification: hardened runtime and package structure passed. This development artifact is intentionally not notarized; notarization remains a distribution-release gate.

## Operator acceptance

The exact package above was launched with isolated `userData` and portable-config roots under `/tmp/aiden-design-package-l1ppDu`.

1. Completed first-run setup with a local test profile and **Skip provider**; no credential was entered.
2. Opened the packaged **Design Projects** library.
3. Created a prototype project named **Package Acceptance** and confirmed the project canvas identified it as **Prototype · Saved locally**.
4. Quit with Command-Q and observed a clean exit.
5. Restarted the same package and isolated state, reopened Design, and confirmed **Package Acceptance · Prototype · 0 artboards** was restored from the durable project store.
6. Reopened the project, confirmed the canvas and Preview control, quit again, and verified both the package process and source-preview process group were absent.

## Workflow evidence bound to this source tree

- `npm run test:generative-ui`: 277 Node assertions, 3 vendoring assertions, and 9 Playwright scenarios passed.
- The Playwright suite extracted a real Design ZIP and executed it offline without remote dependencies.
- Direct-edit suites cover prototype revision creation and exact Undo, connected Designer Action preparation, and fail-closed ambiguity.
- Handoff suites cover managed-worktree and existing-workspace flows, exact acknowledgements, publication, cancellation, restart recovery, and preserved linkage.
- Multi-file suites cover Apply/Undo, same-process and restart crash boundaries, complete postimage source-graph proof, conflict rollback, deletion preflight, and authority revocation.
- `source-design-preview.test.ts` proves application shutdown waits until the owned preview process group is gone; the operator run independently ended with no preview process present.
- `npm run type-check` and `git diff --check` passed after the acceptance suite.

The manual package run establishes package startup, local project persistence, restart restoration, and clean process shutdown. The deterministic source and browser suites establish edit, export, handoff, and crash-boundary behavior without requiring a live provider credential in the acceptance profile.
