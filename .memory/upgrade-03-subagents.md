# Upgrade 03: resilient subagent inference shutdown

2026-09-19. Based on origin/main `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

The inference owner previously stopped escalating if its TERM operation threw.
An out-of-sequence worker event also bypassed the shared stopping promise,
allowing duplicate cancellation and unobserved cleanup rejection. A throwing
cleanup observer could reject the detached shutdown promise as well.

All protocol/cancellation stops now share the idempotent cleanup owner. TERM
failure continues to identity-checked hard kill and exit verification. Cleanup
observer exceptions cannot suppress the sticky unhealthy state. Unverified
processes remain owned; no terminal result is published until exit is observed.

References (read-only, MIT; original implementation, no source copied):
- `/Users/sambitbiswas/projects/opp/aiden-plugins/pi-subagents` at
  `e69de39787257f9ef61842d35654e3079ff0ae32`:
  `src/runs/shared/external-cli-runner.ts`, `src/shared/post-exit-stdio-guard.ts`,
  `src/runs/background/process-terminal.ts`: best-effort signals, one escalation,
  and separate process-terminal proof.
- `/Users/sambitbiswas/projects/opp/prime-agent` at
  `c5991bc853d27754aed345c13ff4d2e05c40f1f4`:
  `packages/coding-agent/src/cli/owned-session-worker.ts`: cleanup continues
  across signaling failures while retaining process identity checks.
- `/Users/sambitbiswas/projects/opp/omp` at
  `f97fa5c95010b62ac34c7357f9a1cae6975e12d6`:
  `packages/coding-agent/src/task/isolation-ownership.ts`: ownership belongs to
  an exact process instance; signaling/liveness uncertainty is not exit proof.

Validation: two regression cases failed on unchanged production code; all 36
`npm run test:subagents:inventory` tests pass after the fix, including the third
regression for observer failure and late exit. `npm run type-check` and
`npm run lint` pass. Existing test script already registers the modified test.

No shared/native/UI contracts or onboarding capabilities changed. No plan phase
advanced. Packaged Electron/provider smoke and physical-device tests were not
run for this main-process-only change. Hosted CI and central independent review
remain separate delivery gates.
