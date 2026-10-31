# Remote server resource audit fixes (2026-10-29)

Branch `claude/audit-fix-remote-server`. Fixes audit 07 (the Aiden Remote HTTPS/SSE server). No protocol revision change: 429 `retryable` and `details.retryAfterSeconds` already existed in the envelope, and the `Retry-After` header is additive.

## Streams and persistence
- The stream journal is two files: `aiden-remote-stream-journal.ts`. The archive keeps the old file name and holds finished streams, and `*-live.json` holds in-progress ones. A streaming delta rewrites only the live file. Persists are coalesced to 1000ms. An older single-file journal loads as the archive and is split on the next write.
- The CLI daemon (`packages/cli/src/remote-chats.ts`) uses the same `AidenRemoteStreamJournal` (load, drop revoked devices' streams, `replace`, then `persist: (write) => journal.save(write)`). It must never hand the `{archive, live}` write to a single-snapshot DataStore.
- Opaque handles: pruning is amortized (no full scan per `issue`). Each device has its own share of the capacity, so one phone browsing large workspaces cannot cause `handle_capacity` for other devices.

## One SSE pump
- `openCursorSse` (`aiden-remote-sse.ts`) is the only wake-then-read pump. Streams, host feed and chat progress all use it.
- It writes every frame of a pulled batch even after a write blocks. Pull one frame per call when "at most one frame past the high-water mark" matters, as streams do.
- `onClose(finished)`: `finished` is true only for a clean, flushed `end()`. Streams evict after delivery only when `finished`.
- All listeners (close, error, drain, finish) are removed in cleanup. A response that is already closed is released immediately.

## Chat progress
- Rebuilt on `openCursorSse` with a `pending` map that keeps only the newest snapshot per type, so a blocked socket gets the latest state on drain.
- Caps: 8 streams per device, where the newest replaces the oldest, and 64 in total. Past the total cap it returns 429 `rate_limited`, `retryable: true`, `retryAfterSeconds: 5`.
- Close and revoke call `destroy()`, not `end()`. The heartbeat is a cheap grant recheck, not a full refresh, and skips a tick while the previous recheck is still running.
- The `after` cursor resume (EXT-33) is unchanged.

## Router and listener
- `writeError` sends `Retry-After` (ceil seconds) whenever `details.retryAfterSeconds` is set.
- Pairing source identity: on the loopback Tailscale listener only, the source is the last `X-Forwarded-For` entry, else `Tailscale-User-Login`. `tailscale serve` overwrites client-sent copies, so this is safe. A local process could spoof them on loopback, which is acceptable because the budget is for fairness and pairing secrets are high-entropy. The LAN listener ignores forwarded headers.
- Sockets get `setKeepAlive(true, 30s)`. TCP keepalive does not probe while unacked data is queued, so the real defense against zombie progress slots is oldest-per-device eviction plus the retryable 429.
- TLS: a daily timer (`tlsRefreshIntervalMs`) reloads the identity and calls `server.setSecureContext` when the certificate chain changed. If the SPKI changed, it logs `tls_key_changed_restart_required` and does not swap, because pinned clients need a restart and re-pair path. The load (which may run openssl) runs outside `serialized()`; only the swap is serialized and rechecks that the listener and identity are unchanged. One renewal at a time, and `stopAndSettle` awaits a running one outside the queue (awaiting it inside would deadlock on the swap).
- Device revocation now also revokes read-aloud and progress after the state fence, not only before it.
- Host feed attaches its close listener before the opening read. Its diff memoizes item JSON in a WeakMap, so items must be replaced, never mutated in place.
- The synchronous `stop()` delegates to `stopAndSettle()`.
- Not done: no AbortSignal for the `tailscale` CLI. Calls are serialized behind a 15s timeout, and aborting mid-mutation would leave the route state uncertain.

## Phones
- iOS and Android parse `Retry-After` (delta-seconds only) and prefer `details.retryAfterSeconds`, clamped to 1-60s.
- Progress and stream reconnect backoff waits at least the requested delay.
- A chat send refused with a retryable 429 is saved under a fresh Idempotency-Key and resent automatically after the delay, at most 3 times in a row; after that, Retry is left to the person. A fresh key is required: these 429s are thrown inside the idempotent action, so the ledger settles the key as rejected and a same-key replay answers `409 internal_error` (`retryable: false`). Possible follow-up: throw them as `AidenOperationNotExecutedError` so the key is released.
- These 429s all happen before the user message is appended. Turn start reserves attachments (as the Bot message route does) instead of consuming them: every refusal before the append restores them, and the append commits them. A resend under a fresh key can reuse the same attachmentIds.
