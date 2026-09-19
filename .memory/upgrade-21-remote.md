# Remote generation SSE backpressure — 2026-09-19

The generation stream service previously ignored `ServerResponse.write(false)` in replay, live publication, and heartbeat paths. The retained journal was bounded but the per-client writable buffer was not. Baseline tests demonstrated three replay writes and 32 live writes after the first refused write.

Each subscriber now retains only its delivery cursor and drains directly from the existing bounded journal. A false write accepts that frame exactly once and pauses all further event/heartbeat writes until drain. A 30-second drain timeout destroys only the stalled connection. If retention overtakes a paused cursor, the connection closes and existing reconnect/snapshot recovery applies. Terminal delivery drains before ending. Socket errors, close, revocation, and journal eviction release the subscriber's listeners and timers. Generation ownership never transfers to the socket.

Rejected alternatives: disconnect cancellation already has owner isolation and regression coverage; replay device ownership/ahead cursors/pruned cursor recovery are already explicitly checked. No event DTO, protocol, client parser, onboarding, or plan-status change was needed. Inspected both native clients' Last-Event-ID and stream recovery paths; their wire contract is unchanged. Independent mobile parser fixes remain owned by lanes 13/16.

Validation: existing registered stream suite gains regressions for replay/live backpressure, healthy-subscriber isolation, timeout/heartbeat cleanup, disconnect/error, retention recovery, terminal drainage, revocation, and synchronous write failure. `npm run test:aiden-remote` passes (447 passed, one environmental legacy-port skip); focused final stream tests, type-check, scoped ESLint and diff check recorded in lane status. No build/Electron or native suite required for server-local compatible delivery scheduling. Hosted exact-head CI and central independent review remain separate gates.

Read-only references; implementation is original:
- opencode-v2-aiden-study `7a6ce05d0939826aa6c8e1c481489a713b2d633f`, `packages/opencode/src/server/instance/event.ts`, MIT; SHA-256 `80596a5f7b52d669c352344b95dfa8d68b62b8b7688605bc297c6696e2915075`. Await stream writes and make abort cleanup idempotent; do not copy unbounded queue.
- hermes-agent `69ae247cf3dba34a37ab4af8484b96d3559a4fcf`, `tui_gateway/methods_session.py`, MIT; SHA-256 `b7854680f7899d7d874ffa5056c1b7554f0a024a028b943a0fe26d5fbf7a7d55`. Detached transport does not imply finalized generation.
- waku `6d433e875d57091906ec0770d8bb9ffc9aa29b83`, `src/driver/acp.rs`, GPL-3.0; SHA-256 `38b486abd085a23d1142bc801a844468276f2dde986bdf0c6aad2d804e4ad3e3`. Resume cursors retain explicit owner/provider identity; read-only conceptual study, no copied code.

## Review correction: terminal delivery under aggregate pressure

Pullfrog PRRT_kwDOTctvDc6j9u0k demonstrated aggregate eviction could destroy accepted but undrained terminal bytes and remove replay state. Two cross-stream pressure regressions failed against PR head 25934fbe. Aggregate eviction now excludes terminal records with subscribers; ordinary journal trimming still enforces the 16 MiB budget. Successful drain or the existing 30-second timeout releases the subscriber so the next pressure pass can evict the record. Tests prove terminal replay remains available during the drain, healthy terminal completion, timeout cleanup, bounded snapshot memory, and subsequent eviction (no indefinite capacity pin).

Review-fix validation: 37 stream tests passed; full remote suite 452 passed, one occupied legacy-port skip; type-check, scoped ESLint and diff check passed.

## Idle-capacity correction

Pullfrog comment 4052529509 and independent Luna reproduction showed that a full 256-record registry could stay full after a preserved terminal subscriber settled. Drain/timeout/abort regressions now fill the registry before aggregate pressure and create a new stream immediately after settlement without an intervening append; all three failed on ff61d680. Aggregate eviction now records a transient `evictAfterDelivery` intent, and the final subscriber's idempotent cleanup removes that exact record and persists the deletion. Replay remains retained while any subscriber is pending. Active records remain admission-limited. The marker never changes persisted/wire schemas. This supersedes the earlier note that a subsequent pressure pass performs removal.

Idle-capacity validation: 39 stream tests passed; remote suite 454 passed, one occupied legacy-port skip; type-check, scoped ESLint and diff check passed.

## Final delivery/replay invariant (supersedes idle-capacity teardown rule)

Independent review reproduced loss on e821d336: an aborted final write destroyed the only terminal replay state. A response that closes or times out before `finish` has not established completed transport delivery. Deferred eviction now completes only on the terminal response's `finish`; both drain and finishing have 30-second deadlines. Ordinary cleanup only removes transport resources. Deferred records survive additional aggregate pressure with no subscribers, retaining reconnect recovery. Successful replay releases deferred capacity without another append. Failed delivery legitimately occupies a registry slot until replay succeeds or the existing 24-hour terminal retention expires; the 256-record and 16 MiB snapshot limits still apply. Tests cover abort/timeout before drain and after end but before finish, renewed pressure, actual replay from sequence 1, immediate create after successful completion, retention expiry, and active capacity protection. The lifecycle marker is process-local; persisted event envelopes/schema are unchanged.

Replay-fix validation: 42 stream tests passed; independent /tmp/review-remote-abort-replay.test.ts failed on e821d336 and passes after correction. Full remote suite 457 passed, one occupied legacy-port skip; type-check, scoped ESLint and diff check passed.

## Scope disposition: abort before aggregate pressure is pre-existing

The independent `/tmp/review-remote-abort-before-pressure.test.ts` aborts the terminal response before any aggregate pressure, then fills the registry and generates enough events for byte-budget eviction. Executed unchanged against current product source at 5536fdb5 and against the exact original campaign baseline service from 5cc831a17aa8971fb5b89c7dd9278a6ec4022beb (temporary sibling module to preserve imports). Both failed the replay assertion with `This Aiden stream is unavailable` from `requireStream` (`not_found`). Logs: `/tmp/aiden-21-before-pressure-head.log` and `/tmp/aiden-21-before-pressure-baseline.log`. The temporary baseline module was removed.

This PR protects **in-flight deferred aggregate eviction**: pressure encounters an existing terminal subscriber, defers eviction, and the subsequent abort/timeout must preserve that deferred journal for recovery. It does not guarantee replay after every disconnect, prohibit ordinary byte-budget eviction of already-unsubscribed terminal journals, or establish a new universal 24-hour replay guarantee. Protected deferred records remain subject to existing history trimming and normal retention expiry. Product code is unchanged by this disposition.

Deferred contract question: `docs/aiden-remote-api-v1.md:330` describes `stream_gone` with chat identity for expired-journal reconciliation, while existing `requireStream` returns `not_found`; section 8 requires bounded replay resources. A separate audit should reconcile documented expiration/eviction responses with actual server and native chat-reconciliation behavior. No broader policy change is included in this PR.
