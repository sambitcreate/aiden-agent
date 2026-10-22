# Tool approval card redesign — 2026-10-22

Branch `claude/project-thread-khrad6`. The owner asked for a better-looking Allow/Deny prompt on desktop and iPhone, after a reference screenshot (centered icon tile, title, big code block, centered note, two equal buttons). On desktop the card follows the composer's corner radius, and Allow keeps a dropdown for the remembered scopes.

- **Desktop** (`renderer/components/chat-approval-card.tsx`):
  - The card is `composer-shell`, with `.approval-well` and `.approval-icon-tile` in `renderer/styles.css`.
  - `approvalHeadline` asks a plain question. `approvalCommand` strips "Run command: " from a paired host's summary.
  - Deny and Allow once are equal `size="large"` buttons. Deny keeps initial focus.
  - The chevron menu lists "Allow for this chat" and "Always allow in this workspace", each with a one-line hint.
  - Hints must match `toolApprovalRuleTarget`: a command rule is the exact command, but a file rule is tool + path, so it covers any later edit/write to that file ("any edit to forecast.ts"). iOS/Android `scopeDetail(scope, toolName)` say the same. Pullfrog flagged the earlier "this exact action" wording as understating file grants.
  - Specialized approvals (schedule, classifier, subagent grants, form fill, MCP mutation) keep their own bodies inside the shell.
- **Desktop-only preview** (`renderer/shared/tool-approval-preview.ts`):
  - `llm-client.ts` adds `preview` to the approval descriptor only for calls without `details`.
  - A preview is the exact command, or a bounded diff: 40 lines of up to 400 characters, with 2 context lines.
  - `aiden-remote-streams.ts` and `host-run-registry.ts` copy only named fields, so phones and run observers never receive it.
  - It must stay a separate field: putting it in `details` would make phones unable to allow.
- **iOS and Android**:
  - `AidenApprovalCard` (iOS) and `AidenApprovalCardContent` (Android, shared by the chat banner and the Bot card) use the same layout.
  - Wording comes from `AidenApprovalPresentation.headline` / `requestedAction`, matched to the desktop strings. Prefixes are stripped only for the tool that writes them.
  - iOS `AidenPendingApproval` gained `toolName`.
  - Android `AidenSplitButton` gained `fillWidth`.
  - An expanded request scrolls in a bounded box (Android 200dp, iOS 240pt) because the Android workspace chat and the iOS Bot chat keep the card in a non-scrolling footer. `AidenApprovalCardUiTest` (androidTest) checks Show less and the buttons stay displayed.
- **CLI daemon**: `daemonApprovalSummary` writes "Run command: X", "Read file: X" or "List folder: X" only when that one argument is the whole call. Anything else stays `${tool}: ${json}`, so nothing is hidden.
- **Activity summary** (desktop `summarizeActivity`, iOS and Android `summary`):
  - A `blocked` call counts as "skipped N command(s)/file change(s)/action(s)".
  - `awaiting_approval` calls are not counted, and the summary reads "Waiting for approval" while a call waits.
  - `cancelled` calls still count, because they may have run partway.
- After a Deny, the composer placeholder reads "Tell Aiden what to do instead" until the next send (`DENIED_APPROVAL_COMPOSER_PLACEHOLDER`).
- **Tests**:
  - `renderer/components/chat-approval-card.test.tsx` and `renderer/shared/tool-approval-preview.test.ts` (both in `test:tool-approval-card`, CI lane `renderer-other`).
  - A phone-isolation case in `aiden-remote-streams.test.ts`.
  - A CLI parity case for the summary.
  - iOS `AidenChatTests` and Android `AidenChatTest` cover headline and skipped cases.
