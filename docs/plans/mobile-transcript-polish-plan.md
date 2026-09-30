# Mobile transcript polish (Hermex Tier 1)

Status: Implemented for review. Hosted CI and physical-device visual acceptance are still open.

## Goal

Make Aiden On The Go transcripts on iOS and Android easier to read and act on without a protocol change:

1. **Worked for.** Every completed assistant turn gets a "Worked for 1m 5s" footer. While a turn is running, the live response card shows a "Working for …" timer that ticks once per second.
2. **Timestamp and copy footer.** Each settled message shows a compact timestamp:
   - Today: the time only.
   - Yesterday: "Yesterday" and the time.
   - Earlier this year: month and day, then the time.
   - Older: the full date, then the time.

   The footer also has a copy button for user and assistant messages. Read Aloud stays in the footer for eligible assistant replies.
3. **Selection and "Ask about this".** Each message context menu gains two actions:
   - **Select Text** opens the message as native selectable text. The system selection menu adds an **Ask About This** action.
   - **Ask about this** quotes the whole message into the composer.

   Quoting uses a Markdown blockquote that is appended after any existing draft. It is capped at 2,000 characters and focuses the composer on iOS. Both actions are hidden while a chat is read-only.

## Data sources (no protocol change)

- The duration comes from `Message.timeline.startedAt` and `Message.timeline.finishedAt`, and only when `status == completed` and `finishedAt >= startedAt`. Failed, cancelled, legacy and clock-skewed rows show no duration.
- The live timer starts at the running timeline's `startedAt`. If there is no timeline yet, it falls back to the `createdAt` of the newest user message.
- Timestamps come from `Message.createdAt`.

The Remote contract revision (15) is unchanged.

## Surfaces

- iOS: `ios/AidenOnTheGo/Features/Chat/AidenTranscriptPolish.swift` holds the formatters, the footer, the live label, the select-text sheet, and a `UITextView` with the custom edit-menu action. It is wired through `AidenSettledMessageRows`, `AidenMessageView` and `AidenLiveResponseView`, together with `AidenChatViewModel.askAbout(_:)`.
  - Bot-style clusters show the footer only on the last bubble of a cluster.
- Android: `features/chat/AidenTranscriptPolish.kt` holds the formatters, the footer, the live label and the select-text dialog. The dialog's `TextView` action mode adds "Ask about this".
  - `AidenMessageActionContainer` replaces the old "Reply" item with Select Text and Ask about this.
  - `AidenChatViewModel.askAbout(selection)` updates the draft.
  - Clusters show the footer on their visual bottom bubble.

## Tests

- iOS `AidenChatTests` cover:
  - worked-for eligibility and formatting
  - the live-timer start
  - calendar-aware timestamps
  - quote drafting
  - markdown-flattened selectable text
  - user-message copy
- Android `AidenTranscriptPolishTest` (JVM) mirrors the formatter and quote cases and adds a check that the day boundary follows the viewer's time zone.
- `AidenChatChromeUiTest` (Compose) covers the footer's worked-for and copy, and the Ask/Select menu with and without write access.

## Follow-ups

- On Android, the select-text dialog shows raw Markdown for assistant replies. iOS flattens it through `AidenMarkdownDocument.plainText`.
- On Android, the composer is not focused after "Ask about this".
- Physical-device visual acceptance on both platforms, including Dynamic Type and TalkBack/VoiceOver passes on the footer.
