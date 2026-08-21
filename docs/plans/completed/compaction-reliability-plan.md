# Pi compaction compatibility and failure durability

Status: Completed

## Goal

Make Aiden's Pi runtime adapter a behavioral drop-in for the checked-out
upstream at `/Users/sambitbiswas/projects/opp/pi`. Compaction inputs, cut points,
summary prompts, output acceptance, retry classification, cache behavior, and
checkpoint reconstruction must match upstream. Aiden must not add a stricter
summary schema or reject a checkpoint that upstream accepts.

The production incidents on 2026-08-16 exposed two separate adapter issues:

- a local provider connection failed twice, but the durable chat retained only
  a generic error and lost the useful safe category after reload;
- Pi produced compaction responses successfully, but Aiden's additional
  structural validator rejected them and stopped a safe tool turn.

## Source of truth

The compatibility baseline is Pi commit
`b1efcf7d7c5d7394fbb12ede0174e04d39ee7004`, especially:

- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/agent/src/harness/session/context.ts`
- `packages/agent/src/harness/session/types.ts`
- `packages/agent/src/harness/agent-harness.ts`
- Pi's corresponding compaction and harness tests

Audited source SHA-256 values at that commit:

- `packages/agent/src/harness/compaction/compaction.ts`:
  `c66792a482845f425e9a384e2d686b322a18b43af71b68d614377877c0cd3e45`
- `packages/agent/src/harness/session/context.ts`:
  `dc8c32bebff5aabd896044994e70e8d47ced06e5170ff80aa1c6318680cbed9c`
- `packages/coding-agent/src/core/agent-session.ts`:
  `c83f43205f0b0ef014a383b4969f2bce112a8b4280f6e9f889eeae0d7e02ec2e`
- `packages/coding-agent/src/core/settings-manager.ts`:
  `2a1a01cbbc6c04b7593611a8ae71e8d182444417ac50d31d63a86294673c2a31`

Aiden remains pinned to its released Pi package until the session-format
migration is ready. The local adapter may translate between the old
`firstKeptEntryId` journal and current upstream's self-contained retained-tail
checkpoint, but that translation may not change semantic behavior.

## Compatibility rules

1. Use Pi's preparation and cut-point selection without Aiden-owned recutting.
2. Use Pi's exact prompts and split-turn assembly, including its current
   previous-summary behavior.
3. Accept or reject summary responses exactly as Pi does. Remove Aiden's
   required-heading/marker validator and do not add a repair prompt.
4. Match Pi's stop-reason handling: aborted/error summary responses fail;
   every other response, including empty and length-stopped output, is accepted
   according to upstream behavior.
5. Match Pi's bounded transient retry policy, abort precedence, fresh summary
   request session identity, and `cacheRetention: "none"` behavior.
6. Match Pi's threshold/reserve/retained-tail rules. Do not introduce a second
   Aiden pressure threshold into the semantic checkpoint decision.
7. Preserve Pi's tool-call/result ordering and session reconstruction exactly.
8. A failed/cancelled compaction does not commit a checkpoint.
9. Aiden-only persistence wrappers may add transaction safety, privacy-safe
   logs, cancellation quarantine, and renderer DTOs, but may not alter Pi's
   compaction result.
10. Provider failure presentation is an Aiden UI concern: persist only a closed
    safe category, attempts, and retry exhaustion; never expose raw provider
    text outside the private journal.

## Delivery phases

### Phase 1 — parity inventory

- Record the exact upstream commit and relevant file hashes in tests/docs.
- Create a behavior matrix for preparation, split turns, empty/error/aborted/
  length responses, transient retry, cancellation, and repeated compaction.
- Identify every Aiden-only semantic branch in `pi-compaction-core.ts`.

### Phase 2 — upstream-compatible adapter

- Remove Aiden's structural continuity validator and schema-repair behavior.
- Remove Aiden-only map/reduce or recutting from the semantic checkpoint path
  where upstream does not perform it.
- Copy current upstream's standalone summary request behavior: the configured
  bounded transient retry policy, one fresh identity per logical request, and
  disabled cache retention.
- Keep only the minimum old-session translation needed for Aiden's pinned Pi
  journal, without changing accepted output or reconstructed context.
- Add parity tests whose fixtures and expected outcomes mirror upstream tests.

### Phase 3 — Aiden-owned durable failure UX

- Classify provider terminals into a versioned closed set: network, timeout,
  service unavailable, rate limit, authentication, quota, invalid request,
  context window, output limit, interrupted, context management, and unknown.
- Persist category, attempts, and retry exhaustion on the visible assistant.
- Render the same fixed callout live, after route changes, and after reload.
- Keep raw provider text in the private Pi journal only.

### Phase 4 — independent review and publication

- Send two fresh-memory reviewers: one for upstream parity and compaction edge
  cases, one for persistence/privacy/renderer correctness.
- Fix all scoped P0/P1 findings and relevant regressions.
- Run all gates, archive this plan, update project memory, and open a draft PR.

## Required parity regressions

- Pi preparation chooses the same cut and retained tail for the same branch.
- Normal, split-turn, previous-summary, and repeated compaction output match
  current upstream behavior byte-for-byte after session-format translation.
- A non-empty summary without Aiden's former required headings is accepted.
- Empty and length-stopped outputs follow upstream acceptance and commit a
  checkpoint; error, aborted, and cancelled responses commit no checkpoint.
- A transient hidden summary failure uses upstream's retry count/backoff;
  non-retryable failure starts no extra request.
- Every hidden summary request has a fresh session identity and disables cache
  retention.
- Provider connection/auth/quota/429/5xx/context/output failures map to stable
  safe categories and survive reload without raw error text.

## Gates

- upstream parity fixture tests
- `npm run test:compaction`
- focused chat-store, provider-category, and renderer tests
- `npm run type-check`
- `npm run lint`
- `npm run test`
- `npm run build:electron`
- `git diff --check`

## Deferred

- upgrading the installed Pi package and migrating journals to retained-tail
  checkpoints
- fixing compaction behavior that remains unchanged in current upstream
- provider-native compaction
- raw diagnostic upload or remote telemetry
- UI retry buttons and provider-specific remediation flows

## Completion

Completed on 2026-08-16. Aiden now matches the audited Pi baseline for
compaction acceptance, request identity, retry, thresholds, cut points, and
checkpoint reconstruction while retaining only Aiden-owned transaction,
privacy, and renderer projection boundaries. Closed provider-failure metadata
survives persistence, copy/fork, route changes, and reload without exposing raw
provider diagnostics. Two fresh-memory reviews returned GO with no scoped
P0/P1 findings. The final compaction suite passed 181/181 with zero skips.
