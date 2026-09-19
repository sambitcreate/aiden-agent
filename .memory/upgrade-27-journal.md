# Diagnostic journal deletion ordering — 2026-09-19

Base: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` (`origin/main`). Branch: `feature/upgrade-27-journal`.

`deleteDiagnosticJournalFiles` previously awaited a snapshot of the append queue without reserving deletion in it. Appends and rotations admitted during removal could write records which removal then erased. Snapshots could export old records while deletion was pending, and flush could finish without waiting for removal. Removal errors were returned but not reflected in journal failure status.

Deletion now captures the target and reserves its queue barrier before yielding. Prior appends finish before general-file deletion; later appends, retention, and export snapshots wait until deletion completes. The returned promise still rejects on failure, while the queue catches and records failure so subsequent operations remain usable. Successful recreation resets segment age.

Synchronous fatal writes bypass the append queue. Their bounded file is therefore reset synchronously at deletion admission, preserving fatal records accepted after the request even while the general queue drains. Fatal reset failures join the queued rejection/status path. This is still scoped best-effort file deletion, not a transactional all-or-nothing filesystem operation.

Research: Hermes `hermes_logging.py` at `69ae247cf3dba34a37ab4af8484b96d3559a4fcf` owns listener lifecycle under shared queue state; OMP `packages/utils/src/logger/rotating-file.ts` at `f97fa5c95010b62ac34c7357f9a1cae6975e12d6` keeps rotation and closure in its sink. Both MIT references supplied conceptual ownership lessons only; no code copied. Lane 23/PR 163 independently owns health aggregate deletion and is untouched.

Verification:
- Final journal tests against unchanged baseline: 19 existing tests passed and all 7 new regressions failed. Synthetic fixtures demonstrate lost new records, stale exported records, early flush, fatal record loss, successive deletion ordering, and both asynchronous/synchronous removal failure status.
- Fixed `npm run test:diagnostics`: 80 diagnostics tests plus 10 policy tests passed. Existing journal test registration covers all additions.
- `npm run type-check`, `npm run lint`, and `git diff --check` passed.
- No private journal data read. No UI, onboarding, shared server/native contract, schema, endpoint, retention limit, release or version change. Diagnostics plan status remains implemented with the existing physical-device acceptance gate. Hosted CI and independent review remain separate publication gates.

## Support boundary follow-up

Independent integration review found that `deleteAllDiagnosticData` repeated raw removal of live journal files after its owner finished, erasing fresh records. Capture the live journal's exact paths before invoking its deletion helper and exclude only those owned paths from the later allowlist fallback. The fallback still removes inactive-profile and legacy logs, disabled journal files, other diagnostic categories, and dumps, and still propagates removal errors. No health implementation files changed.

Deterministic production/development support regressions hold subagent cleanup after the journal barrier, write fresh general/fatal records and rotate the live log, then resume the outer sweep. Both fail against initial PR head `8b5e6ee4` and pass with the fix. Disabled-journal cleanup and inactive cleanup failure controls pass. Final `test:diagnostics`: 84 diagnostics + 10 policy pass; type-check and lint pass.
