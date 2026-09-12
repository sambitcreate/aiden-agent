# Pi compaction Phase 7 rollout gates

Status: automated evaluation and signed development-package acceptance pass;
installed production and credentialed-provider evidence remains **Pending** until
the release owner runs the steps below against the installed candidate.
Generation is never blocked by the rollout gates at any stage:
rollout-ineligible chats generate **journalless** over an in-memory session
instead of failing (see "Journalless generation" below), so advancing the
stage is a durability decision, not an availability one.

## Device-local evaluation receipt

1. Install dependencies from the reviewed lockfile with `npm ci`.
2. Run the registered compaction suite with `npm run test:compaction`.
3. Choose the installed candidate's `pi-upgrade-rollout` directory and exact executable, then run:

   ```sh
   AIDEN_PI_UPGRADE_RECEIPT_DIR="/absolute/device/user-data/pi-upgrade-rollout" \
   AIDEN_PI_UPGRADE_EXECUTABLE="/Applications/Aiden Agent.app/Contents/MacOS/Aiden Agent" \
   AIDEN_BUILD_ID="release-owner-build-id" \
   npm run test:compaction:evaluate
   ```

The executable replay runner drives all seven required cases through the real Pi coordinator or the production emergency projector. The private receipt contains exact per-case measurements and a recomputed aggregate report. Rollout rejects missing cases, extra schema fields, invented zero measurements, threshold failures, or a report that does not exactly match its measurements.

## Installed migration, restart, rollback, and signature receipt

Run this only against the explicit installed candidate, using the same receipt directory and build ID the app will see:

```sh
AIDEN_PI_UPGRADE_RECEIPT_DIR="/absolute/device/user-data/pi-upgrade-rollout" \
AIDEN_BUILD_ID="release-owner-build-id" \
npm run test:compaction:packaged -- "/Applications/Aiden Agent.app"
```

The harness seeds a low-risk v3 fixture, opens it in the packaged app, verifies its migration receipt and byte-exact owner-only backup, removes the receipt to rehearse the promotion crash window, restarts to prove idempotent recovery, and launches once with `AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED=0` to prove the journal remains readable and byte-stable while upgraded compaction/memory behavior is disabled. It then requires strict `codesign` verification and atomically writes a private installed receipt bound to the complete `.app` bundle SHA-256, explicit build ID, and exact evaluation-receipt SHA-256.

Do not advance to `v4_only` unless both receipts were produced on that device for that exact installed executable. The app advances only one stage at a time and reloads the current device document under an exclusive lock before each write.

Advance exactly one stage with the same identity inputs:

```sh
AIDEN_PI_UPGRADE_RECEIPT_DIR="/absolute/device/user-data/pi-upgrade-rollout" \
AIDEN_PI_UPGRADE_EXECUTABLE="/Applications/Aiden Agent.app/Contents/MacOS/Aiden Agent" \
AIDEN_BUILD_ID="release-owner-build-id" \
npm run pi-upgrade:advance -- migrated_low_risk_chats
```

Repeat only after observing the current stage and completing the next cohort's acceptance. The command cannot skip or regress a stage, validates the evaluation receipt against the complete signed `.app` digest, and requires the installed receipt for `v4_only`.

## Rollback

Set `AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED=0` before app startup and restart Aiden. This disables new v4 journal creation, legacy migration, automatic/manual Pi checkpoint generation, and durable-memory retrieval or writes. Existing v4 journals remain readable and are not downgraded or rewritten. With the journalless safety net, chats that have no existing v4 journal continue to generate in the rollback environment — journalless over an in-memory session — rather than failing; durable compaction, memory, and history recall stay disabled for them until the override is removed and the persisted rollout stage resumes. Remove the override and restart to resume the persisted rollout stage.

## Journalless generation (safety net)

`PiCompactionSessionStore.openChatIfEligible()` probes eligibility and reports a
structured reason instead of throwing; `openChat()` keeps its fail-closed
contract for background callers. When the probe reports a reason, the
generation runs over an in-memory session and **no durable journal is created
and no legacy migration runs** — the fail-closed rollout contract is preserved
verbatim.

It engages exactly when a chat cannot yet hold a durable journal:

- Stage `new_chats` (production default): chats created before the policy's
  `activatedAt` (the first launch of the Pi-upgrade build on that device).
- Any stage: chats whose legacy v3 journal is still deferred (its cohort has
  not reached `migrated_low_risk_chats`, or it exceeds that stage's 500-entry
  limit). The v3 bytes are never touched.
- The rollback environment (`AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED=0`): chats
  without an existing v4 journal.

Semantics of a journalless run: the request path is identical, visible turns
persist through the chat store exactly as with journaled runs, but VCC history
recall is omitted (nothing durable to recall), todo replay reads the empty
in-memory journal (the todo panel reports the snapshot unavailable),
automatic and manual Pi checkpoints stay cohort-disabled, effect-recovery
boundaries are written only in-process and never acknowledged as durable, and
the durable store can never be quarantined by an in-memory failure.

Verify on a device (any pre-activation chat): send a message — generation
succeeds; no new journal appears for that chat under the app's
`pi-compaction-sessions` storage; its todo snapshot reports unavailable;
requesting compaction resolves as already compact enough. Advancing the stage
(below) restores durable journals — creation becomes unconditional at
`migrated_low_risk_chats`, legacy v3 migration unlocks for journals of up to
500 entries, and later stages follow the cohort ladder to `v4_only`.

## Provider-native re-audit

Re-audited on 2026-08-31 against Pi Core `0.84.4`, `narumiruna/pi-extensions` at `36c2421544f0defaebd3d44b793d39b2a7f5fb47`, and `YeungKC/pi-codex-compact` at `53630cd9b937a8a4873271e20188c3f18819ca6a`.

The current Pi extension API exposes local session inspection and a trigger for Pi compaction, but not a provider-owned authoritative-thread reconciliation/deletion contract. The Codex-specific extension persists opaque remote checkpoints and explicitly documents unavailable capability metadata, token accounting, mid-turn continuation, retry settings, and WebSocket response metadata. Those limits prevent Aiden from proving cross-surface authoritative-thread reconciliation and deletion semantics.

Decision: provider-native compaction is deferred. Aiden's audited local Pi v4 checkpoint remains the cross-provider baseline. Reconsider only when an adapter can prove exact server/local checkpoint ownership, model-switch behavior, fork/retry recovery, deletion, offline reconstruction, and Mac/Telegram/mobile reconciliation without weakening the local rollback path.

Pinned inspected files: [Pi compaction implementation at the audited 0.84.4 tag](https://github.com/badlogic/pi-mono/blob/v0.84.4/packages/coding-agent/src/core/compaction/compaction.ts), [Pi extension context types at 0.84.4](https://github.com/badlogic/pi-mono/blob/v0.84.4/packages/coding-agent/src/core/extensions/types.ts), [pi-codex-compact native implementation](https://github.com/YeungKC/pi-codex-compact/blob/53630cd9b937a8a4873271e20188c3f18819ca6a/native-compaction.ts), and [its extension entrypoint](https://github.com/YeungKC/pi-codex-compact/blob/53630cd9b937a8a4873271e20188c3f18819ca6a/index.ts).
