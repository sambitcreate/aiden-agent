# Aiden Agent — Renderer UI Architecture Map (GPUI Port Research)

Scope: `renderer/` (~225 TS/TSX files, ~50.5k LOC total incl. tests; ~24.4k LOC of non-test `.tsx` components). Research-only; this document is the source of truth for the GPUI + Rust port.

Codebase shape at a glance:

```
renderer/
├── main/               # Main-window entry (React root, router, route views)
├── pill/               # Dictation-pill window entry (separate React root)
├── components/         # 71 UI modules: ui.tsx design system + feature components
│   ├── assistant/      # Aiden dock (floating assistant panel)
│   ├── settings/       # 20 settings sections + editors
│   └── usage/          # Profile/usage visualizations
├── lib/                # 60+ non-component modules: IPC client, React Query, contexts, pure state machines
├── shared/             # Process-agnostic contract modules (types + parsers + pure logic)
├── preload.ts          # Main-window contextBridge
├── preload-pill.ts     # Pill-window contextBridge
├── preload-channels.ts # IPC allowlists (shared preload/test)
├── pill-preload-channels.ts
└── styles.css          # Tailwind v4 + full design-token system (1,672 lines)
```

Key dependencies (package.json): React 19, @tanstack/react-router 1.131, @tanstack/react-query 5.87, radix-ui 1.4 (all primitives in one package), cmdk 1.1, sonner 2, tailwindcss 4.2, react-markdown 9 + remark-gfm + remark-math + rehype-katex + katex, highlight.js 11, @xterm/xterm 6 + addon-fit, thinking-orbs 0.1, lucide-react 0.542. Build: Vite 8 + @vitejs/plugin-react + babel-plugin-react-compiler.

---

## 1. Entry points

Two Electron windows, two HTML shells, two React roots, two preloads.

### Main window — `main-window.html` → `renderer/main/index.tsx`

- `main-window.html:15` loads `./renderer/main/index.tsx`; CSP locks scripts to self/localhost.
- `renderer/main/index.tsx` boot sequence:
  1. `applyCachedAppearance()` (`renderer/lib/appearance-runtime.ts`) — applies localStorage-cached theme to `<html>` before first paint.
  2. `migrateGoogleProviderPreferences(localStorage)` — legacy provider-id migration.
  3. `subscribeCodexProviderState(queryClient)` — long-lived IPC subscription → React Query cache reconciliation.
  4. Async `bootstrap()`: `appApi.getInfo()` → `AppCapabilitiesProvider` (feature gates, fail-closed); `providersApi.list()` → pre-seed `queryKeys.providers` + alias migration.
  5. Renders `<QueryClientProvider><AppCapabilitiesProvider><TooltipProvider><RouterProvider/>` + `<Toaster/>`.
- HMR via `import.meta.hot`; `__APP_DISPLAY_NAME__` injected by Vite define.

### Router — `renderer/main/router.tsx` (112 LOC)

TanStack Router with **memory history** (no URL bar in Electron):

```
rootRoute (RootView, errorComponent=ErrorBoundaryView)
├── chatLayoutRoute (ChatLayout — persistent sidebar shell)
│   ├── /                 → ChatIndex (redirect: most-recent chat or create one)
│   ├── /chat/$chatId     → ChatPane   (no remount key; ChatPane self-resets)
│   ├── /profile          → ProfileView
│   └── /scheduled        → ScheduledTasksView
└── /settings?section=…   → SettingsView (outside chat shell; validateSearch=parseSettingsSearch)
```

- Router context carries `queryClient`; `staticData.title` per route.
- Single `QueryClient` created alongside router (`router.tsx:90`), exported for the bootstrap.

### Pill window — `pill.html` → `renderer/pill/main.tsx` → `pill-app.tsx`

- `renderer/pill/main.tsx` (20 LOC): adds `aiden-pill-window` class (transparent window CSS), applies cached appearance, renders `<PillApp/>`. No router, no React Query.
- `renderer/pill/pill-app.tsx` (277 LOC): the global-dictation floating pill. Phases `idle | recording | transcribing | pasted | copied | error`. Uses `MediaRecorder` + `AudioContext` analyser driving 9 waveform bars via rAF; `DictationOperationGate` (`lib/dictation-operation-gate.ts`) serializes start/stop races; subscribes `dictation:state` notifications; reports via `dictationApi.reportResult/reportError/cancel/ready`; transcription through shared `voice-recorder-core` (cloud or local sherpa-onnx via main).

### Preloads

- `renderer/preload.ts` (76 LOC): exposes `window.aidenAPI` = `{ ipc: {invoke, onNotification}, dialog.showOpenDialog, nativeTheme.{getInfo,setThemeSource,onChanged}, systemPreferences.{getMediaAccessStatus,askForMediaAccess}, accessibility.{isTrusted,request} }`. Every invoke channel validated against `INVOKE_PREFIXES`; every subscription against `NOTIFICATION_CHANNELS`.
- `renderer/preload-pill.ts` (37 LOC): minimal bridge — invoke + onNotification + mic media access only, gated by `pill-preload-channels.ts` (8 invoke channels, 2 notification channels).

---

## 2. App shell & routing

### RootView — `renderer/main/root-view.tsx` (258 LOC)

Provider nesting: `WorkspaceProvider → WorkspaceTerminalProvider → EnvironmentPanelProvider → CommandSystemProvider(applicationModal=compactModalOpen) → RootContent`.

