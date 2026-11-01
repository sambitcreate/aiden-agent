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

## iOS disconnected connection picker — 2026-10-31

- The root `ContentView` recovery panel previously exposed Retry only. It now also offers **Switch connection**, opening the existing `AidenInstallationsView` with saved computers, Forget, and **Pair Another Aiden Agent**. This stays available for trust failures where retry is disabled, even with one saved computer.
- The sheet destination belongs to `ContentView`, outside the conditional offline panel, so foreground reconnects cannot remove connection management mid-flow. Forgetting the last pairing dismisses recovery management for the normal pairing screen. Recovery actions fall back to a vertical layout on narrow screens or with larger text.
- Focused simulator validation: `AidenNativeIntegrationTests`, `AidenRemoteClientTests`, and `AidenRemotePhase0Tests`, 210 passed and 5 device-only skips on iPhone 17 Pro, iOS 27.0, BD8018AF-7C14-4729-BDE1-775E29EA4FBD, with signing disabled. The new rendered-panel test uses Vision to verify visible action labels; the coordinator test proves offline-to-other-computer switching, credential isolation, no retry of the old computer, and pairing retention. iOS release policy: 20 Ruby and 30 Node tests passed.
- Initial hosted-view accessibility inspection returned no virtual buttons through either public UIKit container API, so it could not serve as a rendering oracle. The parallel Xcode runner also stalled while diagnosing a different simulator UUID; explicit serial simulator execution succeeded. These are local verification limitations, not physical-device or TestFlight acceptance. No protocol, Android, onboarding, or plan-status change.

TestFlight delivery status recorded 2026-11-01 02:37 UTC: PR #688 merged on exact-head green CI as `1f9f466f8`. Local build 40 was distribution-signed but Apple rejected its unsupported Xcode 27 beta SDK with 90534. Both installed Xcodes are betas. The existing main-only internal release workflow was dispatched as run `41265478289`; replacement number 41 was selected from live ASC upload/build state. A bounded one-shot worker at `/tmp/aiden-ios-testflight-41-release.py` waits for processing, checks the successful workflow's exact source and build number, previews assignment, sets test notes, assigns the existing Internal Testers group, and verifies `VALID` + `IN_BETA_TESTING`. Its status and receipts live in `/tmp/aiden-ios-testflight-41/`. Read-only thread heartbeat `confirm-ios-testflight-hotfix-delivery` reports terminal completion or failure, then pauses. Delivery is pending while the hosted runner is queued; do not describe it as available until the exact ASC resource and group are verified.

Direct ASC retry on 2026-11-01: the local ASC Keychain profile works for upload and distribution. A branch-isolated, manual-only archive job (`41327683755`, operational branch `ops/ios41-unsigned-archive`) compiled the exact merged fix `1f9f466f8` with supported Xcode 26.6 (`17F113`, iOS SDK `23F81a`). The job has repository read permission only, checks out the immutable main commit explicitly, and produces no signed/uploaded build. Its archive checksum and source tree were verified locally. Signing and export use the existing local Store profiles and distribution identity. Initial unsigned export omitted source entitlements; this was caught before upload, corrected by local signing with the existing app/widget entitlement baseline, then re-exported and verified. The final IPA preserves the supported compiler/SDK metadata, App Group, time-sensitive notifications, and `get-task-allow=false`. ASC CLI committed build 41's upload; processing and tester-group verification remain required before claiming availability. Receipts: `/tmp/aiden-ios41-direct-asc/`.

Delivery completed 2026-11-01: direct ASC CLI upload of **0.1.0 (41)** succeeded. Exact resource `29f83b39-de82-45a5-9f54-7f58d944f04f` is `VALID`, `INTERNAL_ONLY`, assigned to group `3f90ffa7-29bb-429e-80a4-88422eb85b6d` (Internal Testers), and `IN_BETA_TESTING`, with auto-notify enabled and English test notes. The earlier GitHub release failed for missing secrets; the later keyless archive run `41327683755` succeeded. The final IPA retained all existing app/widget entitlements and supported Xcode 26.6 / iOS 26.5 SDK metadata. Exact-state receipts are `/tmp/aiden-ios41-direct-asc/delivery-confirmed.json` and `final-build.json`. The old worker/monitor are obsolete; do not use their waiting snapshot as current release state.
