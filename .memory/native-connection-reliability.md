# Native connection reliability — 2026-10-06

Implementation on `fix/connection-reliability` (PR/hosted acceptance pending).

- iOS and Android persist ambiguous sends separately from editable drafts before POST.
  Records retain exact request, original idempotency key, device scope, creation time,
  and attachment references; stream input also retains its original stream and mode.
  Retry is explicit and bounded by the host's 24-hour replay window measured
  conservatively from the first local attempt. Expired or unreadable records block
  a new send until the user checks the desktop and explicitly dismisses recovery.
  Storage refuses replacement of another unresolved key. Accepted receipts clear
  only their matching record without allowing stale draft owners to undo receipt
  admission. Pairing/chat removal purges records with drafts.
- Both progress observers park offline using existing network-aware recovery.
  Authoritative task/roster GETs still revalidate on reconnect; bounded per-client
  ETag caches avoid retransmitting unchanged JSON. SSE resumes the last applied
  cursor with `Aiden-Progress-Epoch`, and the server explicitly acknowledges a
  recognized cursor with `Aiden-Progress-Resumed`. Epoch mismatch, unknown cursor,
  cold view, or legacy server retains full hydration. Generation SSE is unchanged.
- Android setup-code pairing lists nearby desktops, using only a bounded `.local`
  hostname hint advertised through discovery. This is initial address discovery,
  not trusted route learning: setup-code/QR certificate and hostname validation
  remain authoritative. Older hosts without a hostname hint use manual address or
  QR fallback. No raw LAN IP bypass is offered. The manual address begins empty;
  payload JSON remains under Advanced.
- The conditional-response caches are memory-only, per credential-scoped client,
  limited to 32 entries and 4 MiB aggregate, with 1 MiB entry cap. A 304 without the
  corresponding validated bytes is rejected. Prompts and credentials are never
  included in request validators or discovery metadata.

Validation: Android focused 167 JVM tests passed, with Android lint and debug
instrumentation compilation passing. Progress server 25 tests and iOS release
policy 32 tests passed. iOS simulator full native run passed 405 tests with 5
skips; additional original-stream retry and quiet-progress tests passed. A final
chat rerun exposed a JSON key-order-sensitive assertion in the new replay test;
the oracle now compares decoded request values while separately checking the
original key, rather than incidental encoded byte order. The corrected narrow test passed; the other 263 chat tests passed in the final
chat rerun. Physical phone
Wi-Fi/Tailscale discovery, system local-network permission behavior, and visual
VoiceOver/TalkBack acceptance remain separate from simulator/JVM checks.

PR #370 review follow-up: matching confirmed receipts now settle the original
retained pairing's durable record independently of active presentation, while UI
and stream adoption stay generation-fenced. Held turn/input receipt tests cover
installation switches and preservation of a newer pending key. Actual Android QR
and setup-code exchanges send `android`; unsupported older hosts show update
guidance without retrying under an Apple identity. Full Android 429 tests and lint
pass; focused iOS lifecycle and original-stream recovery tests pass.
