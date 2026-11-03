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

## 2026-11-02: paired-computer recovery E2E readiness

Hosted #715 run [41553713235 / Electron E2E (1/3)](https://github.com/sambitcreate/aiden-agent/actions/runs/41553713235/job/125672657942), head `2a8f39680f21cb7a74bf686dfe3a3ae4d5a65dd9`: `remote-access-lifecycle.spec.ts:251` timed out clicking Try again at line 276. The button was disabled, then detached; built-in retry passed (73 passed, 5 skipped, 1 flaky), so `--fail-on-flaky-tests` correctly failed the job. #715 records the flake even after later passes.

A deterministic rendering probe with the real `usePeerHostSidebar`, `PeerHostsSettings` and `createAppQueryClient` reproduces the lifecycle: the sidebar caches an error with prior `[]` data; mounting Settings starts an automatic refetch while the cached error and disabled retry action remain visible. Switching the IPC handler to healthy at that point lets the in-flight refetch replace the button with the host row without any click. The control keeps the fault through the settled refetch, then changes the response and clicks the enabled action: one manual read loads the host. Production recovery is correct; the test changed its fault too early.

The scoped test follow-up on `feature/paired-computer-recovery-e2e`, based on fresh main `c975f6e77760d183e4fa548785ffde49423b5cb5`, waits for Try again to be enabled **before** replacing the failing handler. It retains the real manual read and failed-removal/retry assertions. This spec also sets child `AIDEN_ANALYTICS=0`. No production retry, timeout or UI changes.

Validation: the unchanged query/settings/spec sources are byte-identical between #715 head and fresh main (spec blob `2898ab96273e6502626a80c89a16e1e586dc4775`). The corrected E2E passed three independent Cua Space Linux-arm64 runs with `--retries=0` and the existing `--fail-on-flaky-tests` gate; both failure/removal recovery paths remain asserted. Connections/sidebar suites passed 15/15; E2E type-check, scoped ESLint and whitespace checks pass. Cua artifacts are under the worktree’s `test-results/cua-space-aiden-e2e-pr694/`; diagnostic probe output is `/tmp/aiden-715-recovery-probe.S9OeUm/results.log`. No native macOS rerun, hosted rerun or physical-device acceptance is claimed. #715 extraction stays untouched on its own branch; coordinator owns hosted CI.