RootContent responsibilities:
- Registers command handlers: `terminal.toggle`, `environment.toggle`, `settings.open`, `chat.new` (all with busy-state guards via `navigationBlockedReason`).
- Close-guard sync → `appApi.setCloseGuard({dirty, gitBusy, path, saving})` + `beforeunload` guard (`lib/lifecycle-guard.ts`).
- Chat-cache reconciliation subscriptions: `subscribeDetachedTerminalChats`, `subscribeChatReadReconciliations`, `subscribeChatSettlements` (`lib/chat-terminal-sync.ts`, 421 LOC) — keeps React Query chat cache authoritative after detached generations settle.
- External config change (`app:config-externally-changed`) → invalidate providers/mcp/skills; `app:navigate` → route push; `schedule:updated` → invalidate schedule queries.
- Window focus class (`window-blurred`) toggling.
- Renders: `<Outlet/>`, `<OnboardingFlow/>`, `<AssistantDock/>`, `<AppCommandPalette/>` — these three overlay everything, window-anchored.

### ChatLayout — `renderer/main/chat-layout.tsx` (116 LOC)

- `SplitView` (storageKey `aiden-agent`, sidebar 272/236/340px) with `ChatSidebar` + `EnvironmentWorkbench` wrapping `Outlet` + `TerminalDrawer` (hidden on /profile and /scheduled).
- Subscribes `chats:metadata-updated` → patches chat + chats queries, drives title-reveal animation event.

### ChatPane — `renderer/main/chat-pane.tsx` (1,309 LOC — the app's core screen)

Layout: `ScrollArea` (title bar actions: OpenInEditorPicker, EnvironmentPanelToggle, terminal toggle) + footer (approval card stack + `Composer`).

State machine per chat (all local `useState`/`useRef`):
- Streaming: `streamingText`, `streamingReasoning`, `streamComplete`, delta refs + rAF-batched flush (`scheduleStreamFlush`), `generationTimeline`, `liveSubagents`, `approvals[]`, `error`.
- Lifecycle: `generationRef` (`GenerationHandle`), `generationIntentRef` (invalidates stale callbacks), `useLayoutEffect` reset on chatId change, cancel-on-unmount with `rememberDetachedLifecycleStream` handoff.
- `startGeneration(...)` (`lib/ipc.ts:584`) subscribes to 9 notification channels filtered by `streamId` before invoking `chat:start`.
- Approval queue: first-pending card with focus management; routes to `SubagentWorkspaceWriteApproval` / `SubagentMcpMutationApproval` / `SubagentShellApproval` or generic summary; `chatsApi.approve(approvalId, decision)`.
- Thinking-level wiring: Google/Codex/Anthropic per-model levels from `settings.data.*ThinkingByModel` + `modelMetadata.thinkingLevels` → `ThinkingControl`.
- Readiness composition: model readiness + Computer Use readiness + chat-load/drain states → single `readinessMessage`.

### SettingsView — `renderer/main/settings-view.tsx` (197 LOC)

SplitView: left nav (search filter, two groups `Agent`/`App`, 12 destinations from `lib/settings-section.ts`) + content column (`max-w-2xl`). Section map:

| Section | Component | Section | Component |
|---|---|---|---|
| providers | ProvidersSettings | assistant | AssistantSettings |
| modelData | ModelDataSettings | computerUse | ComputerUseSettings |
| skills | SkillsSettings | voice | VoiceSettings |
| mcp | McpSettings | shortcut | ShortcutSettings |
| websearch | WebSearchSettings | appearance | AppearanceSettings |
| scheduledTasks | ScheduledTasksSettings | about | AboutSettings |

### ProfileView — `renderer/main/profile-view.tsx` (397 LOC)

Local profile identity editor + usage dashboard: `ActivityHeatmap`, 4 summary metrics, `TokenMix`, `ModelScoreboard`, range `Select` (7d–all), share dialog rendering `ProfileShareCard` (SVG → PNG via `profileShareSvgToPng`, shared through `profileApi.shareImage`).

---

## 3. Component inventory

`renderer/components/` — 71 non-test modules. Grouped by feature area with rough LOC.

### 3.1 Design system (`ui.tsx`, 984 LOC)

Radix-primitive wrappers with Aiden tokens: `Button` (8 variants × 3 sizes), `Input`, `Textarea`, `Text`, `Badge`, `Callout`, `EmptyState`, `Status`, `Separator`, `Label`, `Field/FieldSet/FieldGroup/FieldContent/FieldLabel`, **`SplitView`** (resizable sidebar w/ persistence + `SidebarToggle`), `Sidebar` + `SidebarFooter/List/ListGroup/ListItem`, **`ScrollArea`** (title bar + actions + footer + auto-scroll-to-bottom + scroll-to-bottom button), **`Dialog`**, **`AlertDialog`**, DropdownMenu family (+CheckboxItem), `CustomDropdownMenu`, `Popover`, `HoverCard`, ContextMenu family, `Select` family, `Switch`, `RadioGroup`, `Command` family (cmdk), `ErrorBoundary`/`ErrorBoundaryView`, `Toaster`/`toast` (sonner), `TooltipProvider`.

### 3.2 Chat transcript & streaming

| Component | LOC | Purpose |
|---|---|---|
| `message-list.tsx` | 240 | Transcript: persisted messages + streaming reply; subagent-chip focus handoff; agent-activity transition layer |
| `message-bubble.tsx` | 126 | User bubble vs assistant markdown; `SafeMessageBubble` error boundary; attachments (base64 images, file chips) |
| `markdown.tsx` | 85 | react-markdown + GFM + KaTeX; `Markdown`, `MarkdownInline`, `MARKDOWN_CLASSNAME` token styling |
| `streaming-markdown-reveal.tsx` | 137 | Progressive per-unit reveal of streaming markdown; rAF schedule; handoff completion callback |
| `code-block.tsx` | 53 | highlight.js memoized highlight + language label + copy |
| `reasoning-block.tsx` | 97 | Collapsible chain-of-thought block, streaming/active states |
| `activity-feed.tsx` | 187 | Live tool-step ticker (3-row rise/fade) collapsing to summary |
| `event-presence.tsx` | 50 | Enter/exit animation wrapper (180ms exit) used for approvals/errors |
| `copy-button.tsx` | 54 | Copy with transient checkmark |
| `aiden-orb.tsx` | 63 | Wraps `thinking-orbs` `ThinkingOrb`; appearance/reduce-motion aware |

