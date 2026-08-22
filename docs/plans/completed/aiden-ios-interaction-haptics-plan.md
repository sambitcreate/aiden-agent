# Aiden iOS Interaction Haptics

Status: Complete. Released to Internal Testers in version 0.1.0 build 16.

## Goal

Add sparse, semantic Taptic Engine feedback to Aiden On The Go without duplicating native control feedback, vibrating during background reconciliation, or disturbing speech capture.

## Policy

- Use SwiftUI `sensoryFeedback` from one app-scoped dispatcher and Apple’s standard selection, start, stop, success, warning, and error patterns.
- Emit only for a visible, user-initiated interaction or its authoritative outcome.
- Keep navigation, standard controls, token/thinking/tool updates, loading, reconnects, App Intents, Live Activities, and ordinary response completion silent.
- Suppress feedback when disabled, unsupported, backgrounded, outside the initiating view scope, or while the microphone is capturing.
- Deduplicate replayable outcomes by semantic event plus stable operation identity.

## Delivery

1. Inventory interactions and map each eligible event to an Apple semantic pattern.
2. Add the device-local preference, capability gate, active-view scopes, microphone gate, and bounded deduplication.
3. Integrate pairing, New Agent, workspace/chat CRUD, send/stop/approval, attachment batches and carousel paging, scheduled tasks, workspace files, and Git mutations.
4. Add focused unit coverage for persistence, gating, scopes, unsupported hardware, and replay deduplication.
5. Verify compilation and tests on the physical iPhone 13 Pro; review the finished diff; ship build 16 to Internal Testers.

## Acceptance

- A single explicit action produces at most one appropriate pulse per semantic transition.
- Cancellation, stale contexts, dismissed views, reconnect replay, and background work remain silent.
- Standard controls do not receive duplicate custom feedback.
- iPad and hardware without haptics safely no-op.
- Users can disable Interaction Haptics in App Settings.

## Verification and release

- A final GPT-5.6 Sol Max review found and verified the delivery-time scope fence: the originating view scope now travels with every queued pulse and is rechecked before SwiftUI delivers it.
- Ten focused haptics tests pass on the connected physical iPhone 13 Pro, including emit-then-dismiss, exactly-once local stream approval/terminal/stop convergence, restored-stream silence, and dismissed pairing. The complete signed physical suite previously passed 144 tests with five environment-gated skips and no failures.
- `npm run test:ios-release` passes 20 Ruby tests with 42 assertions and 25 Node policy tests. No simulator was used.
- Internal-only build `0.1.0 (16)` is App Store Connect build `4389a0ee-430b-46e7-97ca-bea553b6f335`, assigned to Internal Testers with `internalBuildState=IN_BETA_TESTING` and `externalBuildState=NOT_APPLICABLE`.
