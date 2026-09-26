# CI and merge hygiene (2026-09-26)

Lessons from the 0.50.0 merge-and-release campaign (about 30 PRs merged one after another):

- Merging PRs one at a time forced a "merge main, rerun CI" loop for every PR. The recurring conflict hotspots were the root `package.json` `test` chain, the Aiden Remote protocol revision (#121 was renumbered to revision 15 after #251), and the vendored advisor sources in `packages/cli/src/vendor/advisor/`.
- Flaky e2e specs (Simulator tab focus, assistant-scheduled-profile click) failed runs under `--fail-on-flaky-tests` and needed manual reruns.
- Deleting merged branches by hand closed stacked PRs #220 and #223, because GitHub closes a PR when its base branch is deleted. Both were restored and reopened.
- The repo setting `delete_branch_on_merge` was turned on 2026-09-26; before that, about 130 merged branches had accumulated.
- A pending macOS SecurityAgent prompt stalled local simulator XCTest, so #255's iOS tests ran only as a CI compile.

Agent rules derived from this live in AGENTS.md under "Pull requests, CI, and branches". Owner-side follow-ups that were suggested but not yet done: a merge queue with a protected `main`, quarantining the flaky specs, path-filtered CI jobs, workflow concurrency cancellation for PR runs, automated version bumps (release-please or changesets), and running iOS simulator tests on hosted macOS runners.