### 3.3 Composer & pickers

| Component | LOC | Purpose |
|---|---|---|
| `composer.tsx` | 731 | Message input: attachments, voice record, permission menu, workspace/git pickers, computer-use toggle, model picker + thinking control slots, send/stop |
| `model-picker.tsx` | 693 | Searchable provider/model list + spatial pad; cmdk-based; capability metadata detail surface |
| `model-picker-pad.tsx` | 298 | 2D directional spatial model pad (arrow-key navigation across model points) |
| `workspace-picker.tsx` | 121 | New-chat workspace switch (cmdk list) |
| `git-branch-picker.tsx` | 380 | Branch switch/create + managed worktree creation from composer |
| `open-in-editor-picker.tsx` | 207 | Reveal folder / open in detected external editors |
| `thinking-control.tsx` | 101 | Segmented thinking-level control (Off/Low/Med/High/XHigh/Max) |
| `provider-icon.tsx` | 140 | SVG provider logomarks from `assets/provider-logos/` |

### 3.4 Sidebar & navigation

| Component | LOC | Purpose |
|---|---|---|
| `chat-sidebar.tsx` | 962 | Workspace switcher, chat history (route-driven selection, rename/delete via context menu), chat-number shortcuts, update-ready banner, settings/profile footer |
| `command-palette.tsx` | 693 | Multi-mode cmdk palette: root commands, chats, models, providers, settings; appearance intents; recent-command persistence |

### 3.5 Environment panel (right-hand workbench)

| Component | LOC | Purpose |
|---|---|---|
| `environment-panel.tsx` | 1,325 | Provider + orchestrator: tabs (overview/files/review/subagents), compact-modal mode, panel sizing, subagent run-view state, live announcer wiring |
| `environment-overview.tsx` | 360 | Overview tab: git summary cards, commit/push/compare entry points |
| `files-panel.tsx` | 845 | File tree + viewer/editor: dirty tracking, version-checked saves, search, wrap toggle |
| `review-panel.tsx` | 778 | Git changes + branch comparison: file list, diff viewer, commit/push dialogs entry |
| `git-commit-dialog.tsx` | 265 | Commit flow (staged/all modes, message, result) |
| `git-push-dialog.tsx` | 273 | Push flow (capability check, remote/branch) |

### 3.6 Subagents

| Component | LOC | Purpose |
|---|---|---|
| `subagents-panel.tsx` | 488 | Run roster + detail host; selection repair; pending-detail placeholder |
| `subagent-detail.tsx` | 428 | Single run view: milestones, effects, latest text, stop/steer controls, jump-to-latest |
| `subagent-roster.tsx` | 265 | Tree of runs grouped/expanded via `subagent-tree` |
| `subagent-chips.tsx` | 157 | Transcript-embedded run chips (orb + progress label) + `SubagentOrb` |
| `subagent-shell-approval.tsx` | 52 | Approval body: full-host command details |
| `subagent-mcp-mutation-approval.tsx` | 106 | Approval body: MCP mutation w/ classification labels |
| `subagent-workspace-write-approval.tsx` | 71 | Approval body: exact file write operation |
| `subagent-live-announcer.tsx` | 76 | aria-live announcements of run transitions (portal) |
| `subagent-owner-focus-boundary.tsx` | 119 | Focus restoration hooks for run selection |

### 3.7 Assistant dock (Aiden companion)

| Component | LOC | Purpose |
|---|---|---|
| `assistant/assistant-dock.tsx` | 145 | Window-anchored dock: bubble ↔ panel handoff, unread badge, 8s reply preview |
| `assistant/assistant-panel.tsx` | 190 | Expanded panel: header, suggested prompts, recent threads, composer, approval slot |
| `assistant/assistant-thread.tsx` | 68 | Thread view (markdown messages + streaming) |
| `assistant/assistant-bubble.tsx` | 53 | Collapsed circular mark + preview card |
| `assistant/assistant-recent.tsx` | 33 | Recent-thread list |
| `assistant/assistant-automation-approval.tsx` | 182 | Approval card for schedule_task/edit_automation |
| `assistant/use-assistant-chat.ts` | 682 | Hook: threads in reserved `assistant` workspace, streaming lifecycle, approvals, readiness states |

### 3.8 Settings (`settings/`)

| Component | LOC | Purpose |
|---|---|---|
| `appearance-settings.tsx` | 798 | Theme presets/custom variants, accent/bg/fg pickers, fonts, sizes, contrast, motion, dock icon, preview-before-save |
| `codex-provider-settings.tsx` | 639 | ChatGPT OAuth sign-in flow (prompts/events/device code), model list, attention states |
| `providers-settings.tsx` | 498 | Preset + custom provider list; add/edit/remove entry points |
| `provider-editor.tsx` | 418 | Custom provider dialog: base URL, key, test, discover models, default model |
| `builtin-provider-editor.tsx` | 235 | Pi-owned built-in provider setup view |
| `mcp-settings.tsx` | 460 | MCP server list + editor (stdio/http/sse), test, OAuth, presets |
| `mcp-preset-setup.tsx` | 315 | Preset (Composio/Notion/Linear…) guided setup: key or OAuth |
| `mcp-preset-icons.tsx` | 78 | Vendor logomarks |
| `model-data-settings.tsx` | 413 | Model Pad settings host: Artificial Analysis connect/refresh, rankings data |
| `model-pad-settings.tsx` | 400 | Model Pad editor: arrange/rank models on capability/speed pad |
| `model-manager-view.tsx` | 284 | On-device Parakeet model download/delete/activate |
| `skills-settings.tsx` | 264 | Agent Skills CRUD + discovered skills |
| `scheduled-tasks-settings.tsx` | 283 | Global schedule settings + notifications |
| `computer-use-settings.tsx` | 243 | Computer Use enable + accessibility/screen permissions |
| `assistant-settings.tsx` | 116 | Aiden assistant config (model, permission, hotkey) |
| `local-voice-settings.tsx` | 201 | On-device voice engine status + hotkey |
| `voice-settings.tsx` | 82 | Transcription provider selection |
| `shortcut-settings.tsx` | 379 | Keybinding editor with conflict detection |
| `web-search-settings.tsx` | 58 | Exa key + enable |
| `about-settings.tsx` | 68 | Version/links |

