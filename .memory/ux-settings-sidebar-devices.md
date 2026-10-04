# UX pass: Settings, Git panels, Browser and Devices (October 2026)

Branch `ux/settings-sidebar-devices`. Fixes from the renderer UX audit (UI-33..38, UI-55..66, UI-73..76).

## Shipped
- **Shared primitives (`renderer/components/ui.tsx`)**
  - `Badge` colour is typed `BadgeColor` (gray/green/red/blue/warning). "secondary" and "purple" were silently unstyled.
  - `Dialog` has an opt-in `submitOnEnter`, backed by `renderer/lib/dialog-enter.ts`: Enter in single-line inputs, Mod+Enter anywhere, ignores IME, comboboxes, nested forms and portalled content. It is opt-in because onboarding and the composer handle Enter without `preventDefault`.
  - `AlertDialog` records its opener and returns focus to it on close.
- **Providers:** removal failure stays open with an inline alert, and Retry works. Info popovers open from the keyboard (Popover, not HoverCard). Badges read "Key saved", "Needs API key" and "No key needed". The "Model catalog" group sits last.
- **Settings search** (`matchesSettingsSearch`): every whitespace token must match title, keywords or description.
- **About:** Reset is its own destructive FieldSet.
- **Git:** the branch picker offers "Create branch “<query>”…" from the search text. Commit-mode and upstream cards have no decorative borders.
- **PR popover:** loading and error states, refresh failure with Try again, Undo toast after unlink, plain-text chip with a full aria-label (`renderer/lib/chat-pull-request-chip.ts`).
- **Files:** `renderer/lib/workspace-file-open-error.ts` classifies the main-process read errors (binary, too large, too many lines, not UTF-8, not a file) as permanent. It hides Try again and shows guidance. The classifier matches message suffixes, so keep it in sync with `main/services/workspace-files.ts`; its test uses the real errors.
- **Devices and Browser:**
  - A failed first state read shows a retryable failure instead of an endless spinner.
  - Browser profile delete and simulator shutdown confirm with a destructive `AlertDialog`.
  - Browser settings shows the latest browser error inline, because the modal hides the panel strip.
  - 3D-frame blocker uses `aria-disabled` and `aria-describedby`. Rail buttons are `iconOnly`.
  - The Device tools drawer focuses on open and returns focus on Escape or close. The annotation editor focuses on open, and focus returns to Annotate.

## Deferred (owner decisions)
- **UI-55:** Settings regrouping needs a prototype first.
- **UI-59:** renames are a naming decision.
- **UI-58:** full settings-design migration.
- **UI-33 and UI-34:** onboarding belongs to the chat/onboarding branch.
- **UI-60 and the chat-sidebar half of UI-62:** belong on PR #311.
- **UI-61:** making it the default needs onboarding and the composer to call `preventDefault` first.
- **UI-66:** "Open with default app" needs a new path-contained IPC.
