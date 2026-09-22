# Studio PR #85 — 2026-09-22

Preserved `feature/stitch-design-studio` (original head 37c7d37fa) in isolated
`feature/studio-research-upgrade`. Main integration is separate commit 1edd2781.
See docs/plans/completed/studio-research-improvements-plan.md for verified sources, changes,
explicit deferrals, review findings and acceptance scope. Existing PR must be
updated, never duplicated; no merge/release/deploy authorized.

Integration preserved both sides of 13 conflicts, including detached generation
recovery, Aiden Live, Studio ownership and DataStore publication receipts.
Sol medium review found a task-chip spacing mismatch; fixed. Three source tests
were adapted for conditional Studio layout and its prepared workspace argument.
122 focused tests and type checks passed.

Post-change reviewers caught fallback History dates/provenance, a redundant
post-edit source read, incompatible connected-source context on Explore, duplicate
preview document allocation, and loss of process failure state after cleanup.
Fixes preserve exact authorization and visible failure recovery. Native Design
exclusion remains unchanged; Android parity checks and iOS generic hardware test compilation passed, as did
production build, type/lint and remote checks (462 pass, one skip). Hosted
exact-head checks remain pending.

Follow-up at 2026-09-22 11:38 UTC: head 133b96c55 has successful Ubuntu
checks, while CI run 35719548500 still has verify and Deterministic Electron
E2E queued with unassigned macos-26 runners. PR comments and review threads are
empty. This is an external runner blocker, not passing CI. Removed previously
tracked papercut scratch from Git while retaining the ignored local file, per
the updated project instructions; no implementation changed.

Hosted verify run 35722837750/job 106729478113 subsequently failed at the
source-designer browser test: Undo's Vite reload interrupted page.goto with
Chromium's alternate same-page navigation message. All 451 Design tests passed;
the browser retry passed but fail-on-flaky correctly failed the job. Prepared a
test-only fix in tests/generative-ui/source-designer.spec.ts matching the exact
target and cleaned same-origin/path destination, with positive/negative cases.
Both independent Sol medium reviewers found no issues. Classifier test passed
three repetitions; browser integration could not launch under the newly
restricted sandbox (MachPortRendezvousServer permission denied). Git metadata
is read-only and coordinator notification was denied by the tool because
approval policy is never. Patch retained at /tmp/studio-pr85-vite-reload.patch;
fix is uncommitted and unpushed. Do not claim hosted CI or browser reruns passed.

12:43 UTC follow-up: head remains 15700da226; Deterministic Electron E2E
job 106729477692 succeeded. Release consumer contract also succeeded; verify
still failed as above, with its downstream native/build steps skipped. No PR
comments or review threads. Local fix lint and TypeScript checks passed.

14:07 UTC: unrestricted permissions restored. Real source-designer browser
tests passed all nine cases across three repetitions with retries disabled,
including Apply/Undo and ambiguous-component rejection. Both prior Sol reviews
cover this unchanged test-only fix. Coordinator notification now succeeded.
The full Generative UI browser suite also passed all 12 tests with retries
disabled. Hosted acceptance still requires the new pushed head's checks.

14:41 UTC: all applicable hosted checks passed on 241ef9272416dffb433145d345d9b1e1ed53c5e8 (CI35738331314 and release contract35738331308). Android path-skipped; no comments/review threads. Plan archived as complete. Documentation-only completion commit will receive its own exact-head check before monitoring closes.
