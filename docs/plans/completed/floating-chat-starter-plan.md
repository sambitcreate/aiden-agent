# Floating Chat Starter, Mini-Modal & Attachable Ephemeral Chats

Status: Implemented across all five phases on `floating_chat_starter_hotkey` (2026-11-21).
Baseline: `origin/main` (`6e7dfe2b8`).

## Summary

Add a system-wide **Floating Chat Starter** invocable from anywhere while Aiden is open via a global hotkey (`⌘⇧Space` on macOS / `Ctrl+Shift+Space` on Linux, configurable in **Settings → Keyboard shortcuts**). Sending a prompt morphs the starter bar smoothly into a compact **Floating Mini-Modal** that streams replies, renders tool approvals and questions, and can **Expand** seamlessly into Aiden's full main window (even mid-stream, mid-approval, or when the main window is closed on macOS). Floating chats default to **Temporary** (ephemeral, isolated in `<userData>/chat-folders/<slug>`, hidden from sidebar/Inbox/Memory/Remote until saved or attached) and any `No workspace` or Temporary chat can be **attached in-place to a real project workspace** later.

> Owner review update (2026-11-21): **Share screen removed** — the floating composer includes `+` file/image attach, clipboard paste, drag-and-drop, inline workspace/temporary selector, model picker, voice mic, send, and expand.

---

## Locked-In Product Defaults

| Decision | Selected Default | Notes |
| --- | --- | --- |
| **Global hotkey** | `⌘⇧Space` (macOS) / `Ctrl+Shift+Space` (Linux) | Conflict-free everywhere; configurable in Settings → Keyboard shortcuts |
| **Default persistence** | **Temporary (True Ephemeral)** | Hidden from sidebar/Inbox/Memory/Remote & swept on Discard / New quick chat / startup; 1-click **Save** (to Chats) or **Attach to workspace…** |
| **Starter mode control** | **Inline chip** inside starter bar | Switches between `Temporary`, `No workspace`, or any workspace; no extra floating pill below |
| **State 2 click-outside (blur)** | **Stay pinned** | State 1 hides on click-outside; State 2 stays visible until `Esc`, `×`, or hotkey (configurable in Settings) |
| **Ephemeral tool access** | **Private folder (`permission: "ask"`)** | Strictly jailed to `<userData>/chat-folders/<slug>` under global approval mode |
| **Screen capture** | **Not included** | `+` file/image attach, `⌘V` clipboard paste, drag-and-drop, and voice mic only |

---

## Architecture

### 1. Floating `BrowserWindow`, macOS Panel & Global Hotkey
- **Window module** (`main/windows/quick-chat-window.ts`, `quick-chat-window-core.ts`, `quick-chat-window-security.ts`): mirrors `main/windows/pill-window.ts`.
  - macOS: `type: "panel"`, `frame: false`, `transparent: true`, `hasShadow: false` (CSS `--elevation-modal` inside `24px` shadow margin), `focusable: true`, `skipTaskbar: true`, `hiddenInMissionControl: true`, `fullscreenable: false`, `backgroundThrottling: false`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`, `setAlwaysOnTop(true, "floating")`.
  - Linux: frameless always-on-top window; skip `setBounds` positioning on Wayland (`canPositionFloatingWindow()`).
  - Pre-warmed hidden after startup gated by `isQuickChatShortcutActive()` so development-profile E2E never spawns an unexpected window before `firstAidenWindow`.
  - Marked auxiliary (`markAuxiliaryWindow(window)`) and destroyed in both `shouldReleaseAuxiliaryWindows` and `cleanupApplication()`.
- **Dedicated surface & least-privilege preload**: `quick-chat.html` + `renderer/preload-quick-chat.ts` -> `build/preload/preload-quick-chat.cjs` + `renderer/quick-chat-preload-channels.ts`, verified by `verify-renderer-csp.mjs` and `ipc-contract.test.ts` with zero impact on `MAIN_WINDOW_INITIAL_JS_BUDGET`.
- **Global shortcut**: `"quickChat.toggle"` in `renderer/shared/keybindings.ts` (`COMMANDS` + `INTRODUCED_DEFAULT_COMMANDS`) wired through `main/services/shortcut.ts`.

### 2. Ephemeral Chats & In-Place Attach to Workspace
- Reuses `ChatDraft` + `Workspace.noWorkspace: true` (`<userData>/chat-folders/<slug>` via `reserveNoWorkspaceChat`).
- **Temporary (ephemeral) chats**: Real `chatId` in `chatStore` carrying `ephemeral: true` (checked in `renderer/shared/chat-visibility.ts` so they are excluded from `listRegular()`, sidebar, search, Inbox, Memory, and all Remote endpoints, while `chatStore.list()` stays unfiltered for startup GC). Auto-swept on startup if left unsaved across restarts, and deleted with their hidden workspace on explicit Discard or New quick chat (while `×` / `Esc` hide the floating window without losing the active chat).
- **In-place attach (`chats:inspectAttachFiles`, `chats:attachToWorkspace`)**:
  - Works on any `noWorkspace` or ephemeral chat from both the Floating Mini-Modal and Main Window's `WorkspaceChip` top bar.
  - Concurrency fences: `llmClient.beginChatWorkspaceChange(chatId)`, `followThrough.beginMove(chatId)`, dual `workspaceMutationGate.admit(oldId, targetId)`, plus `!workspaceFolderMissing(W)` & `assertManagedWorktreeAdmission(W)`.
  - Scratch folder preflight: silent `rmdir` if empty; explicit Trash vs collision-safe, symlink/config-guarded Copy if non-empty.
  - Atomic store commit (`chatStore.attachChatToWorkspace`): sets `workspaceId = W.id`, clears `ephemeral`, bumps `summaryRevision`.
  - Pi v4 journal boundary: desktop Pi journals store `header.cwd = <userData>/pi-compaction-sessions` (not the workspace folder), so no header rewrite is needed; appends an idempotent `aiden.workspace-attached.v1` custom entry so the model knows its folder changed.
  - Cache & grant reset: `forgetChatContextProfile`, `resetChatWorkspaceSession` (ending the workspace chat session and forgetting ACP scratch state), `designGrants.revokeChat`, `recentWrittenPages.forget`, `memoryStore.deleteSourceChat`, `releaseNoWorkspaceAfterChat`.
  - Zero Remote protocol revision bump required (iOS & Android already handle `noWorkspace` from rev 51 and dynamic `workspaceId` changes from rev 53).

### 3. Live Cross-Window Stream & Approval Handoff
- Add desktop live stream accumulator + `llmClient.transferGenerationOwner(streamId, newOwner)` + `rebindStreamOwner` in `ToolApprovalCoordinator` and `AskUserQuestionCoordinator`.
- Main-process one-shot handoff ticket store (`quickChat:expandToMain` -> `chat:claimHandoff`) handles both State 1 drafts (text + attachments + model + workspace, avoiding packaged `file://` `localStorage` partitions) and State 2 live/idle chats (flushing coalesced deltas, rebinding pending approvals/questionnaires without `detachRenderer`, transferring `ChatMessageQueue`, and recreating `mainWindow` if closed on macOS).

