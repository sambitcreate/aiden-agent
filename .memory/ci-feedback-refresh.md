# CI feedback refresh — PR #139

2026-09-21. Refreshed in an isolated worktree from PR head 05138ff9 plus main
1c1caaad, then release-test hardening c8c09e0d. Scope is CI scheduling, inventory, execution prerequisites and reporting.
The draft release-admission rewrite was removed; release workflows are unchanged.

Three one-worker Electron shards use updated hosted weights. Three macOS regression
lanes deduplicate the npm test graph while preserving coverage/browser/native/Ruby/
Rust modes. Ubuntu owns static checks. Full main validation uses run-specific
concurrency groups; PRs cancel superseded runs. Unknown/empty diffs run all checks.
Advisory timing reports use current-attempt job pagination and distinguish execution
from start offsets. Repository protection settings are unchanged.

Adversarial review covers cancellation, missing/invalid results, renamed/deleted
paths, empty diffs, documentation boundaries, new file inventory, native helper
prerequisites and loss of non-JS modes. Hosted validation is tracked on PR #139; local native
builds are blocked by the existing CLT SDK/linker mismatch. No application or mobile
contracts changed; platform suites remain hosted acceptance gates.

Review follow-up: iOS-only changes run shipping/TestFlight policy in the iOS job
when desktop lanes skip; full runs retain the single preserved desktop execution.
