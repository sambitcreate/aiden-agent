# Mobile transcript polish (Hermex Tier 1)

Branch `feature/mobile-transcript-polish`. Plan: `docs/plans/mobile-transcript-polish-plan.md`.

- There was no protocol change. "Worked for" reads `Message.timeline`, but only when the status is completed and `finishedAt >= startedAt`. The live timer uses the running timeline's `startedAt` and otherwise falls back to the newest user message's `createdAt`. Timestamps use `createdAt`.
- iOS code lives in `Features/Chat/AidenTranscriptPolish.swift`. It is a new file because `AidenChatFeature.swift` is far over the 500-line Swift warning, and it is registered manually in the pbxproj with IDs `A714739233F64F4FA4C2B700` and `...710`. The footer replaced the old safeAreaInset copy/read-aloud row. `AidenSettledMessageRows` computes `showsFooter`, so Bot clusters show it only on the last joined bubble.
- The release inventory test also keeps an explicit `appSourcePaths` allowlist in `scripts/check-ios-shipping-target.test.mjs`; registering a new iOS source in the pbxproj requires adding its full `AidenOnTheGo/...` path there so both the target and filesystem inventory remain in sync.
- Android code lives in `features/chat/AidenTranscriptPolish.kt`. The "Reply" menu item was removed and replaced by Select Text and Ask about this. The footer renders on `isLastInCluster`, or on any message that offers Read Aloud.
- SwiftUI `.textSelection` and Compose `SelectionContainer` cannot add custom menu items, so selection uses a native select-text sheet/dialog. On iOS this is a `UITextView` with `editMenuForTextIn`; on Android it is a `TextView` with `customSelectionActionModeCallback`.
- User messages are now copyable on iOS. `copyText` returns nil only for empty text.
- Open items: flatten Markdown in the Android select-text dialog, and focus the Android composer after Ask.
