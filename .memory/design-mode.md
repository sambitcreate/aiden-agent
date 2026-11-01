# Design mode

Status: active 2026-10-31. Spec v2 (infinite canvas) and P0/P1 plans written. P0 (retire Studio) and P1 (layout shell, 8 commits) done on branch `claude/design-mode-deep-dive`, not yet pushed; P1 is in review. P2 (canvas and frames) is next. P2–P5 plans are written before each phase.

- Spec: `docs/superpowers/specs/2026-10-31-design-mode-design.md`. Plans: `docs/superpowers/plans/2026-10-31-design-mode-p0-retire-studio.md`, `docs/superpowers/plans/2026-10-31-design-mode-p1-layout.md`.
- It replaces Design Studio (DS-1a, #385). P0 deletes the Studio code. It keeps the canvas, studio assets, the `finishTurn` harness, `generation-stream` and the `ChatOwnerV1` parser, and leaves data on disk.

## Owner decisions (2026-10-31)

- Attached to a workspace or an Aiden private folder (#667 removed no-workspace chats).
- Ships to people: default-on with a kill switch in P5. Until then behind `AIDEN_EXPERIMENTAL_DESIGN_MODE`.
- Desktop only now, Remote-ready later. The Remote projection must not expose `designMode` yet.
- The right side is an infinite canvas "like Create Images / Figma / open-design / Paper" where the agent creates things and the person points and annotates (owner, 2026-10-31). This superseded v1's browser-tabs canvas.

## Design choices

- Designs are workspace files (`design/<slug>.html`); the canvas document (`userData/design-canvases/<chatId>.json`, revision CAS) only records frames and comments.
- Canvas reuses `StudioCanvas` (xyflow). Frames: file, artifact, image, note, group. At most 6 live iframes; the rest show `capturePage` snapshots.
- Files are served by a new `aiden-design:` scheme: per-chat grant token, realpath containment, no network CSP, vendored libs under `__aiden/lib/`, injected bridge script. Iframes are `sandbox="allow-scripts"` only.
- Comments copy open-design: `data-aiden-comment` IDs written into the source, fuzzy re-anchoring (anchored, stale, lost), an `<attached-design-comments>` scoped block. Draw marks are normalised 0..1.
- Agent tools: `canvas_read` (tldraw-style context), `canvas_place_frame`, `canvas_update_frame`, `canvas_remove_frame`, `canvas_focus`, plus `design_mode` (consent card, `aiden_open` pattern, offered only when Inline visuals is `automatic`).
- Widths: chat 420 (360–560); canvas at least 480. Sidebar collapses below 1100 px; below 840 px the window widens to 1280 or shows a banner. Escape never leaves design mode.
- open-design (nexu-io) has no infinite canvas; its value is picking, comment anchoring and agent context. Avoid its CDN React/Babel, `allow-same-origin` and foreignObject screenshots.
- Owner (2026-10-31): ship design mode only. Create Images is being reworked in another thread, so keep edits to `renderer/canvas/*` and `studio/feature-flags.ts` additive and check for its open PRs before touching them.

## P0 notes (2026-10-31)

- Stale `/design` and `/design/$projectId` links use `beforeLoad: redirectRetiredRoute` (in `renderer/main/studio-capability-route.tsx`) and land on `/`. P1 replaces these routes.
- `llm-client` refuses a chat with any `owner` ("belongs to a feature that is no longer available"), keeping the old `resolveGenerationProfile` refusal for hidden `design-project` chats. The rule is `chatRunRefusal(chat)` in `renderer/shared/chat-visibility.ts` (keyed on surface "feature"), tested in `chat-visibility.test.ts`.
- `generation-harness.ts` (`createGenerationHarness`) is gone; `llm-client` builds `new PiAgentRuntimeHarness(...)` directly. The dead `inputClosed` admission flag was removed too. Extensions compose inline as base, then advisor, then codemode.
- Shortcut decided (2026-10-31): `design.toggle` = ⌘⇧L (`Command+Shift+L`), listed in `INTRODUCED_DEFAULT_COMMANDS`. ⌘⇧D stays with `dictation.toggle` (off by default, global; a local default on it would block enabling dictation). ⌘⇧G is find-previous (built-in-keys), ⌘⌥D is the macOS Dock toggle.
- Under Node, TanStack router-core always runs in server mode, so a `beforeLoad` redirect sets `router.state.redirect` without following it; tests follow it with `router.navigate`.
- Open PR #682 (chat images as files) edits main-window.html CSP and custom-schemes-core(.test).ts; P2 Task 3 touches the same lines — merge origin/main and recheck after it lands.

## P1 layout shell (2026-10-31, in review)

Module map:

- Flag: `AIDEN_EXPERIMENTAL_DESIGN_MODE` in `main/services/studio/feature-flags.ts`, surfaced as `AppCapabilities.designMode` (`renderer/lib/app-capabilities.tsx`). Off means no UI, no shortcut, no `/design`, and `chats:setDesignMode` refuses.
- Storage: `Chat.designMode?: boolean` (omitted means off) in `chat-store-core.ts`; written through `chat-application-service.ts` and the `chats:setDesignMode` handler (`main/handlers/chats.ts`, params in `chat-renderer-mutations.ts`), broadcast on `chats:design-mode-changed`. Bot and `owner` chats are never eligible. Not in the Remote projection.
- Window: `app:widenForDesign` (`main/handlers/design-window.ts`, pure `widenedBounds` in `main/windows/design-window-core.ts`) widens to min(1280, work area) when the work area is at least 840 px, otherwise returns null.
- Renderer state: `renderer/lib/design-mode.ts` has `designModeAvailable`, the optimistic `useSetDesignMode` hook (module-level in-flight map, settles on the latest), `DesignModeControlsContext` / `useDesignModeControls(chatId)`.
- Layout: `renderer/design/design-layout.tsx` (`DesignLayout`, `useDesignChatState`, `useDesignWindowPolicy`, the localStorage snapshot of panel and sidebar state taken on entry), `design-chat-divider.tsx` (separator "Resize chat", 360–560), `design-canvas-region.tsx` (inline or overlay), `design-canvas.tsx` + `design-canvas-empty.tsx` (placeholder until P2), `renderer/components/design-mode-banner.tsx`. Wired in `renderer/main/chat-layout.tsx` / `chat-pane.tsx`; the Environment panel is closed and forced to overlay, not unmounted (`environment-panel-layout.ts`).
- Sidebar: `chat-sidebar.tsx` scope list (‹ All projects row above the workspace heading) from `sidebar-workspace-groups.ts`.
- Entry points: `DesignModeToggle` in `chat-top-bar.tsx`; `design.toggle` (⌘⇧L, `INTRODUCED_DEFAULT_COMMANDS`, capability `designMode`) in `keybindings.ts`; `/design` and `/design off` in `slash-commands.ts`.
- Tests: `npm run test:design-mode` (design-mode, design-window-core, design-layout, chat-sidebar-scope, chat-top-bar-design) plus additions to the keybindings, command-system-core, shortcut-sheet, slash and store suites; E2E `tests/e2e/design-mode.spec.ts`. Screenshots are taken by that spec when `AIDEN_DESIGN_SCREENSHOTS=<dir>` is set.

Deviations from the P1 plan:

- Tasks 1–5: a dedicated `chats:design-mode-changed` channel instead of reusing chat updates; the store owns the shape checks and the service owns eligibility; the flag is enforced at the IPC handler as well as in the UI; param tests live in `chat-renderer-mutations.test.ts`; the hook test is `.tsx`; `designModeAvailable` takes an optional workspace and excludes `owner` chats; the channel is `app:widenForDesign`; `useSplitViewSidebar` carries the sidebar collapse; `test:design-mode` was created in Task 4 and lists the files that exist (the plan named files that were never created); the workbench is closed and forced to overlay rather than unmounted; the empty-state title is "Nothing on the canvas yet"; the banner shows again whenever the window drops below 840.
- Task 6: the scope test is a new behavioral file (`chat-sidebar-scope.test.tsx`) because `chat-sidebar.test.tsx` is a source-grep contract; a scoped sidebar forces the projects view and hides remote rows; the back row sits above the heading; choosing All projects holds per chat for the window session and resets when design mode turns off.
- Task 7: the shortcut handler lives in `DesignWorkbench` through `DesignModeControlsContext`, not in `root-view`; `CommandCapability` gates `design.toggle` (`paletteWhenAvailable`) in the palette, shortcut sheet and shortcut settings; new slash kinds `optional-off` argument, `design-mode` action, `design-chat` availability; `slashCommandWaitsForArgument` lets `/design` run on Enter with no argument; the composer offers `/design` only when the controls belong to its chat. Chats in a `noWorkspace` workspace are eligible; Assistant, Bot and `owner` chats are not.
- Task 8: the plan's "canvas at least 980 px at 1440" is impossible with the sidebar open (1440 − ~260 sidebar − 420 chat); the E2E asserts the canvas runs from the divider to the window edge and is at least 480. The widen and banner cases stub `screen.getDisplayMatching` in the main process, because xvfb's screen is 640×480. The canvas width follows the Environment panel spacer's 300 ms close transition, so the E2E polls until the canvas reaches the window edge. The fake model titles every chat with its reply, so the E2E renames each chat after its first message. Screenshots switch light/dark with `settings:previewAppearance` (not saved); setting `nativeTheme.themeSource` is ignored because the renderer keeps its own mode. The E2E passed (2/2) in a Linux Cua Space, so darwin-only paths were not exercised.
- Seen in the P1 screenshots, for P2: the global Live pill sits over the canvas zoom controls at the bottom right; at 800 px the overlay canvas covers the whole chat.
- Pre-existing, not ours: `renderer/main/chat-transition.test.tsx` hangs after all 35 tests pass, also at the base commit.
