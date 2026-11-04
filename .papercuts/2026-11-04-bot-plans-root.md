# Phase C root integration

- Acceptance docs staging: `git add` listed tracked files beneath ignored `.memory/` as ignored and exited 1, although all selected files were staged. Checked index and committed the exact intended five tracked files. Use `git add -u` for tracked project memory updates.
- Planned approval-time callback omitted botId. Core worker will accept `revalidate(botId, proposal)` so production singleton can re-admit the correct Bot without private IDs in public DTOs.
- Plan API lacks originating durable task identity/settlement GC port. Core worker retains minimal hashed ended receipts rather than unsafe time/size eviction; full display history remains bounded.

- Sorting registry lane files created unrelated order churn. Rebuilt only the two added entries against the preserved HEAD layout; no existing membership changed.

- Core audit: persist-before-start does not itself fence time spent awaiting publication. Requested a final post-write deadline check and held-write test before callback invocation. Captured plan binding must also be checked at coverage/admission rather than inferred only from current allowed server/name.

- Integration found C shared response/store Bot ID regex rejected production `bot:<uuid>` IDs. Requested real-mint behavioral red and reuse of the existing path-safe shared guard before Gate4.
- Unlabelled person inputs cannot use numeric submission IDs alone for persistent plan ownership because recovery can reuse them. Proposed separate durable host UUID identities; raw request IDs remain the provenance authority.