### 3.9 Usage (`usage/`)

| Component | LOC | Purpose |
|---|---|---|
| `activity-heatmap.tsx` | 162 | GitHub-style activity calendar (level classes by tokens) |
| `token-mix.tsx` | 88 | Input/output/cache token mix bars |
| `model-scoreboard.tsx` | 145 | Per-model usage table with metric select |
| `profile-share-card.tsx` | 369 | SVG 3:4 share card (dark/accent aware) → PNG |

### 3.10 Scheduled tasks & onboarding

| Component | LOC | Purpose |
|---|---|---|
| `scheduled-tasks-view.tsx` | 562 | Task list (status presentation, pause/resume/run-now), runs, editor host |
| `scheduled-task-editor.tsx` | 448 | Cron/timezone/MCP-script editor w/ preview |
| `onboarding-flow.tsx` | 421 | 3-step first-run modal (profile → provider → bento tour) |

### 3.11 Most complex components (top 25, non-test)

1. `environment-panel.tsx` — 1,325
2. `ui.tsx` — 984
3. `chat-sidebar.tsx` — 962
4. `files-panel.tsx` — 845
5. `settings/appearance-settings.tsx` — 798
6. `review-panel.tsx` — 778
7. `composer.tsx` — 731
8. `model-picker.tsx` — 693
9. `command-palette.tsx` — 693
10. `settings/codex-provider-settings.tsx` — 639
11. `scheduled-tasks-view.tsx` — 562
12. `terminal-drawer.tsx` — 506
13. `settings/providers-settings.tsx` — 498
14. `subagents-panel.tsx` — 488
15. `settings/mcp-settings.tsx` — 460
16. `scheduled-task-editor.tsx` — 448
17. `subagent-detail.tsx` — 428
18. `onboarding-flow.tsx` — 421
19. `settings/provider-editor.tsx` — 418
20. `settings/model-data-settings.tsx` — 413
21. `settings/model-pad-settings.tsx` — 400
22. `git-branch-picker.tsx` — 380
23. `settings/shortcut-settings.tsx` — 379
24. `usage/profile-share-card.tsx` — 369
25. `environment-overview.tsx` — 360

(Honorable mentions outside `components/`: `main/chat-pane.tsx` 1,309; `assistant/use-assistant-chat.ts` 682; `pill/pill-app.tsx` 277.)

---

## 4. State management

### Layers

1. **React Query (server/main-process cache)** — single `QueryClient`. All main-process data flows through `lib/queries.ts` hooks (36 hooks). Query keys centralized in `queryKeys` (providers, chats, chat(id), settings, shortcuts, assistantConfig, scheduledTasks/Runs/Settings, computerUseStatus, artificialAnalysis(+ModelInfo), codexProviderStatus, profile, usage(range), foundationModelsConnection, skills, mcpServers/Presets, exa, engineStatus, localModels, workspaces, git×7, discoveredSkills, modelInfo). Mutations invalidate or `setQueryData` directly. External invalidation arrives via IPC notifications (see RootView) — **this is the renderer↔main mirror mechanism**.
2. **React contexts (renderer-local shared state)**:
   - `WorkspaceProvider` (`lib/workspace-context.tsx`) — active workspace id, localStorage-persisted.
   - `WorkspaceTerminalProvider` (`components/terminal-drawer.tsx`) — terminal drawer open/sessions/layout.
   - `EnvironmentPanelProvider` (`components/environment-panel.tsx`) — panel open/tab/compact modal, editor dirty/saving, git busy, subagent run views, cancel-agent handler.
   - `CommandSystemProvider` (`lib/command-system.tsx`) — command registry, palette open/mode, effective bindings.
   - `AppCapabilitiesProvider` (`lib/app-capabilities.tsx`) — boot-time feature gates + refresh.
   - `TooltipProvider` (radix).
3. **Module-level singletons / external stores**: appearance intent revision (`appearance-runtime.ts`), model selection (`use-model-selection.ts` w/ subscribe), chat-deletion cache, chat-terminal-sync registries, streaming-reveal schedules, `DictationOperationGate`.
4. **Local component state**: everything transient — streaming buffers (refs + rAF), dialogs, drafts, pickers. ChatPane/Composer keyed resets per chatId.

### Renderer-local vs main-mirrored

| Main-mirrored (React Query + notifications) | Renderer-local |
|---|---|
| providers, settings, appearance (persisted via `settings:setAppearance`/preview), shortcuts, chats + chat transcripts, workspaces, git info/review/comparison/branches/worktrees, scheduled tasks/runs, assistant config, profile, usage, skills, MCP servers/presets, exa config, computer-use status, engine/local voice models, codex auth status, AA status | active workspace id, terminal drawer, environment panel, command palette, streaming buffers/timelines/live subagents, onboarding completion, composer drafts, picker state, dialog open states, model selection (localStorage + subscribers), UI layout sizes (localStorage) |

### Custom hooks inventory

