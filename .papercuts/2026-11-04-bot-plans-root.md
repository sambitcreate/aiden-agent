# Phase C root integration

- Acceptance docs staging: `git add` listed tracked files beneath ignored `.memory/` as ignored and exited 1, although all selected files were staged. Checked index and committed the exact intended five tracked files. Use `git add -u` for tracked project memory updates.
- Planned approval-time callback omitted botId. Core worker will accept `revalidate(botId, proposal)` so production singleton can re-admit the correct Bot without private IDs in public DTOs.
- Plan API lacks originating durable task identity/settlement GC port. Core worker retains minimal hashed ended receipts rather than unsafe time/size eviction; full display history remains bounded.

- Sorting registry lane files created unrelated order churn. Rebuilt only the two added entries against the preserved HEAD layout; no existing membership changed.

- Core audit: persist-before-start does not itself fence time spent awaiting publication. Requested a final post-write deadline check and held-write test before callback invocation. Captured plan binding must also be checked at coverage/admission rather than inferred only from current allowed server/name.

- Integration found C shared response/store Bot ID regex rejected production `bot:<uuid>` IDs. Requested real-mint behavioral red and reuse of the existing path-safe shared guard before Gate4.
- Unlabelled person inputs cannot use numeric submission IDs alone for persistent plan ownership because recovery can reuse them. Proposed separate durable host UUID identities; raw request IDs remain the provenance authority.

- Bot delivery expiry was not stored in the core request. Captured two failures for 60-minute renewal and approval at a spent delivery deadline, then added a private deadline field bound into replay identity and persisted expiry.
- Fresh folder installation needed the same queued Stop intent check as tool admission. A held store-read test reproduced installation after Stop was requested; installation now refuses that pending termination.

- Initial fresh-grant Stop fix also changed an already-started grant callback return, failing the existing serialized-grant test. Kept that assertion and narrowed the intent check to before invocation; an already-started callback completes, then Stop revokes it under the serial.

- Authority adapter worker ended at selected-model capacity after its final 21-test/type/lint run. Preserved all shared edits, read its exact source/tests, and parent reran 21 tests and scoped lint successfully. No duplicate implementation or model switch was needed.

- Gate4 reviewers accepted c9fc2045d, but identified misleading replay/step copy, pending-card precedence, avoidable identity scans and a site grammar mismatch. Root captured four behavioral core/validation failures before adding plan-specific reads, truthful conflicting/final step replay outcomes and early hostname refusal. The tool worker handles replay cleanup and sequential step scheduling while keeping the conservative core termination fence.

- Task6 real lifecycle tests caught two main-wiring hazards: pre-recovery idle would end saved approval, and natural completion only reaches projection onRunSettled. Added a pure lifecycle adapter shared by production and integration tests, preserving recovery and routing actual settlement without a session-to-plan await.
- A final informational steer after the Task6 worker stopped returned thread_not_sendable. No retry or new turn was needed; the handoff was already complete and root owns integration.
- A combined UI-reference read exceeded the output budget. Recovered the relevant button, approval, motion and verification sections with bounded reads before Task7.

- Task7 first Cua attempt reached the pending card but failed its composer locator: readiness changes the placeholder, so Ask Planner is absent while Send is held. Used the actual textarea for draft/Enter assertions, preserving the behavioral oracle. Failure log /tmp/bot-plan-c-task7-cua.log.

- Task7 max-length Cua acceptance reproduced a clipped review: first step had viewport ratio0 and no scrollable review ancestor. Added a bounded keyboard-scrollable Plan review region keeping heading/actions outside; retained failing log /tmp/bot-plan-c-task7-long-review-red.log.

- Task8 source-ready initial whole types overlapped host final corrections: missing route-label union and widened/nullable paired fixture assertions. Host corrected owned files; parent fresh whole types exited0. Retained initial/final logs /tmp/bot-plan-c-task8-parent-types{,-final}.log.
