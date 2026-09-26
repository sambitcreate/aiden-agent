# iOS Home response ownership

Isolated feature/ios-home-response-ownership atop PR236 dcfd0d707. Implementation complete; preparing reviewed publication. Hosted and combined acceptance remain pending.

Source schedule: Home reserves before HTTP but summary save returned Void on rejected tokens; caller then published raw response/cursor. Per-model generation cannot arbitrate another Home owner or detail settlement. Added namespaced synchronous summary reservations, shared original-token admission, Bool write results, memory summary winner after IO failure, and detail projection under the accepted original token. Home respects rejection; continuation checks its cursor boundary against admitted shared state before merging.

Two new regression methods hold actual production Home HTTP through detail settlement, another Home request, or purge; and hold actual continuation cache admission through newer detail/request/purge, checking unchanged cursor and retry. Generic XCTest compilation passed before final cursor-base refinement; policy31Node20Ruby42 pass. Tests compiled only, no physical execution or executed iOS baseline claimed. Both Sol reviewers inspecting pending diff; final checks and corrections remain necessary.

PR236 dcfd0d707 has hosted verify/E2E running and no review threads at this turn. Integration bbb71364a accepted by both Sol reviewers, fresh iOScompile/157host, unchanged213Android evidence. Earlier stable PRs unchanged. Physical acceptance unexecuted while shared iPhone locked. No merges/releases/deployments.

## Final implementation and validation in progress

Summary reservations are synchronous and installation-scoped. Accepted detail projection keeps its original token, so an older queued detail cannot supersede a newer Home request. Home commits only admitted pages; admitted memory survives summary filesystem failure while validation/size failures still reject. Local generation is not used as a cross-owner cache clock.

Review corrections: deletion takes fresh summary authority after held cleanup; no-chat Home plans do not reserve summary authority; rejected chat segments settle and still publish independent segments; local writes patch all unacknowledged edited IDs into current admitted summaries and preserve its cursor; initial UI reapplies local edits since request start, and pagination reapplies postcommit edits including newly introduced page IDs. The newest local patch acknowledges prior edits only after acceptance. Continuations validate the shared cursor before merging. Initial warm hydration checks the latest request token before taking ownership after an await.

Five new methods cover three held production HTTP schedules, three held continuation cache schedules and retry, actual blocked summary filesystem memory admission, held deletion cleanup with an intervening request and restart, and page commit followed by two queued local edits (including a new page row) with restart. Generic app/XCTest compilation succeeds /tmp/aiden-ios-home-response-build.log. Android177 JVM/lint/instrumentation compilation succeeds /tmp/aiden-ios-home-response-android.log. Policy31Node20Ruby42 succeeds /tmp/aiden-ios-home-response-policy.log. These are compiled iOS regressions, not physical execution or executed baseline failures. Final Sol reviews pending.

The partial-summary cursor expression also carries the already accepted PR21762fa semantics: absent cached snapshot retains incoming cursor; cached nil cursor stays nil. This is prerequisite-equivalent integration overlap, not a new cursor policy.

Final review refinements: publish the atomic admitted snapshot/authority rather than a raw accepted response, including partial deletion transformations. Token-qualified local edit replay and per-row original edit tokens prevent replay over a newer cross-owner detail winner. Removal synchronously persists its authoritative deletion regardless of concurrent nonisolated HTTP reservations; a new exact reserve/admit-seam regression verifies restart excludes the row. The held cleanup regression remains.

Per-row authority review correction: full HTTP pages and row mutations now have separate token floors. Detail/local/removal/rename companions advance only their affected row; queued activity A remains valid across unrelated settlement B, while older A edits cannot overwrite newer A. Atomic publication state returns full and per-row floors. Expanded tests include unrelated activity retention through detail and later folded patch, plus durable reopen. Latest compile and policy checks pass.

PR236 dcfd0d707 is now hosted accepted: verify/E2E success, Android correctly area-skipped, zero threads. Final exact-head evidence recorded in PR body, coordinator/integration notified.

Final companion conversion: reconcileWorkspaceChat uses the target row authority for Home eligibility, so unrelated B settlement no longer suppresses valid A rename. Extended regression covers delayed PATCH origin, newer A canonical settlement, accepted rename overlay, newer unrelated B, then companion A and both retained rows. Generic compilation and policy pass after this delta.

Final same-row cutoff correction: rename companion row authority covers max(receipt cutoff, winner), so a whole-row local snapshot reserved during PATCH cannot roll the accepted title back. Expanded schedule reserves that patch after canonical settlement but before receipt cutoff, delivers it after companion and unrelated settlement, then reopens to verify the accepted title and admitted activity.

Post-receipt activity review correction: an existing locally updated row can receive the presented rename winner while retaining its activity, provided no later authoritative full-page snapshot superseded the receipt. Later full-page rows and absent post-receipt removals remain protected. The companion keeps max(existing row, receipt cutoff, winner) authority. Regression persists an activity change after cutoff but before actor receipt admission, then asserts accepted title plus active state and rejection of the earlier queued whole-row patch after restart.

Activity-only writes now carry a field mask through queued cache patching and UI replay. They change only current activity, preserve canonical title/revision and do not recreate missing rows. Unacknowledged full-row edits retain full semantics when folded with subsequent activity changes. The final reopen regression updates activity from a stale-title Home snapshot after the rename companion and confirms both current title and new activity. Latest generic compilation and policy pass.

Both independent GPT-5.6 Sol medium final reviews are clear, including the final activity-only field mask and all preceding ownership/rename corrections. Generic XCTest compilation, Android177 JVM/lint/instrumentation and policy31Node20Ruby42 pass. Physical execution remains unexecuted.