- `lib/queries.ts` (React Query): `useProviders`, `useCodexProviderStatus`, `useChats`, `useWorkspaces`, `useModelInfo`, `useProvidersModelInfo`, `useGitInfo`, `useGitReview`, `useGitPushCapability`, `useGitComparison`, `useGitWorktrees`, `useGitBranches`, `useDiscoveredSkills`, `useChat`, `useSettings`, `useShortcuts`, `useAssistantConfig`, `useScheduledTasks`, `useScheduledRuns`, `useScheduledTaskSettings`, `useArtificialAnalysisStatus`, `useComputerUseStatus`, `useProfile`, `useUsageSummary`, `useFoundationModelsConnection`, `useSkills`, `useMcpServers`, `useMcpPresets`, `useExaConfig`, `useEngineStatus`, `useLocalModels`, `useSaveProvider`, `useRemoveProvider`, `useSetProviderKey`.
- `lib/`: `useModelSelection`, `useTheme`, `useVoiceRecorder`, `useAppCapabilities`, `useComputerUseNoticeDismissed`, `useModelPadLayout`, `useActiveWorkspace`.
- `lib/command-system.tsx`: `useCommandSystem`, `useCommandHandler`, `useShortcutLabel`, `useShortcutBinding`.
- `components/`: `useEnvironmentPanel`, `useWorkspaceTerminal`, `useAssistantChat`, `useSubagentSelectionRestoreRunRepair`.

### Notable pure state-machine libs (direct port candidates — no React)

`streaming-reveal.ts` (407 LOC reveal scheduler), `subagent-view-state.ts` (556), `subagent-panel-state.ts` (485), `chat-terminal-sync.ts` (421), `model-picker-data.ts` (364 spatial pad math), `agent-steps.ts`, `agent-activity.ts`, `command-system-core.ts`, `environment-panel-layout/state.ts`, `scheduled-task-view.ts`, `usage-profile-data.ts`, `profile-share-data.ts`, `appearance-runtime.ts` + `shared/appearance.ts`, `codex-auth-session.ts`, `provider-auth-session.ts`, `mcp-preset-state.ts`, `sidebar-chat-shortcuts.ts`, `chat-title-reveal.ts`, `dictation-operation-gate.ts`, `computer-use-control/notice.ts`, `google-provider-migration.ts`, `pi-provider-display.ts`, `model-display.ts`, `truncate-path.ts`, `chat-deletion-cache.ts`, `command-palette-recent.ts`, `subagent-tree.ts`, `subagent-feature-gate.ts`, `lifecycle-guard.ts`, `settings-section.ts`, `editor-preference.ts`, `model-data-control.ts`, `voice-recorder-core.ts`, `accessibility-refresh.ts`, `app-capabilities.tsx`.

---

## 5. IPC client layer

### Bridge contract (`preload.ts` + `preload-channels.ts`)

- **Invoke**: `window.aidenAPI.ipc.invoke(channel, ...args)` — channel must start with one of 26 `INVOKE_PREFIXES` (`app:`, `artificialAnalysis:`, `assistant:`, `attachments:`, `chat:`, `chats:`, `computerUse:`, `devlog:`, `dictation:`, `exa:`, `git:`, `localModels:`, `localVoice:`, `mcp:`, `models:`, `providers:`, `profile:`, `schedule:`, `settings:`, `shortcut:`, `skills:`, `subagents:`, `terminal:`, `titleProviders:`, `usage:`, `voice:`, `workspaces:`).
- **Subscribe**: `onNotification(method, handler)` — 27 allowlisted channels (`chat:delta`, `chat:reasoning-delta`, `chat:status`, `chat:done`, `chat:error`, `chat:timeline`, `chat:subagents`, `chat:tool`, `chat:approval`, `chats:metadata-updated`, `chats:settled`, `app:navigate`, `app:command`, `app:update-state`, `app:config-externally-changed`, `dictation:state`, `localModels:progress`, `providers:auth:*` ×5, `schedule:updated`, `settings:appearance-changed`, `shortcut:changed`, `terminal:data`, `terminal:exit`, `aiden:theme:changed`).
- **Native helpers**: `dialog.showOpenDialog`, `nativeTheme.*`, `systemPreferences.*` (mic/camera/screen), `accessibility.*` under `aiden:*` channels.

### Typed API surface — `renderer/lib/ipc.ts` (690 LOC)

Domain API objects (each a thin typed wrapper): `appApi`, `appUpdatesApi`, `providersApi` (incl. OAuth auth flow events), `settingsApi` (incl. appearance get/preview/set + thinking levels), `assistantApi`, `artificialAnalysisApi`, `computerUseApi`, `titleProvidersApi`, `usageApi`, `scheduleApi`, `profileApi`, `skillsApi`, `mcpApi`, `devlogApi`, `exaApi`, `voiceApi`, `localVoiceApi`, `shortcutApi`, `dictationApi`, `pickFolder/pickFiles`, `attachmentsApi`, `modelsApi`, `workspacesApi` (files read/write w/ expectedVersion), `terminalApi` (create/snapshot/write/resize/close), `gitApi` (review/diff/commit/push/compare/branches/worktrees), `chatsApi` (CRUD + appendMessage + approve + waitUntilIdle + abandonTurn), `subagentsApi` (get/manage: status/wait/stop/retry/steer).

**`startGeneration(params, callbacks, messageTurnId)`** — the streaming primitive: subscribes 9 channels filtered by client-generated `streamId`, invokes `chat:start`, returns `GenerationHandle{streamId, cancel(origin)}`. Callbacks: `onDelta`, `onReasoningDelta`, `onStatus(model_loading|model_ready)`, `onTimeline`, `onSubagents`, `onTool`, `onApproval`, `onDone(full, timeline, chat, reasoning)`, `onError(message, partial, timeline, chat, reasoning)`. Lifecycle cancel → `rememberDetachedLifecycleStream` so generation continues detached and re-settles into cache later.

Payloads are validated at the boundary with parsers from `shared/` (`parseChatReadResponse`, `parseSubagentRunSnapshot`, `parseSubagentManagementResultV2`, `parseAppUpdateSnapshot`, `parseSubagentHistoryDetailV1`) — **parse-don't-trust at the IPC edge**, a pattern worth keeping in Rust (serde + validators).

