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
