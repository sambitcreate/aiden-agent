# Mobile link consent and draft privacy hardening (2026-10-27)

## W4

Public iOS/Android URL parsing never grants recording authority. `new-chat-voice` remains a navigation alias; new-chat ingress freezes installation, pairing creation identity, workspace and display names before a native confirmation. Approval is in memory, expires after 60 seconds and is consumed before asynchronous creation. Cancellation/revocation/changed identity and late responses cannot replay or publish a new action. No automatic mutation retry was added.

iOS App Intents are main-app-only and now foreground the app and hand one action to `AidenForegroundIntentRouter`, without URL flags, shared bearer tokens, network or Keychain access. The router retains a cold pending action until the view consumes it once. Android has no shipped internal voice producer; immutable notification PendingIntents and iOS widget/notification links continue to navigate to existing chats/Bots.

Current per-chat/new-chat model preference ownership from `.memory/mobile-model-preference-remediation.md` is preserved. No Remote wire revision changed.

Verification: Xcode 27.2 beta simulator build-for-testing and 39 focused XCTest cases passed on iPhone 18 Pro / iOS 27.0 (3F411F6B-BD59-4045-87B6-01994C3E8CC4), including 36 native-integration tests and three voice-lifetime/fixture checks. Android 27 focused JVM tests, lintDebug and compileDebugAndroidTestKotlin passed. `npm run test:ios-release` passed 20 Ruby tests / 42 assertions and 30 Node tests. Logs are `/tmp/aiden-security-mobile-{ios-build,ios-tests,android,ios-policy}.log`; final W4 result bundle is `/tmp/aiden-security-mobile-w4-commit-tests.xcresult`. Physical-device microphone indicators, permission combinations and OS cold App Intent launch acceptance remain unperformed.
