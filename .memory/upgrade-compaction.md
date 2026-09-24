# Upgrade lane 02: failed compaction checkpoint recovery

Implemented against Aiden `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb` on `feature/upgrade-compaction`.

## Finding and behavior

`PiCompactionCoordinator.run` could append a checkpoint and then fail to reconstruct context, returning `session-failed` while keeping the checkpoint active. A rejected append acknowledgement after publication had the same outcome. Cancellation could also skip its existing rollback when reconstruction failed first.

Publication/reconstruction failures now restore the exact prior leaf when the active leaf is the operation's checkpoint. An append that never published needs no move. A newer leaf is never rewound. Recovery read/write failures retain the closed `session-failed` result and never enable retry. Checkpoint entries remain in append-only history, while the restored branch survives reopening a JSONL session.

This is an Aiden persistence correction. Pi summary acceptance, retained-tail selection, thresholds and provider retry semantics are unchanged. No public DTO, mobile UI, first-run configuration or durable memory store changed; no onboarding or plan-status update is needed.

## Source learning

- Pi `/Users/sambitbiswas/projects/opp/pi` at `2a9b4ebc680053c64e31f635b0b22d5e22564001`, `packages/coding-agent/src/core/agent-session.ts`: publication and context installation are adjacent parts of compaction completion. Its synchronous path informed reviewing Aiden's asynchronous failure boundary. MIT.
- Prime Agent `/Users/sambitbiswas/projects/opp/prime-agent` at `c5991bc853d27754aed345c13ff4d2e05c40f1f4`, `packages/coding-agent/src/core/agent-session.ts`: abort is checked immediately before checkpoint publication and context installation. MIT.
- context-mode `/Users/sambitbiswas/projects/opp/aiden-plugins/context-mode` at `de53368caf1c88159bcc4f665fe87dfa1ec2b000`, `hooks/precompact.mjs`: persistent recovery context across compaction boundaries. Elastic License 2.0; behavioral reference only.

Original implementation; no reference source copied or reference repositories edited.

## Verification

- Added six tests to the already registered `pi-compaction-core.test.ts`. Four failed before the fix. Tests cover failure before/after append, reconstruction failure, cancellation plus reconstruction failure, preserving newer evidence, rollback failure, safe error reporting, and real JSONL reopen.
- Focused core/session-port/lifecycle/harness/surface suites: 141 passed.
- `npm run test:compaction`: 22 VCC tests + 293 compaction-related tests passed, zero skips.
- `npm run type-check`, `npm run lint`, `git diff --check`: passed.
- Inspected iOS/Android compact-context projection consumers; no contract changes or native suites required. No Electron packaging, visual acceptance, full npm test, merge, or release performed.
- Hosted CI and independent campaign review are separate gates, tracked in the campaign status JSON.