### 4. UI, Design System, Settings, Onboarding, Analytics & Docs
- Obeys `GUI.md`, `docs/design-guide.md`, `docs/settings-design-system.md`, and `scripts/check-aiden-rules.mjs` (`text-input-focus-ring`, `literal-motion`, `no-brain-icon`, `no-dialog-dom-sniff`).
- Reuses `MessageList` (`compact` prop), `ChatApprovalCard`, `AskUserQuestionComposer`, `ScrollArea`, `ModelPicker` (`onOpenSettings` prop), `WorkspacePicker` (`useOptionalShortcutLabel`), `useVoiceRecorder`, `layer-stack`, `dismiss-key`, `focus-return`, and `startSecondaryWindowAppearanceSync()`.
- 2-phase atomic expand (single `setBounds` + GPU-composited CSS morph over `var(--motion-large-duration)` `var(--motion-large-easing)`).
- Settings preferences + code-drawn onboarding gallery tile (`renderer/components/onboarding-art/`) + privacy-safe analytics events (`floating_chat_opened`, `floating_chat_expanded`, `floating_chat_promoted`) + updated docs.

---

## Phased Rollout

1. **Phase 1 — Ephemeral Chats & In-Place Attach to Workspace**: `ephemeral` chat lifecycle + startup sweep + Remote/Memory exclusion + `chats:inspectAttachFiles` / `chats:attachToWorkspace` + Pi boundary + main-window `WorkspaceChip` Attach UI + tests.
2. **Phase 2 — Desktop Stream Ownership Handoff**: `llmClient.transferGenerationOwner` + approval/questionnaire owner rebind + main handoff ticket + `RootContent` / `ChatPane` live claim + tests.
3. **Phase 3 — Floating `BrowserWindow`, Preload & Global Hotkey**: `quick-chat.html`, `preload-quick-chat.ts`, `quick-chat-window.ts`, `quickChat.toggle` shortcut + Vite/esbuild/CSP/IPC contract + tests.
4. **Phase 4 — Floating Starter + Mini-Modal UI & Voice**: component extractions + `renderer/quick-chat/` (State 1 starter, State 1 ↔ State 2 morph, State 2 mini-modal, voice mic, attach popover, expand) + component tests + Playwright Electron E2E (`tests/e2e/floating-chat.spec.ts` in Cua Space).
5. **Phase 5 — Settings, Onboarding, Analytics, Docs, Screenshots & CI**: Settings controls, onboarding art tile, analytics events, docs updates, CI test registry, real UI screenshots, PR creation & green CI verification.
