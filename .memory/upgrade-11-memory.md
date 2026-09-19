# Upgrade 11 — expired memory renewal

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` (origin/main).

`MemoryStore.put` previously deduplicated against expired rows still marked active. Re-approving the same normalized text returned the expired citation and discarded the new provenance, expiry, confidence, and always-on selection; recall stayed empty. Explicit replacement also rejected collisions with expired text.

Deduplication now matches the read-side expiry boundary (`expires_at <= now` is expired). A newly approved insert retires the expired exact-text row inside the same transaction, retaining historical text/provenance. Explicit replacement links remain exactly as supplied; no automatic supersession link or approval change is introduced. Failed insertion rolls back retirement and any explicit supersession. Existing live duplicates remain idempotent, scope filters remain exact, and quota checks run before mutation.

Reference lessons (behavior only; no copied source):
- Hermes `tools/memory_tool.py` at `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`: deduplication and mutation use current durable state under a lock.
- context-mode `src/store.ts` at `de53368caf1c88159bcc4f665fe87dfa1ec2b000`: atomic dedup plus insert preserves indexed state on failure.
- OMP `packages/mnemopi/src/core/polyphonic-recall.ts` at `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`: validity requires both non-supersession and an unexpired validity window within scope.

Validation: all four new store regressions fail on baseline and pass after the fix. Store/context/surface-matrix tests: 24 pass. Memory-policy suite: 8 pass. Type-check and scoped ESLint pass. Existing test registration in `test:compaction` already includes this file. No schema, wire contract, native implementation, UI, or onboarding change; no new feature is advertised. No broad mobile suites, Electron build, or visual checks run for this store-only change. Hosted CI and independent review remain separate gates.

Open PR #121 changes the same store for shared CLI memory and moves write prechecks into a transaction, but retains this expired-duplicate defect. The expiry fix is independent; later integration must preserve both transaction admission and expired-row retirement.
