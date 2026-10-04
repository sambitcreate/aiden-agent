# Run journal coalescing and approval allowlist — 2026-10-03

Follow-up to PR #310 (host run observer bus), findings PR-310-1/2/4/6 and MAIN-12 / EXT-31. PR #310 was squash-merged (`1c5e404b1`) while this work was in progress, so these commits sit on top of its pre-squash head and need their own PR against `main`.

## Approval details (PR-310-1)

`projectApprovalDetails` in `main/services/run-event-projection.ts` is the single allowlist for approval details in both the Remote stream journal and `HostRunRegistry`. Assistant-automation and scheduled-task details keep only their declared keys; the subagent kinds are cloned because their guards already require exact key sets. Anything else, or a value that throws while cloning, is dropped. The registry marks a prompt whose details were rejected with `detailsOmitted: true`. Add a new detail kind's keys here when `ToolApprovalDetails` gains one, or it will silently disappear from observers.

## Delta folding (PR-310-2)

Consecutive `text_delta` / `reasoning_delta` events fold into the tail event while it is undelivered: same type, within the window (Remote `persistCoalesceMs`, registry `deltaCoalesceMs`, both default 250 ms, 0 disables), no state change, not terminal, merged text at most 200,000 UTF-16 units (`MAX_DELTA_TEXT_LENGTH`) and the serialized event at most 256 KiB (`MAX_COALESCED_DELTA_EVENT_BYTES`, inside the 1 MiB native SSE frame cap). The tail is replaced, not mutated, because size caches key on the event object, and it keeps its sequence. An event is sealed once sent on SSE or returned by registry `read()`, so live observers still get one event per token and sequences stay contiguous. iOS and Android append `textDelta` text and require `id == sequence`; neither needed changes.

## Persistence (MAIN-12)

- `tool_started` / `tool_finished` persist immediately with prompts, cancel, snapshot and terminal events.
- `snapshotBytes()` is incremental: `turnIndexBytes` follows insertion and eviction, envelope sizes are cached per state plus `String(updatedAt).length`. `assertExactSnapshotBytes` remains the oracle.
- `DataStore` has an opt-in `compact` option; the stream store uses it with `maxBytes` = snapshot cap + 1, so indented journals from older builds still load.

Measured, 2,000 tokens at 20 ms: `main` 2,002 saves / 552 MiB indented; pre-fix branch 156 saves / 42.7 MiB; now 156 saves / 2.4 MiB compact with 157 journal events (no subscriber), or 23.9 MiB with a live subscriber (2,003 events). Registry, 10,000 tokens: `lastSequence` 10,001 → 771, and a late observer replays events instead of getting `snapshot_required`.

## Tests (PR-310-6)

`host-runs.ts` is now pure (`createHostRunRecorders(warn)`, `hostRunOriginFor`); the Electron singletons live in `host-runs-main.ts`, so `host-runs.test.ts` imports the module directly. The root lib is ES2020: no `findLast`, `.at()` or `Object.hasOwn`.
