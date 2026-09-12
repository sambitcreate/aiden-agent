# Quick View and Non-Modal Environment Tools

**Status:** Implemented — automated verification passed; unlocked visual acceptance pending on 2026-09-01

## Goal

Match Codex 26.818's two-mode workspace-tools pattern without weakening Aiden's
Git, file, or confirmation safety. The compact summary becomes **Quick View**;
the larger **Environment** surface keeps Review, Subagents, and Files.

## Delivery contract

- Keep the current 480–720px panel widths, 560px conversation floor, and
  1040px inline threshold.
- Pin Environment beside chat when space permits. Otherwise float it 12px from
  the right edge with a rounded semantic surface and `shadow-dialog`.
- Keep floating Environment non-modal: no backdrop, blur, app-wide inert state,
  focus trap, or command blocking. Background interaction does not dismiss it.
- Preserve `environment.toggle`, `Command-Shift-E`, `/environment`, existing
  storage keys, tab state, file drafts, selected diffs, subagent detail, width,
  polling ownership, and every existing Git/file safety dialog. The Environment
  toolbar control and command now open the last full tools destination directly.
- Give Quick View its own two-row list toolbar control, `quick-view.toggle`
  command, and `/quick-view` route. Quick View and Environment have independent
  open state: either control toggles only its own surface, and Environment deep
  links never clear Quick View.
- When both are open, place Quick View beside Environment whenever the measured
  workbench fits them. On smaller layouts, automatically present the most
  recently invoked surface while preserving the other open bit and mounted tool
  state for immediate restoration.
- Restore the opening trigger only when focus is still inside a closing surface;
  preserve focus that has already moved to the chat.
- Keep the assistant dock and command system usable, positioning the dock at the
  remaining chat edge while Environment is open.

## Documentation and validation

- Update the desktop UI inspiration guide and interactive specimen.
- Replace compact-modal regressions with non-modal interaction, focus, layout,
  copy, and compatibility coverage.
- Run focused renderer suites, type-check, lint, production build, Impeccable
  detection, and `git diff --check` after installing dependencies.
- Inspect native consumers to confirm that no shared DTO changed. Onboarding and
  mobile implementation changes are not expected because this is presentation
  and desktop interaction only.

## Known implementation papercuts

- Codex cannot live-automate its own host; the installed bundle and supplied
  screenshot are the reference evidence.
- This worktree started without installed dependencies, so React-backed tests
  require `npm ci` before verification.

## Delivered

Quick View now owns the compact status card and a dedicated two-row list toolbar
control. The original panel control, `Command-Shift-E`, and `/environment` open
the full Environment surface; `/quick-view` targets the compact card.
Environment retains one mounted Review/Subagents/Files surface, pins at the
existing 1040px allocation threshold, and otherwise floats without a backdrop or
modal interaction boundary. Quick View remains independently open when
Environment or the app sidebar is invoked; the measured workbench shows both
side by side when it fits and automatically hides the background surface on
smaller allocations without clearing its state. Automated verification covers
the independent reducer, measured placement, compact sidebar priority, command
compatibility, responsive floating-to-pinned handoff, and assistant-dock
containment. The dev app is running; final visual acceptance of the new
coexistence state awaits an unlocked macOS desktop.
