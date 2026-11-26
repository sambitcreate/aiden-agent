# Composer Up-Arrow Message History

2026-11-25.

## Behavior
- Pressing `↑` in an empty composer opens the floating message history popover above the composer, live-fills the textarea with the newest sent prompt, and displays the paired assistant reply preview beneath the history list.
- Repeated `↑` steps upward through older prompts (clamped at the oldest); `↓` steps back down toward newer prompts and, past the newest entry, closes the popover and restores the empty draft.
- Transient browsing does not write to `localStorage` or trigger `expiredCacheReturn.markReturned()`; persistence occurs only on commit (`↩`, row click) or detach (typing, paste, caret movement, blur).
- `↩` (or clicking a row) commits the highlighted prompt into the composer without immediately submitting, suppressing both slash and mention trigger palettes on commit, detach, and blur.
- `Esc` closes the popover via `useLayer(historyOpen, "popover", { name: "composer-history", onEscape })` and restores the saved draft without triggering `escapeStopsGeneration`.
- `⌥↩` (`Alt+Enter` off macOS) on a settled, fork-eligible turn triggers **Edit in fork** (`forkFromTurn(forkMessageId, "before")`), gated on idle/non-blocked session state.
- Typing (`onChange`), pasting, starting IME composition, clicking inside the textarea (`onPointerDown`), pressing caret-navigation keys (`ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, or modified `ArrowUp`/`ArrowDown`), or blurring detaches the popover while keeping the recalled text in the composer.
- External draft updates (`stageComposerText`, `restoreUndeliveredGuidance`, `restoreUnsentMessage`, browser annotations) and blocking transitions (`slashPaletteBlocked`, dialogs, dictation) unwind transient history cleanly back to `savedDraft`.
- Blocked when the composer holds text, attachments, grabbed browser elements, mentions, a selected skill, or design comments, when locked/read-only, while an overlay layer (`hasOpenLayer(isOverlayLayer)`) or composer dialog/menu is open, or during voice recording/transcription.

## Architecture & Scope
- Pure logic: `renderer/lib/composer-history.ts`
  - `composerHistoryFromMessages`: extracts user-authored messages (`role === "user" && !notice && !fromLeadChat` with non-empty `content.trim()`), paired with the following assistant reply before the next `role === "user"` message, classifying `answered` / `failed` / `blocked` / `stopped` / `pending` / `none`. A persisted `timeline.status` of `cancelled` reads as `stopped` (partial text kept as the preview) and `failed` reads as `failed` even without `providerFailure`, matching `liveChatEnding`. The first typed edit of a recalled prompt dismisses slash/skill/mention triggers like the other history-detach paths.
  - `composerHistoryFromBotEntries`: extracts `type === "user"` entries from `BotTranscriptEntry[]` paired with the following `type === "assistant"` entry.
  - Pure state transitions (`openComposerHistory`, `stepComposerHistoryUp`, `stepComposerHistoryDown`, `previewComposerHistoryEntry`, `selectComposerHistoryEntry`, `dismissComposerHistory`, `detachComposerHistory`, `reconcileComposerHistory`).
- Popover UI: `renderer/components/composer-history-popover.tsx`
  - Reuses the `ComposerSlashPalette` / `ComposerMentionPicker` borderless raised popover surface (`bg-popover/98`, `shadow-popover`, `rounded-dialog`, `data-browser-occluder`, `usePresence`, `revealInList`, `useDebouncedAnnouncement`).
  - `role="listbox"` / `role="option"` with no nested interactive child elements (axe `nested-interactive` compliant); textarea retains focus via `aria-controls` and `aria-activedescendant`.
  - Paired reply preview sits below a `border-t border-separator` divider (`bg-input`) showing status + 3-line clamped plain-text reply preview and keyboard hints.
- Wiring:
  - `Composer` accepts optional `historyEntries?: readonly ComposerHistoryEntry[]`, defaulting to `sessionChat?.messages` (local `ChatPane`).
  - Wired into `remote-chat-view.tsx`, `bot-chat-pane.tsx`, and `remote-bot-chat-view.tsx`.
  - Floating Quick Chat (`renderer/quick-chat/floating-composer.tsx`) is a separate lightweight starter/modal composer with custom Electron window resize coordination (`onBeforePopoverOpen`) and is intentionally left unchanged for now.

## Tests
- Pure unit tests: `renderer/lib/composer-history.test.ts` (registered in `test:command-system`).
- Mounted behavioral tests: `renderer/components/composer-edit-last.test.tsx` (in `test:command-system`) and `renderer/components/composer-dictation.test.tsx` (in `test:voice`).
- E2E test: `tests/e2e/chat-shell-interactions.spec.ts` ("↑ in an empty composer shows message history with each previous reply and recalls prompts").