### Pill IPC (`preload-pill.ts` + `pill-preload-channels.ts`)

Invoke: `dictation:cancel/error/ready/result`, `settings:get`, `settings:getAppearance`, `voice:transcribe`, `voice:transcribeLocal`. Notifications: `dictation:state`, `settings:appearance-changed`.

---

## 6. `renderer/shared/` — contract modules (the port's type definitions)

Dependency-free (no Electron/React) modules shared by main, renderer, and node:test. These map almost 1:1 to Rust structs/enums with serde + validation.

| Module | LOC | Contents |
|---|---|---|
| `appearance.ts` | 843 | `AppearanceConfig` (mode + light/dark `ThemeVariantConfig`: preset/accent/bg/fg/fonts/sizes/contrast/translucency), 4 presets (aiden/slate/berry/moss), normalize/parse/serialize, `resolveThemeTokens` → token map, contrast-ratio safety checks |
| `keybindings.ts` | 926 | `COMMAND_IDS` (all commands incl. composer.focus, dictation.toggle, assistant.open, palette, chat navigation/jump, terminal/environment, settings), categories, default bindings, accelerator normalization/conflict rules, `KeybindingSnapshot/Mutation`, `ariaKeyShortcut`, `prettyAccelerator` |
| `subagent-runs.ts` | 850 | `SubagentRunSnapshotV1/V2` (+states, milestones, effects, limits), `SubagentMessageReferenceV1`, `SubagentHistoryDetailV1`, parsers, effect-activity contracts |
| `subagent-safe-text.ts` | 1,276 | Sanitization of model-produced text for safe UI rendering (privacy, identifier redaction) |
| `subagent-management-v2.ts` | 87 | manage request/result unions (status/wait/stop/retry/steer) + parser |
| `assistant.ts` | 563 | Reserved `ASSISTANT_WORKSPACE_ID`, automation tool names/limits, suggested prompts, approval-details unions + type guards (`isSubagentShellApprovalDetails` etc.) |
| `generation-timeline.ts` | 293 | `GenerationTimeline` v2: `AgentToolStep`/`AgentThinkingStep`, statuses, claim-check, replay versions, `latestActiveAgentStep` |
| `claim-check.ts` | 174 | Success-claim verification over timelines |
| `generation-thinking.ts` | 21 | Unified thinking levels (off/low/medium/high/xhigh/max) |
| `google-thinking.ts` / `anthropic-thinking.ts` / `codex-thinking.ts` | 83/85/79 | Per-provider level sets, defaults, per-model preference normalization |
| `google-provider.ts` | 33 | Provider-id constants + legacy Pi id migration |
| `provider-deployment.ts` | 42 | local/hosted deployment inference (loopback detection) |
| `app-update.ts` | 50 | `AppUpdateSnapshot` (idle/ready) + restart result + parser |
| `dictation.ts` | 25 | `DictationState` payloads for pill |
| `chat-workspace.ts` | 6 | Default workspace id normalization |

Also `renderer/lib/types.ts` (858 LOC) — renderer mirror of backend shapes: `Provider`(+ModelMetadata/Auth), `Workspace`(+Permission/ManagedWorktree), `GitInfo/Branches/Worktree/Review/Commit/Push/Comparison/FileDiff`, `WorkspaceFileIndex/Document`, `ChatMessage/ChatMeta/Chat/ChatReadResponse`, `Attachment`, `ModelInfo`/`ArtificialAnalysisStatus`, `ScheduledTask/Run/Settings`, `McpServer/Preset/Status`, `Skill`, `AppSettings`, `AssistantConfig`, `ComputerUseStatus`, `Profile`, `UsageSummary` family, `LocalVoiceModel`/`EngineStatus`, `ChatStartParams`, `ApprovalRequest/Decision`.

---

## 7. Styling system

### Architecture (`renderer/styles.css`, 1,672 LOC; Tailwind v4)

- **Two-tier tokens**: raw CSS custom properties (`--text-primary`, `--surface-*`, `--border-*`, `--accent*`, `--support-*`, `--elevation-*`, `--syntax-*`, `--terminal-*`, `--font-*`, `--ui-font-size`) on `:root` / `:root.dark`; then `@theme inline` maps them to Tailwind utilities (`--color-primary: var(--text-primary)` etc.). Components only use semantic utilities (`bg-control`, `text-secondary`, `rounded-card`, `shadow-popover`).
- **Type scale derived from `--ui-font-size`** (14px default): heading1 +10, heading2 +4, large-strong +2, regular/strong ±0, small −1, mini −3 — user font-size setting rescales everything.
- **Radii**: control/card 12px, dialog 16, popover 12, pill 9999. **Elevation**: layered 0.5px ring + soft shadows per surface (control/hover/pressed, popover, toast, dialog, modal, composer).
- **Dark mode**: `:root.dark` overrides; `color-scheme` set; applied via `applyAppearanceConfig` from `appearance-runtime.ts` driven by `shared/appearance.ts` presets + native theme signals (`aiden:theme:changed`, matchMedia fallbacks, high-contrast support).
- **Special surfaces**: `.glass-surface` (translucent sidebar/vibrancy), `.drag-region` (window dragging), `.aiden-pill-window` transparency, `.chat-content-column` / `.aiden-dock-inset` (content column insets), `agent-thinking-shimmer` keyframes, streaming-reveal transitions, syntax (`--syntax-*` 6 colors) + terminal palette per scheme, reduced-motion honored via `data-reduce-motion`.
- **Fonts**: system stacks (`--font-ui-family`, `--font-code-family`) with options from `UI_FONT_OPTIONS`/`CODE_FONT_OPTIONS`; font smoothing toggle.

### Theme flow

