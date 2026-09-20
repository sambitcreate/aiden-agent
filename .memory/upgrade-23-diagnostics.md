# Diagnostic health deletion ordering — 2026-09-19

Base: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` (`origin/main`).
Branch: `feature/upgrade-23-diagnostics`.

## Finding and change

`deleteDiagnosticHealth` used to await the current persistence promise before resetting its database, and removal was not queued. A flush accepted during that wait could snapshot pre-deletion counts, then republish them after deletion; the late reset also discarded newly admitted in-memory counts.

Reset the in-memory aggregate and cancel its pending timer synchronously at deletion admission. Capture the sink path and enqueue removal after prior writes and before later snapshots. The caller receives removal failures, health status records them, and the settled queue remains usable for subsequent persistence and deletion retries. Ordinary diagnostics remain enabled, so fresh events can create fresh aggregates after deletion.

No journal schema, shared server/native contract, UI, onboarding, privacy scope, endpoint, or retention limit changed. The existing `test:diagnostics` script already registers the health test file. The diagnostics plan remains implemented with its existing physical-device acceptance gate; its status did not change.

## Research

- Hermes `hermes_logging.py`, commit `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`, MIT; file SHA-256 `ff5e0755ef0ff0cbed2ceda8b8b0c832b1bcea8252f11bbceb2cde1fe8393fb5`. Queue listener registration/stop share lifecycle ownership, and hard-exit drains are bounded.
- OMP `packages/utils/src/logger/rotating-file.ts`, commit `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`, MIT; file SHA-256 `323979ef1297ffb94469da0aca0202892cc2328347a6a91e6dcb659d7e062de4`. Sink closure is explicit and rotation/retention belong to the sink.
- Waku `src/app.rs`, commit `6d433e875d57091906ec0770d8bb9ffc9aa29b83`, GPL-3.0; file SHA-256 `c28f7b9c7140e516af5c5cbf2a36f2061fcc52c7155aef9ea1d7a9a1045eae0b`. Prepared drivers retain their event receivers and stop targets capture operation identity. Conceptual lifecycle ownership reference only.

Implementation and tests are original; no reference code was copied. All references were read-only local source material.

Rejected candidates: shutdown already passes explicit 1000 ms deadlines to both flushes; ordinary general export already reserves a journal snapshot barrier. General journal deletion also lacks a queue barrier, but this PR selects the demonstrated aggregate-history resurrection and leaves that adjacent path for separate work.

## Verification

- Final synthetic health tests against unchanged baseline: 5 pass, 3 fail (old counts resurrect on disk, flush does not await deletion, deletion failure is missing from sink health).
- Fixed `npm run test:diagnostics`: 77 diagnostics tests and 10 policy tests pass, including 8 health tests. Fixtures use synthetic categorical counts only.
- `npm run type-check`: pass. `npm run lint`: pass; changed test files linted again after type annotation and barrier coverage additions.
- `git diff --check`: pass.
- No broad application test, build, Electron run, native acceptance, deployment, or release was needed or claimed for this main-local storage ordering change. Exact-head hosted CI and independent review are separate publication gates.
