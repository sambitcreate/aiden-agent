# Git push cancellation fixture — 2026-09-23

Isolated branch `feature/git-push-cancel-fixture` from main c8c09e0d2; preserves green PR #221 and shell transport PR #235. Only the existing cancellation test and documentation change, not git.ts or production timeouts.

PR #235 CI job 107043320941 failed `reading === true` before the test called abort. Its 150 x 20ms loop covered all pre-push, transport and post-push subprocesses despite a five-second transport timeout. The failed assertion allowed temporary-repository cleanup before the outstanding operation settled; hosted logs subsequently reported a missing wrapper. An exact local run passed. A temporary controlled 3.2-second pre-push delay reproduced the marker failure and async-after-teardown error. This establishes a viable fixture race, not the exact hosted scheduler cause.

The existing `waitForFile(readMarker, 15000)` helper replaces the iteration count; an immediate rejection handler and finally abort/drain protect failure cleanup. A separate controlled two-second post-marker delay reproduced the old 1200ms wrapper timer race, returning without the expected cancellation warning. The wrapper now waits for a release file, with a bounded ten-second failure timeout. The test aborts before release; finally always aborts, releases, and drains before teardown. All original warning/upstream assertions remain intact.

Validation includes original normal pass, pre-delay red before and green after the bounded marker wait, post-delay red before explicit release, and both delays together green after the complete correction. Temporary test copies are removed. Full Git suite, type-check, focused lint, two independent Sol medium reviews, and hosted validation are recorded in the PR. No UI, shared-client contract, permissions, onboarding, or rollout status changes.

Local final validation: all 99 Git tests passed after building the normal native prerequisites; type-check, focused lint, diff checks, and both independent Sol medium reviews passed. Hosted CI is pending publication.

PR #237 review 4079143358 identified that the original final-outcome assertions also passed when the post-read guard was absent, because run() rejected the already-aborted mutation. The fixture now transparently observes run() and asserts zero upstream mutation attempts. Temporarily disabling only the post-read guard fails that assertion (one attempt); restoring it passes. Production source is unchanged.
