# Live Activity freshness chips and Bot deep links

Status: Complete — merged in [PR #276](https://github.com/sambitcreate/aiden-agent/pull/276) on 2026-09-30; on main after 0.51.0, not yet released. Android notification chips and physical-device acceptance remain follow-ups. This is the Hermex 1.7 parity slice for Aiden On The Go.

## Goal

- An iOS Live Activity shows at a glance how much work a run has done and how long ago it last moved, so a stale activity is obvious.
- A single Bot link opens that Bot's chat on iOS and Android, and is handled the same way as the existing `aiden-otg` deep links.

## Live Activity freshness chips (iOS)

- `AgentRunActivityAttributes.ContentState` gains `toolCallCount`.
  - The reducer increments it on each `toolStarted` transition and carries it through every other transition.
  - The displayed value is capped at `99+`.
  - Payloads encoded before this change decode it as `0`, because iOS keeps running activities across app updates.
- The lock screen header and the expanded Dynamic Island show two chips:
  - a tool chip, such as "3 tools", hidden when there are none;
  - a freshness chip, "Updated 12s ago", which becomes "Stale … ago" once the run misses its heartbeat or ActivityKit's 300 s `staleDate` passes.
- The time text uses `Text(date, style: .relative)`, so the system keeps it current while the app is suspended.
- The chips use soft pill fills and semantic text colors, with no colored borders.
- Marking a run stale now keeps its last real `updatedAt`. It no longer reports the stale transition as fresh progress.
- Foreground status reconciliation updates its labels while preserving the progress timestamp and its ActivityKit stale deadline. Expanded Dynamic Island status indicators share the same combined stale state as the freshness chip.

## Bot deep link

- Shape: `aiden-otg://bot/{botId}/chat`, with an optional `?instance={instanceId}`.
  - The request mentioned `aiden://`, but this uses the approved `aiden-otg` scheme that both native apps already register.
- Parsing is strict on both platforms:
  - exactly three path segments;
  - a safe identifier, `[A-Za-z0-9._:-]{1,160}`, checked against the raw percent-encoded path;
  - at most one `instance` query item;
  - no user info, port or fragment.
- Resolution uses Bots Home's canonical one-chat-per-Bot rule: latest `updatedAt`, then `createdAt`, then the smaller `chatId`.
- The link never creates a chat. If the Bot has no chat yet:
  - iOS opens Bots with that Bot selected and shows a notice;
  - Android opens the Bot profile.
- The Workspace shell refuses a Bot link rather than reinterpreting the ID.
- No Remote protocol change was needed, so no protocol revision is claimed.

## Follow-ups

- Freshness chips for Android's live run notification.
- A compact iPhone Bot profile for the no-chat case.
- Acceptance on a physical device: Lock Screen, Dynamic Island, and opening the link from Notes and Safari.