`settings:getAppearance` → `useTheme()` → `applyAppearanceConfig(config, nativeDark, highContrast)` writes `data-appearance-scheme`, `data-reduce-motion`, all CSS vars; previews via `settings:previewAppearance`; intents serialized by `beginAppearanceIntent/runAppearanceIntent` to avoid Command-K vs Settings races; `APPEARANCE_CHANGE_EVENT` re-renders orb/terminal/pill consumers; pill syncs via `pill-appearance.ts` on `settings:appearance-changed`.

---

## 8. Rendering-heavy features (GPUI replacement needed)

| Feature | Current implementation | Notes for port |
|---|---|---|
| Markdown | react-markdown 9 + remark-gfm + remark-math; `Markdown`, `MarkdownInline`; per-element Tailwind classes | Full rich-text layout engine needed |
| Math (KaTeX) | rehype-katex + katex.min.css | No mature Rust KaTeX equivalent; hardest gap |
| Syntax highlight | highlight.js 11 (`CodeBlock`, memoized HTML) | syntect is the natural Rust equivalent |
| Streaming reveal | `streaming-reveal.ts` scheduler + `StreamingMarkdownReveal` (per-unit fade-in, rAF, reduced-motion, handoff delay) | Pure logic ports directly; animation → GPUI animations |
| Terminal | `@xterm/xterm` 6 + fit addon; `terminal-drawer.tsx` (up to 4 split panes, height persistence, theme from CSS vars); main side uses node-pty | Needs a Rust terminal emulator widget (alacritty_terminal-based custom Element) — Very High |
| Thinking orbs | `thinking-orbs` package (`ThinkingOrb` canvas/SVG animation) via `AidenOrb` wrapper | Custom GPUI canvas/paint element — Medium |
| Activity feed | `activity-feed.tsx` ticker w/ masked rise/fade, collapsible summary | Medium (layout + animation) |
| Agent-activity transition | `message-list.tsx` crossfade layer (180ms exit stack) | Low–Medium |
| Command palette | cmdk 1.1 (fuzzy filter, grouping, recents) | gpui-component Picker/List + custom fuzzy match — Medium |
| Toasts | sonner (`Toaster`, top-center, richColors) | gpui-component notification or custom — Low |
| Virtualization | **None** — transcript and lists render fully; perf managed by memoization + rAF batching | GPUI `uniform_list`/`list` gives this for free where needed |
| xterm CSS/theme | CSS-var-driven theme per scheme | Token mapping straightforward once widget exists |
| SVG share card | `ProfileShareCard` SVG → canvas → PNG dataURL | GPUI SVG/render-to-image or tiny-skia — Medium |
| Waveform (pill) | Web Audio analyser + rAF DOM bars | Custom element + cpal — Medium |
| Provider icons | 30+ SVGs in `assets/provider-logos/` | GPUI SVG rendering — Low |
| Charts (usage) | CSS-grid heatmap, div bars | Custom painted elements — Low/Medium |

Animations are CSS transitions/keyframes throughout (150ms ease-out standard, spring-like 200ms cubic-bezier(0.19,1,0.22,1) entrances, 120–180ms exits), all gated by `data-reduce-motion`.

---

## 9. Onboarding flow — `components/onboarding-flow.tsx` (421 LOC)

- Gate: `shouldShowOnboarding()` — localStorage `aiden:onboarding:v1:complete`; rendered from RootView above everything (fixed inset overlay, backdrop blur).
- Structure: two-pane modal (max-w-5xl, 28px radius). Left aside: brand mark, headline, step progress bars (3). Right: step content + Back/Next/Skip footer.
- Steps (`steps = ["profile","provider","tour"]`):
  1. **profile** — name input (maxLength 80) → `profileApi.setName`, cache seed; privacy callout.
  2. **provider** — 6 choice cards: OpenAI API key, ChatGPT sign-in (starts `providersApi.authStart` OAuth, non-blocking), Anthropic key, LM Studio, Ollama, Tailscale custom URL. `makeOnboardingProvider()` builds `Provider` payloads (`custom:onboarding-*` ids, default base URLs, hosted/local deployment); key-required choices collect `apiKey`; tailscale requires `baseUrl`. Saves via `providersApi.save(provider, key?)` then advances.
  3. **tour** — 6-tile bento grid (hover/focus reveals descriptions; 2 col-span tiles): Local profile, Provider ready, Workspace agents, Private by design, macOS polish, Bento overview. Finish sets the completion flag.
- No network calls beyond explicit user actions (provider save / OAuth start / profile set), per AGENTS.md onboarding policy.
- Tested by `onboarding-flow.test.tsx` (`npm run test:onboarding`).

---

## 10. GPUI porting strategy

