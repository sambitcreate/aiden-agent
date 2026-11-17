# Option A baseline

Recorded before any Option A change. Every later full-suite run is compared with these numbers.

## Environment

| Item | Value |
| --- | --- |
| Commit | `a6836c507c4f25b53dcb429b90349339d0503720` (Report crashes and uncaught errors to PostHog (#732)) |
| Branch | `ios/option-a` (worktree `aiden-option-a`, cut from `origin/main`) |
| Xcode | 27.1 (build 27A9269), `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` |
| Simulator | iPhone 18 Pro, iOS 27.0 (24A434), parallel clone (`Clone 1 of iPhone 18 Pro`) |
| Deployment target | `IPHONEOS_DEPLOYMENT_TARGET = 18.0` (all 8 build configurations), `SWIFT_VERSION` 5.0 |
| Command | `cd ios && xcodebuild test -project AidenOnTheGo.xcodeproj -scheme AidenOnTheGo -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -resultBundlePath <bundle> CODE_SIGNING_ALLOWED=NO` |
| Wall time | about 12 min total (xcresult test phase 729 s) |

## Result

`** TEST SUCCEEDED **`: 1,321 tests, 1,314 passed, 7 skipped, 0 failed, 0 expected failures.

The earlier throwaway run (older local `main`, 27.0 floor, Xcode 27.0) gave 1,277 tests, 1,270 passed, 7 skipped, 0 failed. This run has 44 more tests and the same 7 skips.

Counts come from `xcrun xcresulttool get test-results summary` and `... get test-results tests` on the result bundle. The `Test case ... passed` lines in the log add up to 1,310 passed plus 7 skipped, 4 fewer than the bundle; the bundle is the number of record.

### Simulator launch failures (not test failures)

The log shows two `Failed to launch app with identifier: sbtbiswas.AidenOnTheGo` messages from parallel simulator clones (`ED70F08E-...` at 12:46:42 and `DA811C74-...` at 12:48:41, `FBSOpenApplicationServiceErrorDomain Code=3`). Xcode recovered both times; the run finished with 0 failures. Recorded as flakiness of cloned simulators, as seen in an earlier run. If a later run shows it, it is not a regression.

### The 7 skips

Six are opt-in physical-device acceptance tests that skip unless an environment variable is set; one skips on the simulator's file protection support.

| Test | Why skipped |
| --- | --- |
| `AidenRemoteClientTests.testPhysicalDeviceChatStreamingWhenConfigured` | needs `AIDEN_PHASE7_PAIRING_PAYLOAD` (physical-device xctestrun) |
| `AidenRemoteClientTests.testPhysicalDevicePairingAndWorkspaceCRUDWhenConfigured` | physical-device pairing configuration not set |
| `AidenRemoteClientTests.testPhysicalDeviceServerRestartWhenConfigured` | physical-device pairing configuration not set |
| `AidenRemotePhase0Tests.testPhysicalDevicePinnedURLSessionWhenConfigured` | needs `AIDEN_PHASE0_PAIRING_BOOTSTRAP` |
| `AidenRemotePhase0Tests.testSignedDeviceAidenKeychainIsolationWhenConfigured` | needs `AIDEN_PHASE0_KEYCHAIN_PROOF=1` on a signed device |
| `AidenBotImagePlaygroundTests.testOptInPhysicalDeviceReportsImagePlaygroundUnavailable` | needs `AIDEN_EXPECT_IMAGE_PLAYGROUND_UNAVAILABLE=1` |
| `AidenBotCacheTests.testDraftStoragePreservesCompleteUntilFirstUnlockProtectionWhenPlatformExposesIt` | simulator does not expose the file protection class |

## Tests per class

53 classes. Columns: total, passed, skipped, failed.

| Class | Total | Passed | Skipped | Failed |
| --- | --- | --- | --- | --- |
| AidenActivityMarkTests | 11 | 11 | 0 | 0 |
| AidenAppearanceTests | 39 | 39 | 0 | 0 |
| AidenBackgroundJobsTests | 3 | 3 | 0 | 0 |
| AidenBotAccessRequestsTests | 11 | 11 | 0 | 0 |
| AidenBotActivityContractTests | 11 | 11 | 0 | 0 |
| AidenBotAllowedTests | 9 | 9 | 0 | 0 |
| AidenBotCacheTests | 20 | 19 | 1 | 0 |
| AidenBotChatActivityTests | 23 | 23 | 0 | 0 |
| AidenBotChatPolishTests | 3 | 3 | 0 | 0 |
| AidenBotConnectionHintTests | 2 | 2 | 0 | 0 |
| AidenBotContractTests | 54 | 54 | 0 | 0 |
| AidenBotFaceGlanceTests | 2 | 2 | 0 | 0 |
| AidenBotGeneratedAvatarTests | 16 | 16 | 0 | 0 |
| AidenBotHomeProfileTests | 20 | 20 | 0 | 0 |
| AidenBotImagePlaygroundTests | 10 | 9 | 1 | 0 |
| AidenBotInstantEditTests | 22 | 22 | 0 | 0 |
| AidenBotIssueTests | 4 | 4 | 0 | 0 |
| AidenBotMemoryTests | 16 | 16 | 0 | 0 |
| AidenBotPlanTests | 10 | 10 | 0 | 0 |
| AidenBotRoutineNotifierTests | 5 | 5 | 0 | 0 |
| AidenBotSessionActivityTests | 11 | 11 | 0 | 0 |
| AidenBotSessionApprovalTests | 7 | 7 | 0 | 0 |
| AidenBotSessionAttachmentTests | 8 | 8 | 0 | 0 |
| AidenBotSessionHandoffTests | 8 | 8 | 0 | 0 |
| AidenBotSessionOptimisticTests | 65 | 65 | 0 | 0 |
| AidenBotSessionQuestionTests | 3 | 3 | 0 | 0 |
| AidenBotSessionTests | 44 | 44 | 0 | 0 |
| AidenCacheFirstHomeTests | 9 | 9 | 0 | 0 |
| AidenChatReadAdmissionTests | 2 | 2 | 0 | 0 |
| AidenChatScrollFollowTests | 23 | 23 | 0 | 0 |
| AidenChatSummaryPerformanceTests | 6 | 6 | 0 | 0 |
| AidenChatTests | 361 | 361 | 0 | 0 |
| AidenHapticTests | 10 | 10 | 0 | 0 |
| AidenImageGenerationPlaceholderTests | 17 | 17 | 0 | 0 |
| AidenInboxTests | 20 | 20 | 0 | 0 |
| AidenMarkdownContentCacheTests | 3 | 3 | 0 | 0 |
| AidenMessageVisualSnapshotLayoutTests | 1 | 1 | 0 | 0 |
| AidenNativeIntegrationTests | 39 | 39 | 0 | 0 |
| AidenNetworkPathTests | 12 | 12 | 0 | 0 |
| AidenNewWorktreeTests | 6 | 6 | 0 | 0 |
| AidenOnboardingArtTests | 5 | 5 | 0 | 0 |
| AidenProductShellTests | 14 | 14 | 0 | 0 |
| AidenQuietOpenChatTests | 3 | 3 | 0 | 0 |
| AidenRemoteClientTests | 166 | 163 | 3 | 0 |
| AidenRemotePhase0Tests | 46 | 44 | 2 | 0 |
| AidenRunAlertTests | 12 | 12 | 0 | 0 |
| AidenScheduledTaskTests | 12 | 12 | 0 | 0 |
| AidenSimulatorViewerTests | 30 | 30 | 0 | 0 |
| AidenSpendingTests | 3 | 3 | 0 | 0 |
| AidenStreamingPerformanceTests | 41 | 41 | 0 | 0 |
| AidenTranscriptFollowControllerTests | 19 | 19 | 0 | 0 |
| AidenVisualViewerTests | 12 | 12 | 0 | 0 |
| AidenWorkspaceEnvironmentTests | 12 | 12 | 0 | 0 |
| **Total** | **1321** | **1314** | **7** | **0** |

## Compiler warnings

27 distinct source warnings (58 raw `warning:` lines, because Xcode repeats the diagnostic snippet). 8 are in the app target, 19 in the test target. No errors.

App target:

| Location (under `ios/AidenOnTheGo/`) | Warning |
| --- | --- |
| `Features/Bots/AidenBotSessionModel.swift:1340:40` | main actor-isolated static property 'shared' referenced from a nonisolated context (Swift 6 error; reported 3 times) |
| `Features/Bots/AidenBotSessionModel.swift:2255:29` | no calls to throwing functions occur within 'try' |
| `Features/Chat/ComposerVoiceInputController.swift:420:22` | result of call to 'advance()' is unused |
| `Features/Remote/AidenChatFeature.swift:1097:13` | result of 'try?' is unused |
| `Features/Remote/AidenChatFeature.swift:2796:39` | reference to captured var 'self' in concurrently-executing code (Swift 6 error) |
| `Networking/AidenRemoteContract.swift:2284:9` | immutable property will not be decoded because it has an initial value |
| `Persistence/AidenChatCache.swift:553:13` | result of 'try?' is unused |
| `Persistence/AidenChatCache.swift:695:13` | result of 'try?' is unused |

Test target (`ios/AidenOnTheGoTests/`), 19 warnings:

| File | Count | Kinds |
| --- | --- | --- |
| `AidenChatTests.swift` | 15 | unused `Bool`/`Bool?` expression (5), deprecated unlabeled trailing closure (7, label `whileReading` / `onChatUpdated`), variable mutated after capture by a sendable closure (3) |
| `AidenBotMemoryTests.swift` | 2 | `lock`/`unlock` unavailable from asynchronous contexts (Swift 6 error), line 410 |
| `AidenBotHomeProfileTests.swift` | 1 | unused `Bool` expression, line 998 |
| `AidenRemoteClientTests.swift` | 1 | unused `try?` result, line 6352 |

A later task is clean on warnings if it adds none beyond these. Line numbers will drift.

## `npm run test:ios-release`

Passed. Ruby `select_testflight_build_number_test.rb`: 20 runs, 0 failures. `node --test` on the five `scripts/*ios*` test files: 30 tests, 30 passed, 0 failed, 0 skipped.

## `ios/scripts/check-swift-file-sizes`

Exit 0. Policy is warning-only: 38 production app Swift files exceed 500 LOC.

| File (under `ios/`) | LOC |
| --- | --- |
| `AidenOnTheGo/Config/AidenAppearance.swift` | 866 |
| `AidenOnTheGo/Features/Bots/AidenBotAdvancedView.swift` | 1515 |
| `AidenOnTheGo/Features/Bots/AidenBotCreateView.swift` | 779 |
| `AidenOnTheGo/Features/Bots/AidenBotMemoryView.swift` | 540 |
| `AidenOnTheGo/Features/Bots/AidenBotProfileView.swift` | 899 |
| `AidenOnTheGo/Features/Bots/AidenBotRoutinesView.swift` | 580 |
| `AidenOnTheGo/Features/Bots/AidenBotSessionChatView.swift` | 1828 |
| `AidenOnTheGo/Features/Bots/AidenBotSessionModel.swift` | 2985 |
| `AidenOnTheGo/Features/Bots/AidenBotSettingsDraft.swift` | 531 |
| `AidenOnTheGo/Features/Bots/AidenBotsHomeView.swift` | 1156 |
| `AidenOnTheGo/Features/Chat/AidenAttachmentCamera.swift` | 581 |
| `AidenOnTheGo/Features/Chat/AidenAttachmentPicker.swift` | 1195 |
| `AidenOnTheGo/Features/Chat/AidenChatFork.swift` | 580 |
| `AidenOnTheGo/Features/Chat/AidenImageGenerationPlaceholder.swift` | 551 |
| `AidenOnTheGo/Features/Chat/ComposerVoiceInputController.swift` | 640 |
| `AidenOnTheGo/Features/Remote/AidenBotChatToolsView.swift` | 543 |
| `AidenOnTheGo/Features/Remote/AidenChatFeature.swift` | 11567 |
| `AidenOnTheGo/Features/Remote/AidenMarkdownContentCache.swift` | 757 |
| `AidenOnTheGo/Features/Remote/AidenPairingView.swift` | 1013 |
| `AidenOnTheGo/Features/Remote/AidenProductShellView.swift` | 1728 |
| `AidenOnTheGo/Features/Remote/AidenRemoteCoordinator.swift` | 1241 |
| `AidenOnTheGo/Features/Remote/AidenScheduledRunNotifier.swift` | 542 |
| `AidenOnTheGo/Features/Remote/AidenScheduledTasksView.swift` | 1331 |
| `AidenOnTheGo/Features/Remote/AidenWorkspaceEnvironmentView.swift` | 1224 |
| `AidenOnTheGo/Features/Remote/AidenWorkspaceShellView.swift` | 5038 |
| `AidenOnTheGo/Features/Simulators/AidenSimulatorViewer.swift` | 516 |
| `AidenOnTheGo/Features/Simulators/AidenSimulatorViewerModel.swift` | 574 |
| `AidenOnTheGo/LiveActivities/AgentRunActivityAttributes.swift` | 641 |
| `AidenOnTheGo/Models/AidenBot.swift` | 1475 |
| `AidenOnTheGo/Models/AidenBotRoutine.swift` | 696 |
| `AidenOnTheGo/Models/AidenBotSession.swift` | 1695 |
| `AidenOnTheGo/Models/AidenChat.swift` | 4144 |
| `AidenOnTheGo/Models/AidenChatProgress.swift` | 802 |
| `AidenOnTheGo/Models/AidenInbox.swift` | 668 |
| `AidenOnTheGo/Networking/AidenRemoteClient.swift` | 4363 |
| `AidenOnTheGo/Networking/AidenRemoteContract.swift` | 4169 |
| `AidenOnTheGo/Persistence/AidenBotCache.swift` | 528 |
| `AidenOnTheGo/Persistence/AidenChatCache.swift` | 1351 |
