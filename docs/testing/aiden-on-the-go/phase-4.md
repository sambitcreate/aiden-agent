# Aiden On The Go — Phase 4 evidence

Date: 2026-08-19
Status: Complete — The authenticated remote API supports chat CRUD, atomic remote turns, resumable server-owned generation streams, cancellation, approvals, and a privacy-safe provider/model catalog.

## Implementation boundary

- Chat list/get/create/rename/delete and empty-chat move use path-free DTOs, exact parsers, scoped durable idempotency, and revision assertions inside the shared serialized chat mutation boundary. Desktop and remote clients receive immediate chat invalidation after mutations.
- Remote turn creation commits one user message through the existing turn-admission lease, then transfers generation to a stable device-and-stream-bound owner. A setup failure after the append returns the accepted message plus a terminal error stream; an indeterminate append remains durably in flight rather than becoming retryable.
- The bounded SSE journal records typed status, text, reasoning, tool, timeline, approval, terminal, error, cancellation, and reconciliation events with monotonic sequence IDs. Reconnect replays from `Last-Event-ID`; future cursors fail closed and pruned gaps receive an authoritative snapshot.
- Disconnecting delivery does not cancel main-owned work. Explicit cancellation, approval expiry, device revocation, restart interruption, journal retention, and persistence settlement all preserve per-device ownership and terminal reconciliation.
- Provider/model projection includes only configured chat-capable choices and contains no credentials, endpoint URLs, authentication methods, or embedding-only entries. Remote turns cannot enable Computer Use and retain the workspace's existing permission/tool contract.

## Review outcome

The between-phase review was performed locally, following the user's direction not to use subagents. It covered cross-device stream and approval isolation, duplicate sends, stale revisions, post-append setup failures, unknown append outcomes, reconnect gaps, cancellation and approval replay, approval expiry, device revocation, restart recovery, model secrecy, desktop cache refresh, disabled-start side effects, and deletion ordering.

Review fixes added automatic expiry denial for unattended approvals, coalesced stream-journal persistence, graceful quit settlement, a pre-side-effect delete revision check plus an authoritative final check, and compatibility preservation for removing an indexed chat whose payload is corrupt. No production failure remains at the Phase 4 gate.

## Tests

```text
npm run test:aiden-remote
PASS — 102 TypeScript tests plus 4 transport spike tests

npm run test:aiden-service-boundary
PASS — 13 tests

npx playwright test tests/e2e/remote-access-lifecycle.spec.ts --config=playwright.config.ts --fail-on-flaky-tests
PASS — 1 test

npm run type-check
PASS

npm run type-check:e2e
PASS

npm run lint -- --no-fix
PASS

npm run build
PASS

npm test
PASS — complete TypeScript/JavaScript, native helper, Git safety, and Rust lifecycle gate
```

The real HTTP integration test starts one mocked remote turn, reconnects and replays its SSE journal without duplicating the prompt, allows and denies device-owned approvals, cancels a turn, and verifies the final append count. A signed Debug build with the approved Aiden identifiers was installed and launched on the physical iPhone 13 Pro; the iPhone 16 Pro Max and all simulators were untouched. `git diff --check` also passes for the completed Phase 4 state.
