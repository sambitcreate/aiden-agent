# Studio PR #85 — 2026-09-22

Preserved `feature/stitch-design-studio` (original head 37c7d37fa) in isolated
`feature/studio-research-upgrade`. Main integration is separate commit 1edd2781.
See docs/plans/studio-research-improvements-plan.md for verified sources, changes,
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
