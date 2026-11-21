# Sidebar chat list as a keyboard collection (UI SDK lessons Unit 8, 2026-11-19)

Branch `feature/ui-codebase-aiden-analysis-4d5598`, desktop renderer only, no Remote contract change.

## What existed
- `renderer/lib/roving-rows.ts` already gave the sidebar (and the Bot sidebar) one Tab stop, ↑ ↓ Home End and → ← folders, with rows marked `data-roving-item` / `data-roving-row` / `data-roving-group`. Shift+F10 and the Menu key already open a row's context menu (`openContextMenuFromKeyboard`). The brief's "no roving" finding was stale.
- Per-chat actions are only Rename, Rename with Apple and Delete. There is no archive, pin (outside the Inbox) or move-to-workspace IPC (`chats:moveEmptyToWorkspace` is for empty drafts only), so the bulk bar offers Delete only.

## Built
- `roving-rows.ts`: → ← swap under `dir="rtl"`; a 500 ms typeahead (`typeaheadMatch`, `typeaheadLabel` skip `aria-hidden` hints, fold case and accents, repeat-letter cycling, Space continues a query). Typeahead only after keyboard arrival: a pointerdown in the list turns it off, roving keys turn it on, and focusin follows `data-input-modality` (else keeps the last arrival), so script focus (dialog return, recovery) doesn't flip a mouse user into typeahead. While on, the list carries `data-typeahead="on"`; only `use-composer-type-focus.ts` reads it (`isTypeaheadTarget`). Review: putting it in the shared `isReservedTypingSurface` broke ⌘↩/⌘⌫ and Deny focus (`approvalShouldTakeFocus`) from a keyboard-focused row, so it must stay out of there (`renderer/lib/approval-shortcuts.test.ts`).
- `focus-recovery.ts`: `watchFocusRecovery(container, rows, rowFor)` (wired inside `useRovingRows`) watches for the focused row leaving; a MutationObserver callback later, if focus fell to the body, focuses the next surviving row, else the previous, else the list's current Tab stop, else the container (given `tabindex=-1` only until its next blur). `focusAfterRemoval` is the pure picker, also used for bulk delete.
- `range-selection.ts`: anchor plus base; a second Shift range replaces the previous range, not the base. `retainSelection` prunes rows that left (search, collapsed folder, deleted).
- `use-row-selection.ts`: delegated capture click (⌘ on darwin, Ctrl elsewhere toggles; Shift ranges; `event.detail === 0` keyboard clicks are ignored so ↩ opens as before; a plain click clears), Shift+↑↓ moves and extends, `isDismissKey` Escape clears. Prunes in a layout effect every render while non-empty.
- `ChatRow` takes `selectId` / `inSelection` (standard layout only): `data-select-id`, list-selection fill, `aria-description` "Selected".
- `chat-sidebar.tsx`: selection is enabled outside the Inbox, local rows only (drafts, remote rows and Inbox rows have no `selectId`). `SelectionBar` (`sidebar/selection-bar.tsx`, role group "Selected chats", status count, Delete, Clear) renders in the `belowList` slot, which is inside the roving region. Bulk Delete: `AlertDialog` "Delete N chats?" listing titles, `keepOpenOnConfirm` + busy, `runInOrder` (`renderer/lib/bulk-delete.ts`) over `chatsApi.remove` + `removeDeletedChatFromCache`, skips a chat renaming with Apple (as single Delete does), stops on the first failure with "Deleted N of M; …" and keeps the rest selected, navigates home if the open chat went, returns focus to `focusAfterRemoval` of the selection. Single Delete from a row menu now returns focus to that row so recovery moves on to the next one.

## Decisions
- Rows stay buttons (no tree/treeitem or listbox): `<button>` can't take `treeitem`, and the ••• buttons beside each row would break `aria-required-children`. The Unit 9 axe gate and many e2e `getByRole("button")` lookups rely on the current shape.
- The Inbox keeps its own `useFocusFollowsRemoval` (synchronous, frozen-row aware); the shared recovery is a no-op there because focus is already placed.
- Built-in keys (`renderer/shared/built-in-keys.ts`) list "Select several chats"; `docs/keyboard.md` and the design guide's Collections section describe the behaviour.

Tests: `renderer/lib/range-selection.test.ts`, `renderer/lib/focus-recovery.test.ts`, `renderer/components/sidebar/chat-list-selection.test.tsx`, extended `renderer/lib/roving-rows.test.tsx` plus `renderer/lib/approval-shortcuts.test.ts` (all in `test:sidebar`). E2E: `tests/e2e/chat-shell-interactions.spec.ts` sidebar keyboard + bulk delete test.

Related: [[sidebar-chat-row-context]], [[chat-row-states]], [[inbox-sidebar]].
