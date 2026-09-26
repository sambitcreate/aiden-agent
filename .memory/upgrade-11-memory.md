# Upgrade 11 — expired memory renewal

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` (origin/main).

`MemoryStore.put` previously deduplicated against expired rows still marked active. Re-approving the same normalized text returned the expired citation and discarded the new provenance, expiry, confidence, and always-on selection; recall stayed empty. Explicit replacement also rejected collisions with expired text.

Deduplication now matches the read-side expiry boundary (`expires_at <= now` is expired). A newly approved insert retires the expired exact-text row inside the same transaction, retaining historical text/provenance. Explicit replacement links remain exactly as supplied; no automatic supersession link or approval change is introduced. Failed insertion rolls back retirement and any explicit supersession. Existing live duplicates remain idempotent, scope filters remain exact, and quota checks run before mutation.

Reference lessons (behavior only; no copied source):
- Hermes `tools/memory_tool.py` at `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`: deduplication and mutation use current durable state under a lock.
- context-mode `src/store.ts` at `de53368caf1c88159bcc4f665fe87dfa1ec2b000`: atomic dedup plus insert preserves indexed state on failure.
- OMP `packages/mnemopi/src/core/polyphonic-recall.ts` at `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`: validity requires both non-supersession and an unexpired validity window within scope.

Validation: all four new store regressions fail on baseline and pass after the fix. Store/context/surface-matrix tests after review follow-ups: 33 pass. Memory-policy suite: 8 pass. Type-check and scoped ESLint pass. Existing test registration in `test:compaction` already includes this file. No schema, wire contract, native implementation, UI, or onboarding change; no new feature is advertised. No broad mobile suites, Electron build, or visual checks run for this store-only change. Hosted CI and independent review remain separate gates.

Open PR #121 changes the same store for shared CLI memory and moves write prechecks into a transaction, but retains this expired-duplicate defect. The expiry fix is independent; later integration must preserve the admission transaction and expired-row retirement described below.

## Pullfrog follow-up — atomic admission

Current-main ownership remains one main-process store: `memory-store-main.ts` is the only production constructor; Electron takes its profile single-instance lock before handler startup and the losing instance quits. Same-process admission-through-commit is synchronous. Runtime-profile/bootstrap tests (16) and the temporary three-scenario concurrent-call probe passed. No production race was reproduced in that topology.

For direct renewal consistency and upcoming #121 shared-store integration, `put` now acquires `BEGIN IMMEDIATE` before reading supersession, duplicates, or either quota. A live duplicate commits before returning; rejection rolls back. Expired-row retirement additionally matches the expected scope, normalized text, active state, and expired timestamp. No CLI, setup, migration, retry, or database-opening changes were imported.

Deterministic tests use a separate real SQLite connection that commits exactly before the store acquires the lock. All four scenarios fail on the prior PR head and pass after correction: expired ID deletion/reuse in another scope, competing fresh renewal/idempotent return, last always-on slot, and last scope slot. They also verify rollback and transaction release. Preserve these tests and transaction placement when integrating #121; tests model two writers on two connections, not a launched CLI/desktop multi-process deployment.

## Pullfrog follow-up — lock-admission clock

`put` now samples its one transaction timestamp only after `BEGIN IMMEDIATE` succeeds. Requested-expiry validation, collision/quotas, retirement, and inserted timestamps consistently use that admitted time, so waiting for a shared-store writer cannot reuse a pre-wait timestamp. Deterministic tests advance the injected clock in a second-connection transaction that commits before the target BEGIN: both quota scenarios renew an expired collision with fresh timestamps/provenance, and an input expiry that elapsed before admission rejects before superseding anything. These verify post-admission clock ordering; they do not exercise an actually blocked SQLite lock wait. All scenarios fail on `9b38a74170c9709562ce7eed30624e1f45a2fc6b` and pass after the correction. This remains shared-writer integration hardening, not a reproduced current-main production lock race.
