# Bot-First Aiden On The Go — Phase 6 suite acceptance and known-failure remediation

Date: September 11, 2026

Status: Phase 6 acceptance re-run on the current branch is green. The remaining known suite failures from the prior state were reproduced, root-caused as stale test assumptions (not security-contract regressions), and fixed with semantic-preserving test updates. Full signed physical-device evidence below.

## Known failures fixed (test-only; security contracts preserved)

All five failures were test-side encoding of now-changed, valid semantics. No app, scene, widget, or shared source was modified.

1. **RemotePhase0 shared-fixture revision** (`AidenRemotePhase0Tests.swift`): `testSharedContractFixtureDecodesAndSequencesAreTerminalSafe` still asserted `contractRevision == 9` after the canonical fixture advanced to 10 (TypeScript `main/services/aiden-remote-protocol.ts` and the Android client already expect 10). Updated the assertion to 10; the decode guard `contractRevision >= 9` remains unchanged.
2. **ScheduledTask cadence locale fragility** (`AidenScheduledTaskTests.swift`): the exact-string assertions for `Every day at 9:00 AM` / `Weekdays at 4:00 PM` failed because en_US `DateFormatter` with the `"jm"` template emits a narrow no-break space (U+202F) before AM/PM. The test now normalizes U+202F/U+00A0 and other whitespace to a single regular space before comparing, so it asserts the humanized semantic label rather than the locale-specific separator glyph. Unknown cron still maps to `Custom schedule`.
3. **BotPrototypeSnapshot window-scene harness** (`AidenBotPrototypeSnapshotTests.swift`): the app-hosted render required a `foregroundActive` scene, which can miss during the test-launch transition. The harness now prefers `foregroundActive`, falls back to `foregroundInactive`, then any connected `UIWindowScene`, and hosts the capture window on that actual host-app scene. The legitimate regular-width theme render runs (never skipped) and passed on device.
4. **Binary contract diagnostics** (`AidenNativeIntegrationTests.swift`): `testBinaryContractRejectionsEmitExactlyOneDiagnosticEach` used `assetRevision: "revision-1"`, which fails closed in `validateAvatarRevision` before any request and therefore correctly records no diagnostic. The test now uses a valid canonical `avatar_revision_…` (32 hex) so the request reaches the network-layer `Cache-Control: no-store` contract, records its diagnostic, and the test again proves exactly one diagnostic per rejected response.
5. **Chat-summary ordering JSON crash** (`AidenRemoteClientTests.swift`): `testChatSummaryDecoderRejectsInvalidActivityOrderingDuplicatesAndBounds` passed `summaries.reversed()` (a `ReversedCollection`) to `JSONSerialization`, which threw `NSInvalidArgumentException` before the decoder ran. Wrapped in `Array(...)` so the out-of-order page actually reaches the decoder's canonical-ordering validation.
6. **Legacy chat-list fallback error surface** (`AidenRemoteClientTests.swift`): `testLegacyChatListFallbackRejectsNestedPrivateChildAliases` expected the raw `unsafePayloadField("childrenLatestMessages")` from the authenticated client path, but the client boundary now wraps any rejected decode into `AidenRemoteClientError.invalidResponse` after recording the contract diagnostic. The test now (a) pins the exact rejected field by decoding the same payload directly, and (b) accepts the wrapped `invalidResponse` at the client boundary — the fail-closed projection contract is unchanged and still verified.

## New Phase 6 test file

`ios/AidenOnTheGoTests/AidenBotLiveActivityStateTests.swift` (registered in the Xcode project and the shipping allowlist) adds 8 focused tests for the Live Activity state machine that previously ran only through physical ActivityKit tests:

- exact stream/session identity reuse and `normalizedStreamID` bounds (`AgentLiveActivityReusePolicy`);
- initial-state bounds (title ≤ 42, empty excerpt, never stale/final);
- token append truncation to 140 and single-line collapse, empty-token no-op;
- stale preservation (status kept, excerpt clearing stays non-terminal);
- revoked/failed final state (terminal, never stale, bounded excerpt/activity);
- tool/approval/reasoning transitions (`runningCommand`, `searchingFiles`, `readingFiles`, `usingTool`, `waitingForApproval`, `thinking`, `responding`);
- sanitizer bounds for session title, activity line, response excerpt, and tool label plus path/underscore normalization and shell/search/files classification;
- elapsed-time formatter hour/minute boundaries and clock-regression floor.

