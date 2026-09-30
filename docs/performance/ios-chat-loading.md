# iOS chat loading: optional model catalog

Scope: IOS-03's transcript/catalog dependency only, from `a9baa4aa3027893e5455043083465c34b4c8b4ac`.

`AidenChatViewModel.load()` previously started both GETs together and awaited their tuple. A successful transcript therefore could not enter cache admission or publish until the catalog succeeded; a catalog error discarded that transcript. Cached/current content could still be displayed.

The catalog now has its own structured child operation with independent request-context/removal checks and the existing credential-revocation handler. The transcript immediately uses the unchanged request-origin token, transcript generation, optimistic-send guards and `acceptRemoteChat` cache admission. Successful catalog publication resolves the current user selection, including Bot-owned selection rules; ordinary catalog failure preserves existing choices and does not replace transcript content with a catalog error. Revocation still purges authority and fences suspended transcript publication.

This does not change wire contracts, rendering, or Android. Android's `AidenChatViewModel.loadChat()` and `loadCatalog()` already run independently. Catalog data does not grant permissions. `load()` still owns and awaits both child operations; its lifetime and subsequent progress bootstrap can still include catalog latency. Progress-bootstrap deduplication/parallelization is deferred to its own ownership-focused change.

## Deterministic evidence

The existing `AidenChatTests` URLProtocol holds the actual `/models` response until the test explicitly releases it. The actual chat GET succeeds with a new message. Before catalog release, the test requires the publication callback, the fresh visible transcript and the persisted transcript. It then releases either a successful catalog or HTTP 503 and checks content/error behavior and a nondefault model/thinking selection made during suspension. Its three-second expectation is a failure bound, not an injected RTT or a performance measurement.

Additional executed coverage is recorded below: chat failure with a successful catalog; removal/unpair while catalog is held; catalog revocation with a held transcript. The complete existing chat suite also covers optimistic Send/reload, rejected cache writes, restoration, permissions and stream response ownership.

Executed comparison on 2026-09-27, Xcode 27.0 (27A5252f), iPhone 17 Pro simulator / iOS 27.0, destination `9F4FDF41-3FE3-477D-B92B-127C43FE927E`, serial XCTest with `CODE_SIGNING_ALLOWED=NO`:

| Version | Held-catalog result |
| --- | --- |
| Original loader at the base commit | One regression executed, seven assertion failures: both catalog outcomes blocked publication/persistence before release; the 503 produced a transcript load error. |
| Fixed loader | Same held-catalog regression passed: transcript callback, visible message and persisted message all available before release for both success and 503; nondefault user choice retained. |

The first baseline attempt failed before XCTest execution because Simulator returned no process handle for the test runner. Its one `test-without-building` retry executed and produced the expected behavioral failures. Initial fixed-source chat suite: 211 tests passed. Final-source validation (including a fourth added test and stronger nondefault choice assertion): **212 chat tests executed, zero failures**. The final run launched successfully without retry. Release-policy checks passed: 20 Ruby tests / 42 assertions and 32 Node tests.

Local evidence:

- Original executed comparison: `/tmp/aiden-perf-ios-loading-baseline-retry.xcresult` and `.log`.
- Original launch-only failure: `/tmp/aiden-perf-ios-loading-baseline.xcresult` and `.log`.
- Final changed-loader suite: `/tmp/aiden-perf-ios-loading-final.xcresult` and `.log`.
- Policy: `/tmp/aiden-perf-ios-loading-policy.log`.

Reproduce the changed-loader suite from the repository root:

```sh
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild test \
  -project ios/AidenOnTheGo.xcodeproj -scheme AidenOnTheGo \
  -destination 'platform=iOS Simulator,id=9F4FDF41-3FE3-477D-B92B-127C43FE927E' \
  -derivedDataPath /tmp/aiden-perf-ios-loading-derived \
  -resultBundlePath /tmp/aiden-perf-ios-loading-final.xcresult \
  -parallel-testing-enabled NO \
  -only-testing:AidenOnTheGoTests/AidenChatTests CODE_SIGNING_ALLOWED=NO
npm run test:ios-release
```

Use an unused result-bundle path when repeating the command. To reproduce the before comparison, use the original production file at the base commit with the new tests, select `AidenOnTheGoTests/AidenChatTests/testTranscriptPublishesWhileCatalogIsHeldIncludingCatalogFailure`, and restore the changed source afterward.

## Measurement limits

This is deterministic dependency/race evidence, not production navigation latency, p50/p95, frame-time, energy, or physical-device acceptance. No 0/100/500 ms timing sweep was collected. Fresh publication no longer depends on catalog release; cached publication behavior and stream restoration were not redesigned. No dependency installation, release, or deployment is part of this change.

## PR #283 revocation redaction follow-up

Review [4118130725](https://github.com/sambitcreate/aiden-agent/pull/283#discussion_r4118130725) found the opposite response ordering was not covered: a fresh transcript could publish before the sibling catalog reported `credential_revoked`. The coordinator waits for installation cleanup before changing the product shell to pairing, and the model's removal callback previously kept those messages.

The existing lifetime-removal callback now clears `chat.messages` synchronously before asynchronous cleanup. It does not publish an empty replacement to the cache or add a new request. Ordinary catalog failures do not invalidate the lifetime and keep the transcript; the existing success/503 held-catalog test explicitly checks content again after release.

`testCatalogRevocationRedactsPublishedTranscriptBeforePurgeCompletes` publishes a real successful chat GET, releases a held catalog 401, and holds the existing removal-cleanup seam. It verifies the shell's connection state is still connected and an independently opened cache still reads the old disk transcript, while the mounted model already has no messages. After cleanup it checks pairing state, empty model and purged disk. Against `c68550e5`, this test actually executed and failed both redaction assertions (one test, two failures); `/tmp/aiden-perf-ios-redaction-before.xcresult` and `.log`. No simulator infrastructure retry was needed for that baseline.

The change is local to the iOS lifetime callback; Android's independent chat/catalog loaders and separate lifecycle were inspected, and no shared contract, transcript format or rendering component changed. Follow-up validation on the same explicit iPhone 17 Pro / iOS27.0 simulator and Xcode27.0 destination above:

- Full `AidenChatTests`: **213 executed, zero failures**, `/tmp/aiden-perf-ios-redaction-after.xcresult` and `.log`.
- After strengthening the ordinary503 test with a post-release content assertion, the two affected tests executed and passed using `test-without-building`: `/tmp/aiden-perf-ios-redaction-final-retry.xcresult` and `.log`. The production code was unchanged from the full213 run.
- The initial final two-test run stalled after build/app launch but before XCTest started. After roughly three minutes it was interrupted and its app terminated; evidence `/tmp/aiden-perf-ios-redaction-final.log` and `/tmp/aiden-perf-ios-redaction-launch-sample.txt`. Its single infrastructure retry passed. This launch failure is retained as a limitation rather than counted as a passing test run.
- `npm run test:ios-release`:20 Ruby tests/42 assertions and32 Node tests passed; `/tmp/aiden-perf-ios-redaction-policy.log`.

No physical-device acceptance or timing claim is added.
