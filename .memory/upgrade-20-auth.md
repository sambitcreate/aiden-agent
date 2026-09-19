# Provider credential cancellation — 2026-09-19

Baseline: `5cc831a17aa8971fb5b89c7dd9278a6ec4022beb`.

The encrypted Pi credential adapter omitted the optional `AuthOperationOptions`
accepted by pinned Pi 0.84.4. An aborted queued modify/delete could still execute,
and a refresh resolving after cancellation could still publish its credential.

`pi-credential-store-core.ts` now races callers against cancellation while leaving
underlying provider/document locks held until work settles. It checks cancellation
before invoking modifiers, after asynchronous credential preparation, and directly
before atomic rename. Rename begins the irreversible publication boundary: later
abort cannot report cancellation for a committed mutation. Aborted staged writes
remove temporary files. Reads/listing also honor cancellation.

Five regressions failed on baseline. The final focused run passes 64 tests across
credential storage, auth flow, rotation core and pinned provider contracts;
`npm run type-check`, `npm run lint`, and `git diff --check` pass. The existing
credential test file is already registered in `test` and `test:coverage`.
No UI, wire contract, native client, onboarding capability or credential format
changes. No live sign-in, paid API or credential inspection was performed. Hosted
CI and independent review remain separate gates.

Reference lessons (read-only; original implementation, no copied source):

- Pi `2a9b4ebc680053c64e31f635b0b22d5e22564001`, MIT:
  `packages/ai/src/auth/credential-store.ts` retains its mutation chain during
  cancellation and checks abort before publication. `packages/ai/src/models.ts`
  passes signals through credential operations. Confirmed the same API in Aiden's
  installed 0.84.4 declarations/runtime.
- Prime Agent `c5991bc853d27754aed345c13ff4d2e05c40f1f4`, MIT:
  `packages/coding-agent/src/core/auth-storage.ts` rechecks current credentials
  under its OAuth refresh lock. Preserve Aiden's corresponding shared locks.
- OpenCode v2 `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, MIT:
  `packages/opencode/src/provider/auth.ts` separates pending OAuth callbacks from
  persistence. Retain Aiden's stronger existing document/session ownership.

Rejected hypotheses: coordinator cleanup is already bounded and late credentials
are fenced; rotation reconciliation already binds keys to connection snapshots.
Deferred independent candidate: scoped catalog refresh's publish callback lacks
abort/supersession guards. Do not widen this credential-only PR.
