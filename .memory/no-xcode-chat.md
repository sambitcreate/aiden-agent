# Ordinary chat without Xcode — 2026-09-26

Fresh `fix/no-xcode-chat` worktree from origin/main a9baa4aa. Screenshot's raw xcode-select failure matches `prepareGeneration -> gitInfo -> GitService.repository -> git rev-parse`: optional workspace Git metadata previously aborted initialization, even for a non-repository folder. Apple's /usr/bin/git is an install-on-demand shim on Macs without developer tools.

- Generation Git context is best-effort, skips unauthorized/no folders, and preserves cancellation. Managed-worktree admission stays outside the catch and fails closed; explicit Git operations still report errors.
- On macOS, GitService resolves executable candidates with the same sanitized PATH/environment used for spawning. Apple's canonical shim is never spawned: non-installing `xcode-select --print-path` locates installed CLT/Xcode Git directly, or lookup continues to a real Git later on PATH (including Homebrew). Missing/stale developer directories produce a readable Git-feature error. Other platforms retain existing resolution.
- New regression files are registered in `test` and `test:coverage`. Focused Git, Remote Git, generation startup/initialization, managed admission and new regression suites: 129 passed. TypeScript and scoped ESLint passed after a worktree-local locked dependency install.
- Both native Git DTO consumers inspected; no shared contract, transcript/activity UI, native implementation, onboarding capability, or plan status changes. Native suites were not run. No physical no-Xcode Mac tested: missing tools/shim cases use injected resolver fixtures; the screenshot diagnostic is also covered with a real failing subprocess.
- Independent description-only review found no concrete blocker; not a source audit. Full repository test suite and packaged clean-Mac smoke test remain outside this validation.

## PR #261 review and CI follow-up

- Hermes identified workspace-relative/empty PATH lookup. Default Git discovery now filters to absolute PATH directories and never probes workspace-relative candidates. Explicit configured binary paths retain their existing semantics.
- Pullfrog identified installed-but-unselected CLT Git. After a missing/stale selected developer directory, probe the fixed `/Library/Developer/CommandLineTools/usr/bin/git` path, validating executable identity and rejecting the Apple shim; preserve cancellation before using the fallback.
- Five failed CI jobs shared one cause: the two new test files were missing from `scripts/ci-test-registry.json`. Both are now assigned to core-git; no checks were weakened.
- New regressions reproduced both review findings before implementation. Updated focused Git/Remote/generation/admission suite: 138 passed. CI policy/inventory: 46 passed. TypeScript, scoped ESLint, and diff whitespace checks passed. Hosted CI must rerun on the updated head.