## Verification

```text
npm run test:ios-release
PASS — 20 Ruby runs / 42 assertions, 30 Node release-policy tests, 0 failures

Full signed XCTest on the physical iPhone 13 Pro (iOS 27.0, destination
00008110-00063CD91E98801E, full AidenOnTheGo scheme, widget extension intact,
no simulator, parallel testing disabled)
PASS — 351 tests executed, 345 passed, 6 expected environment-only skips,
0 failures (TEST EXECUTE SUCCEEDED)

Result bundle:
/var/folders/bb/wd_m6tl14y5c1wklxz3sj9840000gn/T/opencode/full-suite.xcresult

Opt-in physical acceptance on the same signed device (env-gated via .xctestrun):
  AidenBotImagePlaygroundTests/testOptInPhysicalDeviceReportsImagePlaygroundUnavailable  PASS
  AidenRemotePhase0Tests/testSignedDeviceAidenKeychainIsolationWhenConfigured            PASS
Result bundle:
/var/folders/bb/wd_m6tl14y5c1wklxz3sj9840000gn/T/opencode/optin.xcresult

Physical Live Activity tests (in the full run) — all passed:
  testPhysicalActivityKitLifecycleUsesPrivateBoundedStateAndImmediateCleanup
  testFreshManagerReconcilesPersistedActivityThroughAuthenticatedClient
  testLiveActivityLookupScopesIdenticalStreamIDsToInstallation (exact scope)
  testLiveActivityStateIsBoundedAndResponseExcerptDefaultsOff (stale/bounded state)

The 6 skips are the known environment-only gates:
  testOptInPhysicalDeviceReportsImagePlaygroundUnavailable (opt-in; separately proven below)
  testPhysicalDeviceChatStreamingWhenConfigured / testPhysicalDevicePairingAndWorkspaceCRUDWhenConfigured
  testPhysicalDeviceServerRestartWhenConfigured / testPhysicalDevicePinnedURLSessionWhenConfigured
  testSignedDeviceAidenKeychainIsolationWhenConfigured (opt-in; separately proven above)

git diff --check
PASS
```

## Shipping-source guard updates

- `scripts/check-ios-shipping-target.test.mjs`: the `testSources` allowlist now includes `AidenBotLiveActivityStateTests.swift` (the "source phases" and "no orphan imported Swift sources" guards remain exact and passed). The DEBUG regular-width harness guard still matches the updated scene-selection code (all its contract regexes are unchanged).
- No app, scene, widget, or shared source was edited; the guards that freeze product-shell semantics therefore required no changes and passed.

## Physical AI-device inventory

- **Sambit’s iPhone — iPhone 13 Pro (iPhone14,2), iOS 27.0, connected.** Not Apple Intelligence eligible (A15). Used as the default physical destination for this session: it proves the Image Playground-unavailable fallback (`isAvailable == false` asserted on-device) and the complete non-personalized fallback path.
- **Smbt16ProMax — iPhone 16 Pro Max (iPhone17,2), iOS 27.0, Apple Intelligence eligible (A18 Pro).** Reported by `devicectl` as `available (paired)` and listed by `xctrace`, but not `connected` to this Mac, so it could not be used for a signed test run in this session.
- No physical iPad is connected. Simulator use remains prohibited.

## Remaining manual-hardware requirements

The following cannot be proven from this session and remain open release gates:

1. an eligible Apple Intelligence iPhone/iPad: system Image Playground sheet generation (full run through Apple's normalizer), cancel/refusal/model-download/network/usage-limit/Private Cloud Compute states, authenticated paired-Mac save, relaunch/cache cycle, replacement/revert, and pixel equivalence;
2. a physical iPad: split view, Stage Manager, keyboard/pointer, rotation, VoiceOver, and large Dynamic Type;
3. two paired physical devices across two Macs: grants, caches, favorites, edits, revocation, and stale-response behavior;
4. packaged Mac update → rollback → update plus canonical-photo render/restart;
5. a live Telegram-bound Bot using selected and withheld capabilities;
6. staged TestFlight acceptance for fresh and legacy profiles.