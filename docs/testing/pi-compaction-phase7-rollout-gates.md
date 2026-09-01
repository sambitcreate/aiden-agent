# Pi compaction Phase 7 rollout gates

Status: automated evaluation and signed development-package acceptance pass;
installed production and credentialed-provider evidence remains **Pending** until
the release owner runs the steps below against the installed candidate.

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

Set `AIDEN_PI_UPGRADE_BEHAVIOR_ENABLED=0` before app startup and restart Aiden. This disables new v4 journal creation, legacy migration, automatic/manual Pi checkpoint generation, and durable-memory retrieval or writes. Existing v4 journals remain readable and are not downgraded or rewritten. Remove the override and restart to resume the persisted rollout stage.

## Provider-native re-audit

Re-audited on 2026-08-31 against Pi Core `0.84.4`, `narumiruna/pi-extensions` at `36c2421544f0defaebd3d44b793d39b2a7f5fb47`, and `YeungKC/pi-codex-compact` at `53630cd9b937a8a4873271e20188c3f18819ca6a`.

The current Pi extension API exposes local session inspection and a trigger for Pi compaction, but not a provider-owned authoritative-thread reconciliation/deletion contract. The Codex-specific extension persists opaque remote checkpoints and explicitly documents unavailable capability metadata, token accounting, mid-turn continuation, retry settings, and WebSocket response metadata. Those limits prevent Aiden from proving cross-surface authoritative-thread reconciliation and deletion semantics.

Decision: provider-native compaction is deferred. Aiden's audited local Pi v4 checkpoint remains the cross-provider baseline. Reconsider only when an adapter can prove exact server/local checkpoint ownership, model-switch behavior, fork/retry recovery, deletion, offline reconstruction, and Mac/Telegram/mobile reconciliation without weakening the local rollback path.

Pinned inspected files: [Pi compaction implementation at the audited 0.84.4 tag](https://github.com/badlogic/pi-mono/blob/v0.84.4/packages/coding-agent/src/core/compaction/compaction.ts), [Pi extension context types at 0.84.4](https://github.com/badlogic/pi-mono/blob/v0.84.4/packages/coding-agent/src/core/extensions/types.ts), [pi-codex-compact native implementation](https://github.com/YeungKC/pi-codex-compact/blob/53630cd9b937a8a4873271e20188c3f18819ca6a/native-compaction.ts), and [its extension entrypoint](https://github.com/YeungKC/pi-codex-compact/blob/53630cd9b937a8a4873271e20188c3f18819ca6a/index.ts).