Target stack: **gpui** (Zed's Rust UI framework) + **gpui-component** (Button/Input/Select/Dialog/Tabs/Sidebar/List/Table/Switch/Dropdown/Tooltip/Popover/Resizable/Notification). Architectural mapping:

- **Processes** → single Rust app; main-process services stay as Rust backend services; IPC replaced by direct async calls / channels (tokio). Keep the *contract shapes* (section 6) as serde types.
- **React Query** → GPUI `Entity` models per domain (ProvidersEntity, ChatsEntity, SettingsEntity…) with subscription events replacing the 27 notification channels; a small `QueryCache`-like helper for staleTime/refetchInterval semantics (git polling 4–5s).
- **TanStack Router (memory)** → simple `View` enum + navigation stack in a root entity; route table is tiny (5 routes).
- **Contexts** → GPUI global/app context entities passed via `cx`.
- **Tailwind tokens** → `Theme` struct mirroring the two-tier token system; port `--color-*` semantics 1:1; light/dark via `Theme` variants; font-size scaling is trivial in gpui (rem-like base px).
- **localStorage** → platform prefs store (JSON file).

### Area-by-area recommendation

| UI area | GPUI strategy | Effort |
|---|---|---|
| Design system primitives (ui.tsx) | gpui-component Button/Input/Textarea/Select/Switch/Radio/Separator/Tooltip/Badge + thin wrappers for Aiden variants (filled/muted/transparent/glass/toolbar/accent/destructive; small/medium/large) | **Medium** |
| Dialog / AlertDialog / Popover / HoverCard / ContextMenu / Dropdown | gpui-component Dialog + Menu/ContextMenu + Popover; port focus-trap & 120–180ms exit animations | Medium |
| SplitView / Sidebar / ScrollArea | gpui-component Resizable + Sidebar + gpui scroll (`uniform_list` where long); port size persistence + scroll-to-bottom logic | Medium |
| Toasts (sonner) | gpui-component Notification | **Low** |
| App shell, routing, settings nav | Root entity + view enum; settings section map as data; trivial | Low |
| Chat sidebar (history, workspaces, context menus) | gpui-component List + Menu; port title-reveal + shortcut badges | Medium |
| ChatPane streaming orchestration | Entity holding stream state machine; rAF delta batching → gpui `on_next_frame`/timers; direct port of intent/invalidate logic | **High** (logic-dense but mechanical) |
| MessageList / bubbles / approvals | Stacked elements + EventPresence equivalent via gpui animations | Medium |
| **Markdown rendering** | Custom rich-text element over `comrak`/`pulldown-cmark` (GFM tables) + inline styling; `MarkdownInline` variant; untrusted-content error isolation → per-message catch | **Very High** |
| **KaTeX math** | No Rust equivalent at parity. Options: (a) embed a small JS engine (deno_core/boa) running KaTeX→HTML→layout boxes, (b) render math as images via a helper process, (c) degrade to styled source text. Recommend (c) for v1, (b) later | **Very High** |
| **Code highlighting** | syntect + custom code-block element (language label, copy, horizontal scroll) | Medium |
| Streaming markdown reveal | Port `streaming-reveal.ts` 1:1 (pure), drive with gpui animation clock | Medium |
| Reasoning block / activity feed / agent activity | Collapsible section + custom ticker element with rise/fade mask | Medium |
| **Composer** | Custom multiline TextInput (gpui-component Input growing) + attachment chips + menus; voice via cpal; port computer-use/permission rows | High |
| **Model picker + spatial pad** | cmdk → gpui-component Picker/List + custom fuzzy scoring; `model-picker-data.ts` pad math ports directly; pad as custom element | High |
| **Command palette** | gpui-component Picker as base; modes/recents/appearance intents port from `command-system-core.ts` + `command-palette-recent.ts` | Medium |
| **Terminal drawer** | Custom Element on `alacritty_terminal` (or port a minimal VT parser); PTY via `portable-pty`; split panes ≤4; theme from tokens. Biggest single-widget risk | **Very High** |
| **AidenOrb / thinking orbs** | Custom painted element (gpui canvas, Path/circle animations), states map 1:1; honor reduce-motion | Medium |
| Environment panel shell | Resizable right panel + Tabs; compact-modal → centered Dialog variant | Medium |
| Files panel | Tree element (gpui-component Tree/List) + text editor (gpui TextInput multiline or integrate a simple editor); version-checked saves unchanged | High |
| Review/diff panel | Custom diff element (line-based, syntax via syntect, `diffMarkers` preference) | High |
| Subagents (roster/detail/chips/approvals/announcer) | List + custom chip elements; all state machines (`subagent-view-state`, `subagent-panel-state`, `subagent-tree`) are pure and port directly; announcer → accessibility events | High |
| Assistant dock | Window-anchored floating panel: custom positioned element + bubble; port unread/preview/exit-handoff logic | Medium |
| Usage visualizations | Custom painted heatmap/bars/scoreboard (simple rects); share card via tiny-skia render-to-PNG | Medium |
| Settings screens (20) | Form layouts with gpui-component fields; appearance editor needs color pickers (custom) + live preview intent machinery (ports from appearance-runtime) | Medium–High (bulk work, low risk) |
| **Onboarding flow** | Modal overlay + two-pane layout + bento grid; straightforward composition of primitives | Low |
| **Pill window** | Second gpui window (transparent, always-on-top) + custom waveform element (cpal analyser); dictation gate logic ports directly | Medium |
| Keybindings/command system | `shared/keybindings.ts` logic → Rust; gpui `KeyBinding`/`Action` registration; conflict rules port | Medium |
| Accessibility | aria-live announcers, focus traps/handoffs → gpui accessibility APIs (still maturing — budget extra) | High |

### Suggested port order

1. Contracts (`shared/` → Rust serde types + validators) and theme tokens.
2. Primitives wrappers + app shell + settings (bulk, low risk) → forces design-system decisions early.
3. Chat read path (sidebar → transcript with static markdown) — de-risks markdown element.
4. Streaming write path (ChatPane orchestration, reveal, activity) — the core loop.
5. Composer + pickers + command palette.
6. Environment panel (files/review/subagents), assistant dock, onboarding, pill.
7. Terminal (last; highest widget risk), KaTeX (degraded → image pipeline), Computer Use settings surfaces.

### Porting invariants worth preserving

- **Parse-don't-trust at boundaries** (parsers in `shared/`; mirror with serde + `validator`-style guards).
- **Streaming intent invalidation** (`generationIntentRef`) and lifecycle-detached generation handoff (`chat-terminal-sync.ts`).
- **Appearance intent serialization** (single-writer revision counter) and reduced-motion gating everywhere.
- **Focus handoff discipline** (approvals auto-focus + restore; subagent chip focus repair; dock bubble↔panel handoff).
- **Keyed per-chat transient state** (Composer keyed by chatId; ChatPane layout-effect resets).
- **No virtualization assumptions in transcript** — memoized blocks were enough; in gpui prefer `uniform_list` only for the long sidebar/file lists.
