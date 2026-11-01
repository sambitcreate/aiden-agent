# Design mode P1: layout, per-chat state and entry points — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can turn design mode on and off for a workspace chat. The sidebar narrows to the project, the chat becomes a narrow left column, and an empty design canvas fills the rest (P2 fills it). The setting survives a reload.

**Architecture:**
- **State:** a `designMode` flag on the chat record in main. It has a store setter, an application-service method, an IPC call, and the metadata broadcast.
- **Hook:** the renderer reads it through an optimistic `useDesignMode` hook.
- **Layout:** a pure resolver decides widths and small-window policy. A new `DesignCanvasRegion` replaces the workbench while design mode is on; the workbench state is saved and restored.
- **Entry points:** the top-bar toggle, ⌘⇧L and `/design`.

**Tech Stack:** Electron, React 19, TanStack Router and Query, `tsx --test`, Testing Library and `renderToStaticMarkup`, Playwright.

**Spec:** [`docs/superpowers/specs/2026-10-31-design-mode-design.md`](../specs/2026-10-31-design-mode-design.md) §3, §4, §6.2 (person entry only), §7 and §9.

## Global Constraints

- P0 has merged first. `design.open` and the `designStudio` capability are gone. ⌘⇧L (`Command+Shift+L`) is unclaimed by any command or built-in key; ⌘⇧D stays reserved for `dictation.toggle`'s default.
- **Flag:** `AIDEN_EXPERIMENTAL_DESIGN_MODE` ("1" or "true") gates everything in this plan through capability `designMode`. With the flag off, no toggle, command, shortcut or layout change exists.
- **Eligible chats:** a chat with a folder workspace or an Aiden private folder, no `botId`, and not the Assistant workspace. `setDesignMode` on any other chat throws `ChatStoreError("design-mode-unavailable")` (or the store's existing error type with that code).
- **Widths:**

  | Value | px |
  |---|---|
  | chat default | 420 |
  | chat minimum | 360 |
  | chat maximum | 560 |
  | canvas minimum | 480 |
  | sidebar collapse below (window width) | 1100 |
  | needs a wider window below | 840 |
  | widen target | 1280 |

- **Width storage:** the chat width is stored in localStorage key `aiden-agent.design.chat-width`. Design mode never writes the normal panel width keys.
- **Desktop only:** the Remote projection must not gain `designMode`. Make no Remote revision, iOS, Android or CLI change.
- **Optimistic:** toggles flip at once and roll back if IPC fails (owner rule: phone and desktop actions are instant).
- **Design rules:** UI follows `GUI.md` and `docs/design-guide.md`. The toggle uses the shared squircle button with `aria-pressed`, there are no decorative borders, and focus-visible rings are kept. Review `docs/chatgpt-desktop-ui-inspiration.md` and `docs/chatgpt-ui-element-specimen.html` before styling.
- **Test registration:** new test files go in `package.json` (new `test:design-mode` script appended to the `test:serial` chain) and `scripts/ci-test-registry.json`. Run `npm run test:ci-policy`.
- **Screenshots:** take them for every new or changed UI (light and dark, 1440 and 1000 px) before asking for approval. Window-opening tests run with `npm run test:e2e:space`.

## Review Focus

1. **Switching chats:** going from a design-mode chat to a normal chat and back must change the layout, sidebar scope and panel within one render, with no flash of the wrong layout. The test is in Task 5.
2. **The person had the panel open on Terminal at 700 px before entering:** on exit they get Terminal at 700 px back, not Browser at the design width. The test is in Task 5.
3. **Window resized below 840 px while in design mode:** the canvas overlays the chat instead of squeezing the chat below 360 px. Exit still restores. Tests are in Tasks 2 and 5.
4. **Two windows on the same chat** (or a phone renaming it at the same time): the `designMode` metadata broadcast must not drop a concurrent title change, and a title broadcast must not clear `designMode`. The test is in Task 3.
5. **Deleting or archiving a design-mode chat, or moving its workspace folder:** the sidebar scope must clear and the layout must return to normal, rather than leaving an empty scoped sidebar. The test is in Task 6.

---

### Task 1: Feature flag and capability

**Files:**
- Modify: `main/services/studio/feature-flags.ts`, `renderer/lib/app-capabilities.tsx`
- Test: `main/services/studio/feature-flags.test.ts`, `renderer/lib/app-capabilities.test.ts`

**Interfaces:**
- Produces: `DESIGN_MODE_FEATURE_FLAG = "AIDEN_EXPERIMENTAL_DESIGN_MODE"`, `designModeEnabled(env?): boolean`, `studioCapabilities(env): { createImages: boolean; designMode: boolean }`, and `useAppCapabilities().designMode: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `designModeEnabled({ AIDEN_EXPERIMENTAL_DESIGN_MODE: " TRUE " })` is `true`; `designModeEnabled({})` is `false`; `designModeEnabled({ AIDEN_EXPERIMENTAL_DESIGN_MODE: "0" })` is `false`.
  - `studioAssetsEnabled({ AIDEN_EXPERIMENTAL_DESIGN_MODE: "1" })` is `false`, because design mode does not need the asset store.
  - The capabilities provider exposes `designMode` from the bootstrap payload.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/services/studio/feature-flags.test.ts renderer/lib/app-capabilities.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement it with the existing `flagOn` helper and thread `designMode` through the capabilities bootstrap** the same way `createImages` flows.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Add design mode feature flag`.

### Task 2: Layout resolver

**Files:**
- Modify: `renderer/lib/environment-panel-layout.ts`
- Test: `renderer/lib/environment-panel-layout.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const DESIGN_CHAT_WIDTH_BOUNDS: PanelWidthBounds; // { min: 360, max: 560, default: 420 }
  export const DESIGN_CANVAS_MIN_WIDTH = 480;
  export const DESIGN_SIDEBAR_COLLAPSE_BELOW = 1100;
  export const DESIGN_WIDE_WINDOW_MIN = 840;
  export const DESIGN_WIDEN_TARGET = 1280;
  export interface DesignCanvasLayout { chatWidth: number; canvasWidth: number; inline: boolean }
  export function resolveDesignCanvasLayout(preferredChatWidth: number | undefined, containerWidth: number): DesignCanvasLayout;
  export function resolveDesignWindowPolicy(windowWidth: number): { collapseSidebar: boolean; needsWiderWindow: boolean };
  ```

- [ ] **Step 1: Write the failing tests** (`containerWidth` is the main content width after the sidebar).

  | Call | Expected |
  |---|---|
  | `resolveDesignCanvasLayout(undefined, 1400)` | `{ chatWidth: 420, canvasWidth: 980, inline: true }` |
  | `resolveDesignCanvasLayout(300, 1400)` | chat 360 |
  | `resolveDesignCanvasLayout(900, 1400)` | chat 560, canvas 840 |
  | `resolveDesignCanvasLayout(560, 900)` | `{ chatWidth: 420, canvasWidth: 480, inline: true }` (the chat gives way to the canvas minimum) |
  | `resolveDesignCanvasLayout(420, 839)` | `inline: false`, `chatWidth: 839` (the canvas overlays; the chat is never below 360 inline) |
  | `resolveDesignCanvasLayout(Number.NaN, 1400)` | chat 420 (bad stored values fall back to the default) |
  | `resolveDesignWindowPolicy(1099)` | `{ collapseSidebar: true, needsWiderWindow: false }` |
  | `resolveDesignWindowPolicy(839)` | `{ collapseSidebar: true, needsWiderWindow: true }` |
  | `resolveDesignWindowPolicy(1100)` | `{ collapseSidebar: false, needsWiderWindow: false }` |

  Also assert `chatWidth + canvasWidth === containerWidth` whenever `inline`, across a sweep of `containerWidth` from 840 to 2400 in steps of 37 and preferred widths of 360, 420 and 560.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/lib/environment-panel-layout.test.ts`
  - Expected: FAIL. The functions are not exported yet.
- [ ] **Step 3: Implement the resolver.**
  - Clamp with `clampEnvironmentPanelWidth`, treating a non-finite value as the default.
  - Use `inline = containerWidth >= DESIGN_CHAT_WIDTH_BOUNDS.min + DESIGN_CANVAS_MIN_WIDTH`.
  - When inline, `chatWidth = min(clamped, containerWidth - DESIGN_CANVAS_MIN_WIDTH)`.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Add design mode layout resolver`.

### Task 3: Per-chat `designMode` in main, over IPC

**Files:**
- Modify:
  - `main/services/types.ts`: `ChatMeta`, around line 468.
  - `main/services/chat-store-core.ts`: next to `setChatModelSelection`, around line 1638.
  - `main/services/chat-application-service.ts`: next to `setModelSelection`, around line 231.
  - `main/handlers/chat-renderer-mutations.ts` and `main/handlers/chats.ts`: register next to `chats:setModel`, around line 355.
  - `renderer/preload-channels.ts`, `renderer/lib/ipc.ts` (next to line 1587), and `renderer/lib/types.ts` (`ChatMetadataUpdated`, line 786, and the renderer `ChatMeta` mirror).
- Test: `main/services/chat-store-core.test.ts`, `main/handlers/chat-renderer-mutations.test.ts`, `main/handlers/chat.parse.test.ts`, `main/services/aiden-remote-chat-summaries.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ChatMeta
  designMode?: true;
  // store
  setDesignMode(id: string, enabled: boolean): Promise<Chat>;
  // application service
  setDesignMode(chatId: string, enabled: boolean): Promise<Chat>;
  // IPC "chats:setDesignMode" (chatId: string, enabled: boolean) => Chat
  // renderer/lib/ipc.ts
  setChatDesignMode(chatId: string, enabled: boolean): Promise<Chat | null>;
  // ChatMetadataUpdated
  designMode?: boolean;
  ```

- [ ] **Step 1: Write the failing tests.**
  - **Store:**
    - `setDesignMode(id, true)` then reopening the store from disk gives `designMode === true` in both the chat and the meta list.
    - `setDesignMode(id, false)` removes the key: `"designMode" in meta` is false.
    - A second identical call does not bump `updatedAt`.
    - Forking a design-mode chat gives a fork without `designMode`.
    - A Bot chat, an Assistant chat and a chat with no workspace each reject with code `design-mode-unavailable`.
  - **Handler:**
    - The params parser rejects a non-boolean `enabled` and a missing `chatId`.
    - The register-and-invoke round trip returns the renderer chat and broadcasts `chats:metadata-updated` with `designMode: true` and the current `title`.
    - Concurrency: a rename and a `setDesignMode` on the same chat leave both the new title and `designMode` set (Review Focus 4).
  - **Remote:** `projectAidenRemoteChat` and the summary projection for a chat with `designMode: true` produce output with no `designMode` key.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/services/chat-store-core.test.ts main/handlers/chat-renderer-mutations.test.ts main/handlers/chat.parse.test.ts main/services/aiden-remote-chat-summaries.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement it in the `setChatModelSelection` shape:** `shared([id], true, …)`, `readChat(id, "owner")`, an early return when unchanged, then `writeChatAndMeta`. Unlike `setModelSelection`, the application service has no busy check, because design mode may change mid-turn. It returns `chatForRenderer(chat)`.
- [ ] **Step 4: Run the tests again.** Expected: PASS. Then run `npm run type-check`.
- [ ] **Step 5: Commit** with the message `Store design mode per chat`.

### Task 4: `useDesignMode` hook

**Files:**
- Create: `renderer/lib/design-mode.ts`
- Test: `renderer/lib/design-mode.test.ts`

**Interfaces:**
- Consumes: `setChatDesignMode` (Task 3) and `useAppCapabilities().designMode` (Task 1).
- Produces:
  ```ts
  export type DesignModeSource = "toggle" | "shortcut" | "slash";
  export function designModeAvailable(chat: Pick<Chat, "workspaceId" | "botId"> | undefined, capabilities: { designMode: boolean }): boolean;
  export function useDesignMode(chatId: string | undefined): {
    available: boolean;
    on: boolean;
    set(enabled: boolean, source: DesignModeSource): void;
    toggle(source: DesignModeSource): void;
  };
  ```

- [ ] **Step 1: Write the failing tests.**
  - `designModeAvailable` is false with the capability off, false for a `botId` chat, false for the Assistant workspace, and true for a folder or private-folder chat.
  - Rendering the hook with a Query client seeded with a chat:
    - `toggle("toggle")` flips `on` before the IPC promise resolves.
    - A rejected IPC rolls back to the previous value and reports through the existing toast path.
    - A `chats:metadata-updated` event with `designMode: false` for that chat sets `on` to false.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/lib/design-mode.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement it with the chat query cache update pattern used by the model selection mutation,** with `onMutate` for the optimistic change and `onError` for the rollback.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Add optimistic design mode hook`.

### Task 5: Design layout, canvas region and window policy

**Files:**
- Modify:
  - `renderer/main/chat-layout.tsx`: the SplitView sidebar, the `EnvironmentWorkbench` mount and the chat column.
  - `renderer/components/environment-panel.tsx`: only to expose a `suspendForDesign` hook-up, so the workbench closes on entry and restores `{tab, width, open}` on exit (lines 2020–2182).
  - `renderer/styles.css`: a `[data-design-mode]` chat column override that sets `--chat-content-max-width: none` and `--aiden-dock-gutter: 16px`.
  - `renderer/preload-channels.ts` and `renderer/lib/ipc.ts`.
- Create:
  - `renderer/design/design-canvas-region.tsx`: the right-hand region. In P1 it renders an empty `StudioCanvas` (no nodes, dotted background, zoom controls) with the empty-state copy "Ask Aiden to design something, or add a note." P2 fills it.
  - `renderer/design/design-chat-divider.tsx`: the drag divider between the chat column and the canvas.
  - `main/windows/design-window-core.ts`, `renderer/components/design-mode-banner.tsx`.
- Test: `main/windows/design-window-core.test.ts`, `renderer/design/design-layout.test.tsx`

**Interfaces:**
- Consumes: `resolveDesignCanvasLayout`, `resolveDesignWindowPolicy` and the constants (Task 2), and `useDesignMode` (Task 4).
- Produces:
  ```ts
  // main/windows/design-window-core.ts
  export function widenedBounds(current: Rectangle, workArea: Rectangle, target?: number /* 1280 */): Rectangle | null; // null when it cannot reach 840
  // IPC "window:widenForDesign" () => { widened: boolean }
  // renderer/design/design-canvas-region.tsx
  export function DesignCanvasRegion(props: { chatId: string; width: number; overlay: boolean }): JSX.Element;
  ```
  `DesignModeBanner({ onWiden }: { onWiden(): void })` renders the text "Design mode needs a wider window" and a **Widen window** button.

- [ ] **Step 1: Write the failing tests.**
  - **`widenedBounds`:**
    - `{x:100,y:0,width:800,height:700}` in a `{x:0,y:0,width:1440,height:900}` work area gives width 1280, `x` moved left to 100 or less so the right edge fits, and the height unchanged.
    - In a 1024-wide work area it gives width 1024 at `x = 0`.
    - In an 800-wide work area it gives `null`.
  - **`design-layout.test.tsx`** (Testing Library; xyflow and the native browser view stubbed as in `renderer/canvas/studio-canvas.test.tsx` and `environment-panel-focus.test.tsx`):
    - With design mode on at a 1400 px container, the chat column is 420 wide, the canvas region is 980 wide and inline, and the environment workbench is not rendered.
    - Turning design mode off restores the previously selected workbench tab (Terminal), the previous stored width (700) and its open state (Review Focus 2).
    - Re-rendering from a design chat to a normal chat in one `rerender` never renders the canvas region with the normal chat's ID (Review Focus 1).
    - At an 800 px container, the region is an overlay and the chat column is not narrower than 360 (Review Focus 3).
    - Dragging the divider writes `aiden-agent.design.chat-width` and leaves the normal environment width key unchanged.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test main/windows/design-window-core.test.ts renderer/design/design-layout.test.tsx`
  - Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - `chat-layout.tsx` sets `data-design-mode` on the chat column and, while it is on, renders `DesignCanvasRegion` in place of the workbench. The workbench's `{tab, width, open}` is saved in a ref when entering and restored when leaving.
  - On entry it applies `resolveDesignWindowPolicy`: it collapses the sidebar and remembers that it did, calls `window:widenForDesign` when `needsWiderWindow`, and shows `DesignModeBanner` when that returns `widened: false`.
- [ ] **Step 4: Run the tests again,** plus `npx tsx --test renderer/components/workbench-panel.test.tsx renderer/components/environment-panel-focus.test.tsx renderer/lib/environment-panel-layout.test.ts renderer/canvas/canvas-controls.test.tsx renderer/canvas/canvas-keymap-core.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Lay out chat and canvas for design mode`.

### Task 6: Scoped sidebar

**Files:**
- Modify: `renderer/components/chat-sidebar.tsx` (`ChatSidebarProps`, line 154; filtering, around lines 600–637), `renderer/main/chat-layout.tsx`
- Test: `renderer/components/chat-sidebar.test.tsx`

**Interfaces:**
- Consumes: `useDesignMode` (Task 4).
- Produces:
  ```ts
  // ChatSidebarProps
  scopeWorkspaceId?: string | null;
  onClearScope?: () => void;
  ```
  - `null` means unscoped. A private-folder chat passes the private folder's workspace id, and the sidebar shows the Chats group.
  - The back row follows the precedent in `renderer/main/bots/bot-sidebar.tsx:302`.

- [ ] **Step 1: Write the failing tests.**
  - With chats in workspaces `a` and `b` and `scopeWorkspaceId="a"`, the rendered list holds only `a`'s chats, under a heading with `a`'s name and path, with the first row "‹ All projects".
  - Activating the back row by click, and by Enter on the focused row, calls `onClearScope` once.
  - Arrow-key navigation (the existing sidebar roving focus) starts at the back row.
  - When the scoped workspace has no chats left (all deleted or archived, or the workspace was removed), the sidebar renders unscoped and calls `onClearScope` (Review Focus 5).
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/components/chat-sidebar.test.tsx`
  - Expected: FAIL.
- [ ] **Step 3: Implement it.**
  - Filter in the existing grouping step.
  - `chat-layout.tsx` passes the active chat's workspace when `useDesignMode(...).on` and the person has not cleared the scope. The cleared state lives in a component state keyed by chat id, so it is per window session and not persisted.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Scope the sidebar to the project in design mode`.

### Task 7: Entry points (toggle, ⌘⇧L, `/design`)

**Files:**
- Modify: `renderer/components/chat-top-bar.tsx`, `renderer/shared/keybindings.ts`, `renderer/main/root-view.tsx`, `renderer/shared/slash-commands.ts` (next to `/visualize`, around lines 545–557), `renderer/lib/slash-command-actions.ts`
- Test: `renderer/components/chat-top-bar-design.test.tsx` (create), `renderer/components/composer-slash-palette.test.tsx`, `renderer/lib/shortcut-sheet.test.ts`, `renderer/lib/command-system-core.test.ts`

**Interfaces:**
- Consumes: `useDesignMode` and `DesignModeSource` (Task 4).
- Produces:
  - Keybinding id `design.toggle` (`defaultBinding: "Command+Shift+L"`, `requiresCapability: "designMode"`, scope `app`, not global). Add it to `INTRODUCED_DEFAULT_COMMANDS` in `renderer/shared/keybindings.ts` so a saved custom ⌘⇧L wins and the new command starts disabled. Test with `repairKeybindingOverrides`: a stored custom `Command+Shift+L` on another command keeps it and disables `design.toggle`; enabling `dictation.toggle` at its default never conflicts.
  - Slash command `design` with `availability: "workspace-chat"`, an optional argument whose only accepted value is `off`, and copy "Design mode" / "Chat on the left, canvas on the right".
  - Top-bar button with accessible name "Design mode" and `aria-pressed`.

- [ ] **Step 1: Write the failing tests.**
  - **Top bar:** with the capability on and an eligible chat, a button named "Design mode" has `aria-pressed="false"`. Clicking it calls `set(true, "toggle")` and it shows `aria-pressed="true"`. It is absent for a Bot chat and with the capability off.
  - **Slash palette:** typing `/des` in a workspace chat lists "Design mode"; in the Assistant it does not.
    - Running `/design` calls `set(true, "slash")`.
    - `/design off` calls `set(false, "slash")`.
    - `/design foo` shows the existing invalid-argument hint and does not change state.
  - **Shortcut sheet:** it lists ⌘⇧L as "Toggle design mode" only when `designMode` is on.
  - **Command palette:** "Toggle design mode" runs the same action.
- [ ] **Step 2: Run the tests and confirm they fail.**
  - Run: `npx tsx --test renderer/components/chat-top-bar-design.test.tsx renderer/components/composer-slash-palette.test.tsx renderer/lib/shortcut-sheet.test.ts renderer/lib/command-system-core.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement it** with `define({...})`. Add the gate in `slash-command-actions.ts` next to the `/visualize` composer-instruction case, but as an immediate action rather than an instruction.
- [ ] **Step 4: Run the tests again.** Expected: PASS.
- [ ] **Step 5: Commit** with the message `Add design mode toggle, shortcut and /design`.

### Task 8: End-to-end, registration, docs and screenshots

**Files:**
- Create: `tests/e2e/design-mode.spec.ts`
- Modify: `package.json` (add `"test:design-mode": "tsx --test renderer/lib/design-mode.test.ts renderer/components/environment-panel-design.test.tsx renderer/components/chat-top-bar-design.test.tsx main/windows/design-window-core.test.ts"` and append `&& npm run test:design-mode` to `test:serial`), `scripts/ci-test-registry.json`, `docs/plans/README.md`, `docs/settings-design-system.md` (only if a setting is added; none is expected), `.memory/design-mode.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the E2E spec.** It launches with `AIDEN_EXPERIMENTAL_DESIGN_MODE=1` and a fixture workspace at a 1440 × 900 window.
  - `/design` in a workspace chat gives a chat column 420 ± 2 px wide, a canvas region at least 980 px wide, and a sidebar that lists only that workspace's chats under "‹ All projects".
  - Reloading the window keeps design mode on.
  - Opening a chat in another workspace shows the normal layout. Coming back shows design mode again.
  - ⌘⇧L leaves design mode. The panel and sidebar return to their state before entry.
  - Resizing the window to 1000 px while in design mode collapses the sidebar. Resizing to 800 px then entering widens the window to at least 1024 px.
  - Pressing Escape in design mode keeps it on.
- [ ] **Step 2: Run it.**
  - Run: `npm run test:e2e:space -- tests/e2e/design-mode.spec.ts`
  - Expected: PASS. If the window-widening step fails, it fails here and not in CI first.
- [ ] **Step 3: Register the tests.** Register the new files and the E2E spec, then run `npm run test:ci-policy`. Expected: PASS.
- [ ] **Step 4: Run the suites.**
  - Run: `npm run type-check && npm run lint && npm run test`
  - Expected: PASS.
- [ ] **Step 5: Update the docs.**
  - Update the Design mode status row in `docs/plans/README.md` to "P1 in review".
  - Write `.memory/design-mode.md` with the module map and the decisions from the spec.
- [ ] **Step 6: Take screenshots** of the light and dark themes at 1440 and 1000 px, plus the banner at 800 px, and send them to the owner before asking for review.
- [ ] **Step 7: Commit** with the message `Cover design mode end to end`.
