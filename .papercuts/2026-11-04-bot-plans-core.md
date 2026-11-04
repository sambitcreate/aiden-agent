# Bot plans core papercuts — 2026-11-04

- Large batched reads truncated the Phase C plan; reread bounded sections before implementation.
- Plan text names the B authorization import as core `bot-access-requests.ts`; the concrete type lives in `renderer/shared/bot-access-requests.ts`. Use a type-only shared import.
- Approval revalidation needs the Bot identity even without a folder. Root approved `revalidate(botId, proposal)`.
- No durable task-settlement/receipt-GC port exists in the planned API. Keep compact ended receipts indefinitely rather than erase replay protection by age or count.
- Store audit reproduced four gaps with behavioral red tests: post-write deadline crossing, deletion fencing during admission, approval crossing its last awaited availability check, and equal-timestamp retention dropping the active record. Correct before handoff.
- Coverage check DTO has no policy/binding revisions. Root confirmed the store must invoke captured-proposal revalidation at coverage and final admission; current permission alone cannot prove the approved binding.
- A missing file after this process already observed a valid store must fail closed, rather than become an empty new store. Behavioral red reproduced an orphaned plan-owned grant; added a seen-store fence and synchronous owner revocation.
- Final verification: 45 behavioral tests pass (shared 5, validation 7, durable core 33); whole TypeScript and scoped ESLint pass. Core admission revalidates after durable write, then checks time/deletion immediately before synchronous invocation. Root owns runtime/harness/native acceptance.
- Additional red/green boundary audit: Stop/endRuns requested during admission's final awaited validator previously queued behind it and let a callback start. A per-Bot reference-counted intent fence now blocks starts immediately; transitions and revocation stay serialized. Final-step marks and replacement approvals fence conservatively too, with `finally` cleanup covering overlap/failure/irrelevance.
- Final core suite now has 37 passing behavioral tests (49 including shared and validation). Earlier 45-test note predates this last race audit.
