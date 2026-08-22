# Aiden — Proactive In-App Assistant Plan

Status: Phase 1, the enforceable Settings foundation, main-chat Markdown parity, and
approval-gated global/project/MCP automation creation and editing are implemented; settings
tools and proactivity remain planned. Phase 1 was redesigned as an in-window dock (see
"Assistant dock"). The Settings foundation was reconciled with the canonical command system
on 2026-07-26; Markdown/automation access was added on 2026-07-30.
The automation boundary was hardened on 2026-08-04 with fingerprint-bound provider and MCP
connections, exact model pins, monotonic revisions, cancellation compensation, and mutually
exclusive project/MCP scopes for every scheduled task.
Spec date 2026-07-23; implementation plan 2026-07-25; dock revision 2026-07-25;
Settings/shortcut revision 2026-07-26.

**Phases 2 and 3 below still describe the separate-window design in places.** Their
substance — settings tools, the Aiden settings section, and the whole proactive engine —
is unaffected by the dock change, because none of it depended on the window. The specific
deltas are: `assistant:` must be re-added to `INVOKE_PREFIXES` alongside the first config
handler (Task 7), and Phase 3's `assistant:nudge` / `assistant:open-thread` /
`assistant:state-changed` channels must be added to `NOTIFICATION_CHANNEL_VALUES` in the
task that first broadcasts them, not before — the contract test asserts exact set equality,
and declaring them early is what made it deliberately red the first time through.

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans` to implement the task list below
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship "Aiden" as an in-window assistant dock that chats about the app, then extend
it with approval-gated settings tools and opt-in proactive nudges about uncommitted work,
untouched projects, and configuration drift.

**Current architecture:** Phase 1 mounts `AssistantDock` in the main renderer's `RootView`
and reuses the existing chat IPC surface with a reserved assistant workspace. The global
hotkey focuses the main window and opens the dock; there is no assistant `BrowserWindow` or
assistant-specific preload. Future unattended proactive runs reuse the _background owner_
pattern that Scheduled Tasks established, so no renderer is required. The proactive engine
remains split into pure decision cores and thin Electron shells, following
`schedule-service-core.ts` / `schedule-service.ts`.

**Tech Stack:** Electron, TypeScript (ESM in `main/`, `.js` import specifiers), React 19 +
Vite for renderers, `croner` for the ticker, `node:test` via `tsx --test` for tests,
Tailwind + semantic tokens in `renderer/styles.css`.

## Global Constraints

- No new runtime dependencies. `croner` (already a dependency) is the only scheduling
  primitive; no `chokidar`, no `fs.watch`.
- Never contact models.dev outside `npm run models:refresh` / `npm run dist`.
- API key material stays out of the assistant's reach: assistant tools never import
  `main/services/secrets.ts`.
- Every new broadcast channel must be added to `NOTIFICATION_CHANNEL_VALUES` in
  `renderer/preload-channels.ts`. `main/handlers/ipc-contract.test.ts` asserts _exact set
  equality_ between live broadcast sites and that list, so a missed entry fails CI.
- Adding `"assistant:"` to `INVOKE_PREFIXES` fails the "every INVOKE_PREFIX has at least
  one live handler" test until a handler exists. Prefix and first handler land together.
- Every new test file is registered in the appropriate `package.json` test script so CI runs it.
- UI work reviews `docs/chatgpt-desktop-ui-inspiration.md` and
  `docs/chatgpt-ui-element-specimen.html` first, and uses semantic tokens from
  `renderer/styles.css` / `renderer/shared/appearance.ts` — no one-off colors.
- Each phase ends green on `npm run type-check`, `npm run lint`, `npm run test`.

---

## Vision

"Aiden" is a compact assistant dock inside the main window. It is an assistant _about the
app and the user's work_, not a general coding chat:

- Chat with the user about the app — answer questions, explain settings.
- Read and change app settings/config via tools (with approval for mutations).
- Proactively nudge the user about uncommitted changes in workspace projects, projects not
  touched in a while, and settings/config drift.
- Surface nudges as macOS notifications and as messages in the assistant chat; replying to
  a nudge continues the conversation.

Proactivity patterns are borrowed from hermes-agent (Nous Research), adapted to an in-app
Electron context. Key hermes ideas adopted: `[SILENT]` contract with a strict parser,
consent-first suggestion store with permanent dismiss latching, mechanical-collector /
judgment-LLM split, idle gating, first-run deferral, fail-closed unattended runs, and no
recursive self-scheduling.

## Resolved decisions

These were the plan's four open questions. They are settled; the task list assumes them.

1. **Model policy — an explicit pin is required for proactivity.** Interactive chat in the
   Aiden dock follows the app-wide provider/model selection like every other chat. The ticker
   refuses to run at all until `assistant.providerId` _and_ `assistant.model` are set, and
   surfaces "needs a model" in the settings health row. A background loop must never
   silently inherit whichever expensive model the user just switched to.
2. **No real-time file watching.** The git poll is the honest version of "notable file
   changes". No `chokidar`, no `fs.watch`, and no `fileWatchEnabled` setting — shipping a
   toggle for a feature that does not exist is worse than omitting it.
3. **No menu-bar tray.** `main/` contains no `Tray` today; adding one is net-new
   infrastructure, not reuse. Entry points in v1 are the ⌘⌥A global hotkey and clicking a
   nudge notification.
4. **Nudges do not appear in the main window.** No sidebar affordance and no main-window
   badge. Delivery is the macOS notification plus the assistant dock's own thread. The
   `assistant:nudge` broadcast still goes into the shared notification allowlist (Electron
   broadcasts reach every window), but only the dock subscribes.

## Corrections to the original draft

Verified against the codebase on 2026-07-25. The draft was wrong or incomplete on five
points; the task list reflects the corrected reality.

1. **`chat:start` has no "active application document" gate.** `chatGenerationOwner`
   (`main/services/chat-generation-owner.ts:6`) only requires that the sender be a live,
   non-detached, top-level main frame (`renderer-document-owner.ts:38`). The assistant
   main renderer already qualifies unchanged. Nothing to extend.
2. **Unattended runs use a synthetic owner, not a renderer stream.**
   `createBackgroundOwner` in `main/services/schedule-execution.ts:17` builds a
   `ChatGenerationOwner` with `id: 0`, a synthetic `documentId`, and a terminal promise
   that settles on `chat:done` / `chat:error`. The proactive engine copies that shape.
3. **`UsageRequestSource` is a closed union.** `"assistant"` must be added to the type,
   to the `REQUEST_SOURCES` runtime validator set, and to
   `main/services/usage-store-core.test.ts` (`usage-store-core.ts:8`).
4. **There are four build touch points, not three.** The draft missed
   `getAssistantPreloadPath()` in `main/windows/window-paths.ts`.
5. **`AssistantConfig` does not belong in the `settings:set` whitelist.**
   `scheduledTasksEnabled` is not there either — it is written through
   `schedule:settings` (`main/handlers/scheduled-tasks.ts:70`). Aiden follows that
   precedent with `assistant:get-config` / `assistant:set-config` and its own parser
   module. `AppSettings` gains an `assistant?: AssistantConfig` field in **both**
   `main/services/types.ts` _and_ the renderer mirror `renderer/lib/types.ts:634`.

Two further findings that shaped the design:

- The main sidebar calls `useChats(activeId)` (`renderer/components/chat-sidebar.tsx:152`),
  always workspace-filtered, so a reserved `"assistant"` workspace id genuinely hides
  assistant threads. Workspace ids are main-generated (`workspaces:create` → `newId()`), so
  collision is not a practical concern.
- `isTrustedPillSender` (`main/windows/pill-window-security.ts`) is already generic. It is
  renamed to `isTrustedWindowSender` in a shared module with `pill-window-security.ts` kept
  as a re-export, so the assistant window reuses it instead of cloning it.

## Relationship to existing plans

Scheduled Tasks is implemented through Phase 4; its plan is frozen in
`docs/plans/completed/scheduled-tasks-plan.md`. The shipped implementation establishes the
`croner` dependency, main-owned lifecycle and shutdown barriers, macOS `Notification`
delivery, dedicated task chats, usage attribution, and the `schedule:` IPC surface. Aiden
reuses those boundaries without turning private assistant polling into hidden user
schedules: assistant state and cadence stay entirely separate from user-authored
`ScheduledTask` records and `/scheduled`.

## UX

### Assistant dock (revised 2026-07-25)

Aiden is **pinned inside the main window**, not a separate `BrowserWindow`. The first
implementation shipped it as a fourth Electron surface; seeing it run made clear it wanted
to live with the work rather than float beside it, so it was rebuilt as a docked panel.

- **Expanded:** a card anchored to the bottom-right of the main window, sized to the window
  (`min(23rem, 100vw − 3rem)` × `min(34rem, 100vh − 8rem)`) so it never overflows a small
  window. Header carries the circular Aiden mark, the title, a new-conversation control,
  and minimize. Below it: transcript, then a compact composer.
- **Minimized:** a 48px circular button in the same corner showing the app mark, with an
  unread badge (1–9, then `9+`) and a one-line preview of the latest reply that fades after
  eight seconds.
- The mark is `resources/app-icon.png` — the macOS squircle carries transparent padding, so
  the `<img>` is scaled `1.32×` inside a circular mask to make the artwork bleed to the
  edge instead of leaving a ring of empty pixels.
- Mounted in `RootView`, so it is present on every route and survives navigation.
- Empty state offers three suggested prompts; a "Recent" list surfaces earlier threads.
- Assistant replies use the same safe GFM/math/code renderer and streaming handoff as the
  main chat. A formatting failure is isolated to the individual message with raw-text
  fallback.
- An attended Assistant run may list eligible projects, enabled MCP server identities, and
  automations or propose one LLM automation. Project tasks may be read-only or Full;
  external-service tasks bind exact MCP server configurations and always use Full. Project and
  MCP scopes are mutually exclusive; combined workflows must be split into separate automations.
  Creation pauses on
  an inline check/cross card that names the exact project, MCP servers, and permission.
  Saved tasks retain a main-owned Assistant execution profile so later runs cannot inherit
  unapproved Scheduled Tasks capabilities or newly added connectors. The selected provider and
  model are also pinned at approval and shown on the card.
- No attachments, no Computer Use, no model picker in v1.
- Entry points: the ⌘⌥A global hotkey (focuses the main window, then dispatches
  `app:command` with `assistant.open`) and, from Phase 3, clicking a nudge notification.

**What this removed**, relative to the original separate-window design: `assistant.html`,
`renderer/preload-assistant.ts`, `renderer/preload-assistant-channels.ts`,
`main/windows/assistant-window.ts`, all four build touch points, and the
`window-sender.ts` extraction (the pill became its only caller again). The main window's
existing preload already reaches every channel the panel needs, so the dock required no new
IPC surface at all beyond the one broadcast.

### Settings section

The shipped "Aiden" section in Settings, group "Agent", intentionally exposes only
enforceable behavior:

- global `assistant.open` status and a deep link to the canonical Keyboard Shortcuts
  editor;
- the fact that interactive Aiden follows the composer's current model;
- device-local conversation history and the constrained automation access boundary;
- the Scheduled Tasks settings surface provides an explicit default MCP-access switch for
  new Full tasks, while every saved task persists the exact selected server IDs;
- an explicit "Not active" status for background suggestions.

It does not expose the future proactivity fields below. Those contracts are parsed and
preserved, but no background ticker, project watcher, settings tools, or notification
delivery exists yet. Rendering switches for them would create false controls. Task 8's
original full-proactivity panel is therefore superseded until Tasks 9–19 implement the
runtime it was meant to control.

## Architecture

### File structure

```
assistant.html                                  new  CSP + module entry (copy of pill.html)
vite.config.ts                                  mod  third rollup input
scripts/build-electron.mjs                      mod  preload-assistant esbuild entry
package.json                                    mod  test:assistant script + test registration

main/windows/
  window-sender.ts                              new  generic trusted-sender check (+ test)
  pill-window-security.ts                       mod  re-export shim, keeps its test green
  window-paths.ts                               mod  getAssistantPreloadPath()
  assistant-window.ts                           new  singleton window, show/hide/toggle

main/handlers/
  assistant.ts                                  new  assistant:* IPC handlers
  assistant-parse.ts                            new  pure AssistantConfig parser (+ test)
  index.ts                                      mod  registerAssistantHandlers()
  chat-params.ts                                mod  validate params.mode

main/services/
  types.ts                                      mod  AssistantConfig, ChatStartParams.mode
  llm-client.ts                                 mod  assistant system-prompt branch
  tools.ts                                      mod  ToolContext.mode + assistant tools
  usage-store-core.ts                           mod  "assistant" usage source
  assistant/
    system-prompt.ts                            new  pure persona builder (+ test)
    silent-parser.ts                            new  pure [SILENT] parser (+ test)
    nudge-policy.ts                             new  pure gating/latching (+ test)
    assistant-store.ts                          new  DataStore<AssistantState> (+ test)
    signals.ts                                  new  mechanical collectors (+ test)
    settings-tools.ts                           new  get_settings / set_setting
    settings-field-policy.ts                    new  pure mutable-field whitelist (+ test)
    project-tools.ts                            new  list_projects / get_project_status
    decide-parse.ts                             new  pure urgency parsing (+ test)
    decide.ts                                   new  judgment call via background owner
    deliver.ts                                  new  Notification + broadcast + mirroring
    ticker-core.ts                              new  pure tick orchestration (+ test)
    ticker.ts                                   new  thin croner shell

renderer/
  preload-assistant.ts                          new  contextBridge for the window
  preload-assistant-channels.ts                 new  exact allowlists (+ test)
  preload-channels.ts                           mod  assistant: prefix + 3 notifications
  shared/assistant.ts                           new  ASSISTANT_WORKSPACE_ID, shared consts
  lib/types.ts                                  mod  AssistantConfig mirror
  lib/settings-section.ts                       mod  "assistant" section id
  main/settings-view.tsx                        mod  NAV + CONTENT entries
  components/settings/assistant-settings.tsx    new  settings panel
  assistant/main.tsx                            new  React entry
  assistant/assistant-app.tsx                   new  shell: header, transcript, composer
  assistant/assistant-thread.tsx                new  transcript + streaming
  assistant/assistant-recent.tsx                new  Recent threads list
  assistant/use-assistant-chat.ts               new  chat state hook (+ test)
```

### Data shapes

```ts
// main/services/types.ts
export type AssistantSettingsPermission = "full" | "ask" | "none";

export interface AssistantConfig {
  /** Proactivity master switch. Off by default — nudging is opt-in. */
  enabled: boolean;
  hotkeyEnabled: boolean;
  hotkeyAccelerator: string;
  /** Required pin. Proactivity refuses to run without both of these. */
  providerId?: string;
  model?: string;
  watchUncommitted: boolean;
  watchUntouchedProjects: boolean;
  watchConfigChanges: boolean;
  pollIntervalMinutes: number;
  untouchedThresholdDays: number;
  quietHoursEnabled: boolean;
  /** "HH:MM" local time. */
  quietHoursStart: string;
  quietHoursEnd: string;
  maxNudgesPerDay: number;
  urgencyThreshold: number;
  settingsPermission: AssistantSettingsPermission;
}

export type NudgeKind = "uncommitted" | "untouched" | "config-change";
export type NudgeStatus = "pending" | "delivered" | "dismissed" | "snoozed";

export interface NudgeRecord {
  id: string;
  /** Stable identity for latching. Dismissal suppresses this key forever. */
  dedupKey: string;
  kind: NudgeKind;
  title: string;
  body: string;
  status: NudgeStatus;
  urgency: number;
  snoozeUntil?: number;
  createdAt: number;
  deliveredAt?: number;
  chatId?: string;
}

export interface AssistantState {
  nudges: NudgeRecord[];
  /** The single dedicated Aiden thread that delivered nudges mirror into. */
  chatId?: string;
  lastRunAt?: number;
  lastTickAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  /** Last-seen settings shape, for config-drift diffing. */
  settingsSnapshot?: Record<string, unknown>;
}

export interface AssistantHealth {
  enabled: boolean;
  /** False when the model pin is missing — proactivity is blocked. */
  ready: boolean;
  state: "off" | "healthy" | "degraded" | "needs-model";
  lastTickAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  pending: NudgeRecord[];
}
```

Defaults: `enabled` false, `hotkeyEnabled` true, `hotkeyAccelerator` `"Command+Alt+A"`,
all three watch toggles true, `pollIntervalMinutes` 30, `untouchedThresholdDays` 14,
`quietHoursEnabled` false, `quietHoursStart` `"22:00"`, `quietHoursEnd` `"08:00"`,
`maxNudgesPerDay` 5, `urgencyThreshold` 7, `settingsPermission` `"ask"`.

### IPC surface

Invoke (all gated by the assistant preload allowlist): `assistant:toggle-window`,
`assistant:hide-window`, `assistant:get-config`, `assistant:set-config`,
`assistant:get-state`, `assistant:dismiss-nudge`, `assistant:snooze-nudge`.

Broadcasts (added to `NOTIFICATION_CHANNEL_VALUES`): `assistant:nudge`,
`assistant:state-changed`, `assistant:open-thread`.

Reused by the assistant window: `chat:start` / `chat:cancel` / `chat:approve`,
`chats:list` / `chats:get` / `chats:create`, `settings:get`, and the `chat:*` +
`chats:metadata-updated` + `aiden:theme:changed` broadcasts.

### Assistant tools

Registered in `buildAgentTools` (`main/services/tools.ts`) behind `ctx.mode === "assistant"`.
Assistant mode passes no `workspaceRoot`, so the folder-scoped coding tools are already
withheld. The current attended allowlist contains five scoped tools:

- `list_projects` returns only eligible folder-backed project names and ids, never paths,
  file contents, or repository status.
- `list_mcp_servers` returns only enabled server names and exact ids, never endpoints,
  credentials, tool schemas, or remote server instructions. Its host-owned status and next-step
  instruction explicitly route server ids to `mcpServerIds` and make an empty inventory
  authoritative.
- `list_scheduled_tasks` returns redacted schedule metadata without prompts or scripts,
  including an exact id, editability flag, and `updatedAt` revision for safe edits.
- `schedule_task` accepts name, cron, timezone, prompt, notification preference,
  optional project id, and read-only/Full permission. Main forces LLM mode, defaults to a
  global read-only task, and requires a valid folder-backed project for Full access. It
  normalizes and validates the arguments once before approval (including the default device
  timezone), publishes that exact project and permission through an owner-bound approval,
  then saves the same canonical fields only after Allow.
  The persisted, renderer-unforgeable Assistant execution profile survives safe Scheduled
  Tasks edits. Global tasks route through `"assistant-unattended"`; project tasks route
  through `"assistant-automation"` and receive only folder-scoped coding tools, with
  mutating tools withheld for read-only tasks.
- `edit_automation` accepts one exact editable task id and `updatedAt` revision plus a sparse
  patch. Main merges omitted fields from the stored Aiden-created LLM task, shows the complete
  resulting automation for approval, and saves it in place only if its revision is still
  current. Concurrent changes fail closed and require a fresh list rather than creating a
  duplicate or overwriting newer state.
- The dock queues approval prompts, defaults keyboard focus to Decline, keeps the prompt
  while minimized, and pipes Allow/Deny through `chat:approve` so the original agent run
  continues. A denial asks what the user wants to do instead. Unexpected tool approvals are
  denied fail-closed.
- The system prompt includes literal call contracts and complete examples for every attended
  tool, including the required `cron` field. It also includes a host-read snapshot of enabled
  MCP identities, delimited as untrusted label data, so the model knows which exact servers
  exist without inferring them. If a provider puts an exact enabled server id in the project
  field, main moves it to the MCP scope only when no project owns that id, forces Full access,
  and shows the corrected server on the approval card. Empty MCP inventory is explicitly
  authoritative. Repeated malformed tool calls get one correction attempt, then one tool-free
  recovery turn instead of surfacing a generic interrupted response.

The following broader Assistant tools remain planned:

- `get_settings` — redacted `configStore.getSettings()`; never returns secrets.
- `set_setting` — patch through `configStore.setSettings`, restricted by a shared pure
  field whitelist, routed through `ToolApprovalCoordinator` so `"ask"` mode prompts.
- richer project status — extend the identity-only `list_projects` result with `updatedAt`
  and a `gitInfo` summary only when the broader project-status feature ships. Project names
  are never injected into the base system prompt.
- `get_project_status` — deeper `gitInfo` for one workspace.

Out of scope for v1: provider keys, MCP servers, skills, direct dock shell access, Computer
Use, and the `remember` memory tool (deferred). Approved Full project automations may run
folder-scoped commands when their timer fires. Nudge dismissal and snoozing are IPC handlers
driven by the settings UI rather than model tools, so a proactive run cannot silence itself.

### Safety rails

- Attended Assistant runs can only list eligible project/MCP identities, list schedules,
  create the constrained LLM automation above, or edit one exact Aiden-created LLM
  automation after approval. They cannot pause, resume, remove, run-now, or run arbitrary
  scripts. Full permission requires an approval naming either the exact project or the exact
  fingerprint-bound MCP scope and unattended mutation risk; one automation cannot receive both.
- `"assistant-unattended"` receives no scheduling tool and cannot create automations.
- `"assistant-automation"` receives only project coding tools: no scheduling, connectors,
  Computer Use, skills, or subagents.
- Both unattended modes are only reachable in-process; `parseParams` accepts `"assistant"`
  only, so a renderer can never request background capabilities or forge the protected
  schedule profile.
- An exact unattended `[SILENT]` response is stored as a silent run and suppresses the
  completion notification.
- Settings mutations always respect `settingsPermission`; provider removal and key material
  are outside the whitelist entirely.
- Decision-call failures record `lastError` and surface once, then back off. No silent
  swallowing, no silent provider fallback.

---

# Implementation plan

## Phase 1 — Dock and chat (implemented)

> The task-by-task material below preserves the original separate-window implementation
> plan for history. Phase 1 ultimately shipped through the dock revision documented above;
> its unchecked boxes and assistant-window file lists are not the current implementation
> inventory. Phases 2 and 3 remain the active future work.

### Task 1: Generic trusted-sender check

**Files:**

- Create: `main/windows/window-sender.ts`
- Create: `main/windows/window-sender.test.ts`
- Modify: `main/windows/pill-window-security.ts`
- Modify: `package.json` (register the new test in `test`)

**Interfaces:**

- Produces: `WindowSenderIdentity { webContentsId: number; frameUrl: string; isMainFrame: boolean }`
  and `isTrustedWindowSender(expectedWebContentsId: number | null, expectedUrl: string, actual: WindowSenderIdentity): boolean`.
- `pill-window-security.ts` keeps exporting `PillSenderIdentity` and `isTrustedPillSender`
  so `main/windows/pill-window-security.test.ts` and `pill-window.ts` stay untouched.

- [ ] **Step 1: Write the failing test**

`main/windows/window-sender.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedWindowSender } from "./window-sender.js";

const url = "file:///app/build/renderer/assistant.html";

test("accepts the current window's main frame at the expected url", () => {
  assert.equal(
    isTrustedWindowSender(7, url, { webContentsId: 7, frameUrl: url, isMainFrame: true }),
    true,
  );
});

test("rejects a sender when no window is open", () => {
  assert.equal(
    isTrustedWindowSender(null, url, { webContentsId: 7, frameUrl: url, isMainFrame: true }),
    false,
  );
});

test("rejects a different webContents, a subframe, and a navigated url", () => {
  assert.equal(
    isTrustedWindowSender(7, url, { webContentsId: 8, frameUrl: url, isMainFrame: true }),
    false,
  );
  assert.equal(
    isTrustedWindowSender(7, url, { webContentsId: 7, frameUrl: url, isMainFrame: false }),
    false,
  );
  assert.equal(
    isTrustedWindowSender(7, url, {
      webContentsId: 7,
      frameUrl: "https://evil.example/",
      isMainFrame: true,
    }),
    false,
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/windows/window-sender.test.ts
```

Expected: FAIL — cannot resolve `./window-sender.js`.

- [ ] **Step 3: Create the module**

`main/windows/window-sender.ts`:

```ts
// Shared trusted-sender check for Aiden's privileged auxiliary windows (the
// dictation pill and the Aiden assistant window). A privileged channel must only
// answer the exact window it was created for: the right webContents, its own
// main frame, still sitting on the URL we loaded.

export interface WindowSenderIdentity {
  webContentsId: number;
  frameUrl: string;
  isMainFrame: boolean;
}

export function isTrustedWindowSender(
  expectedWebContentsId: number | null,
  expectedUrl: string,
  actual: WindowSenderIdentity,
): boolean {
  return (
    expectedWebContentsId !== null &&
    actual.webContentsId === expectedWebContentsId &&
    actual.isMainFrame &&
    actual.frameUrl === expectedUrl
  );
}
```

- [ ] **Step 4: Reduce `pill-window-security.ts` to a re-export**

```ts
// The pill's trusted-sender rule is the generic one; see window-sender.ts. Kept
// as a named alias so the pill call sites and their test read as pill-specific.
export type { WindowSenderIdentity as PillSenderIdentity } from "./window-sender.js";
export { isTrustedWindowSender as isTrustedPillSender } from "./window-sender.js";
```

- [ ] **Step 5: Register the test and run both suites**

In `package.json`, add `main/windows/window-sender.test.ts` to the `test` script
immediately after `main/windows/pill-window-security.test.ts`.

```bash
npx tsx --test main/windows/window-sender.test.ts main/windows/pill-window-security.test.ts
```

Expected: PASS, both files.

- [ ] **Step 6: Commit**

```bash
git add main/windows/window-sender.ts main/windows/window-sender.test.ts main/windows/pill-window-security.ts package.json
git commit -m "refactor(windows): extract the generic trusted-sender check"
```

---

### Task 2: Assistant preload channel allowlist

**Files:**

- Create: `renderer/preload-assistant-channels.ts`
- Create: `renderer/preload-assistant-channels.test.ts`
- Create: `renderer/shared/assistant.ts`
- Modify: `renderer/preload-channels.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `ASSISTANT_INVOKE_CHANNELS: Set<string>`,
  `ASSISTANT_NOTIFICATION_CHANNELS: Set<string>`, and `ASSISTANT_WORKSPACE_ID = "assistant"`
  plus `ASSISTANT_SUGGESTED_PROMPTS` from `renderer/shared/assistant.ts`.
- Consumes nothing from earlier tasks.

- [ ] **Step 1: Write the failing test**

`renderer/preload-assistant-channels.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_INVOKE_CHANNELS,
  ASSISTANT_NOTIFICATION_CHANNELS,
} from "./preload-assistant-channels.js";
import { NOTIFICATION_CHANNELS } from "./preload-channels.js";

test("assistant preload exposes exactly its chat, history, config, and nudge surface", () => {
  assert.deepEqual([...ASSISTANT_INVOKE_CHANNELS].sort(), [
    "assistant:dismiss-nudge",
    "assistant:get-config",
    "assistant:get-state",
    "assistant:hide-window",
    "assistant:set-config",
    "assistant:snooze-nudge",
    "assistant:toggle-window",
    "chat:approve",
    "chat:cancel",
    "chat:start",
    "chats:create",
    "chats:get",
    "chats:list",
    "settings:get",
  ]);
  assert.deepEqual([...ASSISTANT_NOTIFICATION_CHANNELS].sort(), [
    "aiden:theme:changed",
    "assistant:nudge",
    "assistant:open-thread",
    "assistant:state-changed",
    "chat:approval",
    "chat:delta",
    "chat:done",
    "chat:error",
    "chat:reasoning-delta",
    "chat:status",
    "chat:timeline",
    "chat:tool",
    "chats:metadata-updated",
  ]);
});

test("the assistant window cannot reach key material, git writes, or the scheduler", () => {
  for (const forbidden of [
    "providers:setKey",
    "mcp:setPresetKey",
    "settings:set",
    "git:push",
    "git:commit",
    "schedule:save",
    "computerUse:start",
    "terminal:create",
  ]) {
    assert.equal(ASSISTANT_INVOKE_CHANNELS.has(forbidden), false, forbidden);
  }
});

test("every assistant notification is also in the shared preload allowlist", () => {
  // ipcMain.broadcast reaches every window, so the shared list is the contract
  // the ipc-contract test enforces; this one keeps the two from drifting.
  for (const channel of ASSISTANT_NOTIFICATION_CHANNELS) {
    assert.equal(NOTIFICATION_CHANNELS.has(channel), true, channel);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test renderer/preload-assistant-channels.test.ts
```

Expected: FAIL — cannot resolve `./preload-assistant-channels.js`.

- [ ] **Step 3: Create the allowlist module**

`renderer/preload-assistant-channels.ts`:

```ts
// Exact channel names the Aiden assistant window may use — never prefixes. The
// window is a privileged auxiliary surface with no folder tools, no key
// material, and no scheduler reach; enumerating the surface is what keeps that
// true as `chat:` and `chats:` grow.

export const ASSISTANT_INVOKE_CHANNELS = new Set([
  "assistant:dismiss-nudge",
  "assistant:get-config",
  "assistant:get-state",
  "assistant:hide-window",
  "assistant:set-config",
  "assistant:snooze-nudge",
  "assistant:toggle-window",
  "chat:approve",
  "chat:cancel",
  "chat:start",
  "chats:create",
  "chats:get",
  "chats:list",
  "settings:get",
]);

export const ASSISTANT_NOTIFICATION_CHANNELS = new Set([
  "aiden:theme:changed",
  "assistant:nudge",
  "assistant:open-thread",
  "assistant:state-changed",
  "chat:approval",
  "chat:delta",
  "chat:done",
  "chat:error",
  "chat:reasoning-delta",
  "chat:status",
  "chat:timeline",
  "chat:tool",
  "chats:metadata-updated",
]);
```

- [ ] **Step 4: Add the three broadcasts to the shared allowlist**

In `renderer/preload-channels.ts`, insert into `NOTIFICATION_CHANNEL_VALUES` in sorted
position (after `"app:open-workspace-preferred-editor"`):

```ts
  "assistant:nudge",
  "assistant:open-thread",
  "assistant:state-changed",
```

Do **not** add `"assistant:"` to `INVOKE_PREFIXES` yet — that breaks the contract test
until Task 4 registers a handler.

- [ ] **Step 5: Create the shared assistant constants**

`renderer/shared/assistant.ts`:

```ts
// Shared between main and every renderer: the reserved workspace id that keeps
// assistant threads out of the main window's sidebar. The sidebar always lists
// chats filtered by the active workspace, and workspace ids are main-generated,
// so a reserved literal is sufficient isolation.
export const ASSISTANT_WORKSPACE_ID = "assistant";

/** Prompts offered in the assistant window's empty state. */
export const ASSISTANT_SUGGESTED_PROMPTS = [
  "Any uncommitted changes?",
  "What did I change today?",
  "Summarize my settings",
] as const;
```

- [ ] **Step 6: Register the test and run it plus the contract test**

Add `renderer/preload-assistant-channels.test.ts` to the `test:preflight` script, next to
`renderer/pill-preload-channels.test.ts`.

```bash
npx tsx --test renderer/preload-assistant-channels.test.ts main/handlers/ipc-contract.test.ts
```

Expected: the allowlist test PASSES. The contract test FAILS on `assistant:nudge` /
`assistant:open-thread` / `assistant:state-changed` having no live broadcast site — that is
expected and is fixed in Tasks 18 and 19.

- [ ] **Step 7: Commit**

```bash
git add renderer/preload-assistant-channels.ts renderer/preload-assistant-channels.test.ts renderer/shared/assistant.ts renderer/preload-channels.ts package.json
git commit -m "feat(assistant): add the assistant window's preload channel allowlist"
```

> **Note for every task until Task 19:** `ipc-contract.test.ts` is deliberately red from
> here on, because the three `assistant:*` notification channels are declared before their
> broadcast sites exist. Do not "fix" it by removing the entries.

---

### Task 3: Build plumbing and renderer shell

**Files:**

- Create: `assistant.html`
- Create: `renderer/preload-assistant.ts`
- Create: `renderer/assistant/main.tsx`
- Create: `renderer/assistant/assistant-app.tsx`
- Modify: `vite.config.ts:21-24`
- Modify: `scripts/build-electron.mjs:26-32`
- Modify: `main/windows/window-paths.ts:11-13`

**Interfaces:**

- Consumes: `ASSISTANT_INVOKE_CHANNELS`, `ASSISTANT_NOTIFICATION_CHANNELS` (Task 2).
- Produces: `getAssistantPreloadPath(): string`; a `window.aidenAPI.ipc` bridge inside the
  assistant window with the same `{ invoke, onNotification }` shape the main and pill
  preloads expose, so the `renderer/lib/ipc.ts` helpers work unchanged.

- [ ] **Step 1: Add the Vite input**

`vite.config.ts`, inside `rollupOptions.input`:

```ts
        "main-window": resolve(import.meta.dirname, "main-window.html"),
        pill: resolve(import.meta.dirname, "pill.html"),
        assistant: resolve(import.meta.dirname, "assistant.html"),
```

- [ ] **Step 2: Add the esbuild preload entry**

`scripts/build-electron.mjs`, as a fourth entry in the `Promise.all` array:

```js
  build({
    ...common,
    entryPoints: ["renderer/preload-assistant.ts"],
    outfile: "build/preload/preload-assistant.cjs",
    format: "cjs",
    external: ["electron"],
  }),
```

- [ ] **Step 3: Add the preload path resolver**

`main/windows/window-paths.ts`, after `getPillPreloadPath`:

```ts
export function getAssistantPreloadPath(): string {
  return path.join(buildRoot, "preload", "preload-assistant.cjs");
}
```

- [ ] **Step 4: Create `assistant.html`**

Copy `pill.html` verbatim, changing only the `<title>` to `Aiden` and the script `src` to
`./renderer/assistant/main.tsx`. The CSP `<meta>` must be byte-identical to the pill's — it
is the window's only network policy.

- [ ] **Step 5: Create the preload bridge**

`renderer/preload-assistant.ts`:

```ts
import { contextBridge, ipcRenderer } from "electron";
import { NATIVE_INVOKE_CHANNELS } from "./preload-channels.js";
import {
  ASSISTANT_INVOKE_CHANNELS,
  ASSISTANT_NOTIFICATION_CHANNELS,
} from "./preload-assistant-channels.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!ASSISTANT_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`IPC channel is not available to the Aiden window: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function onNotification(channel: string, callback: (payload: unknown) => void): () => void {
  if (!ASSISTANT_NOTIFICATION_CHANNELS.has(channel)) {
    throw new Error(`Notification is not available to the Aiden window: ${channel}`);
  }
  const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("aidenAPI", {
  ipc: { invoke, onNotification },
  theme: {
    get: () => ipcRenderer.invoke(NATIVE_INVOKE_CHANNELS.themeGet),
  },
});
```

- [ ] **Step 6: Create the renderer entry and a placeholder shell**

`renderer/assistant/main.tsx` (mirrors `renderer/pill/main.tsx`):

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "../styles.css";
import { applyCachedAppearance } from "../lib/appearance-runtime";
import { AssistantApp } from "./assistant-app";

document.documentElement.classList.add("aiden-assistant-window");
applyCachedAppearance();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <AssistantApp />
  </React.StrictMode>,
);
```

`renderer/assistant/assistant-app.tsx` — a minimal shell for now; Task 6 fills it in:

```tsx
import * as React from "react";
import { X } from "lucide-react";
import { invoke } from "../lib/ipc";

export function AssistantApp(): React.ReactElement {
  return (
    <div className="flex h-screen flex-col">
      <header
        className="flex h-11 shrink-0 items-center justify-between px-3"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-sm font-medium">Aiden</span>
        <button
          type="button"
          aria-label="Close Aiden"
          className="rounded-md p-1"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => void invoke("assistant:hide-window")}
        >
          <X className="size-4" />
        </button>
      </header>
      <div className="flex-1" />
    </div>
  );
}
```

Add colour and hover treatment using the semantic token classes `renderer/styles.css`
actually defines — read that file rather than inventing token names.

- [ ] **Step 7: Build and confirm the new bundles appear**

```bash
npm run build
```

Expected: `build/renderer/assistant.html`, a hashed JS chunk for it, and
`build/preload/preload-assistant.cjs` all exist.

```bash
npm run type-check
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add assistant.html vite.config.ts scripts/build-electron.mjs main/windows/window-paths.ts renderer/preload-assistant.ts renderer/assistant
git commit -m "feat(assistant): add the assistant window build plumbing and renderer shell"
```

---

### Task 4: Assistant window module, handlers, and hotkey

**Files:**

- Create: `main/windows/assistant-window.ts`
- Create: `main/handlers/assistant.ts`
- Modify: `main/handlers/index.ts:22,59`
- Modify: `renderer/preload-channels.ts` (add `"assistant:"` to `INVOKE_PREFIXES`)
- Modify: `main/services/types.ts` (`AssistantConfig`, `AppSettings.assistant`)
- Modify: `renderer/lib/types.ts` (the same two additions, mirrored)
- Modify: `main/services/shortcut.ts`
- Modify: `main/index.ts`

**Interfaces:**

- Consumes: `isTrustedWindowSender` (Task 1), `getAssistantPreloadPath` (Task 3).
- Produces: `showAssistantWindow(): Promise<BrowserWindow>`, `hideAssistantWindow(): void`,
  `toggleAssistantWindow(): Promise<void>`, `destroyAssistantWindow(): void`,
  `isCurrentAssistantEvent(event: IpcMainInvokeEvent): boolean`,
  `initAssistantShortcut(trigger: () => void): void`,
  `DEFAULT_ASSISTANT_ACCELERATOR = "Command+Alt+A"`, `registerAssistantHandlers(): void`,
  and the `AssistantConfig` interface from the Data shapes section.

- [ ] **Step 1: Add `AssistantConfig` to both type files**

Add the full `AssistantConfig` and `AssistantSettingsPermission` declarations from the Data
shapes section to `main/services/types.ts`, plus this field on `AppSettings`:

```ts
  /** Aiden assistant window, hotkey, and proactivity settings. */
  assistant?: AssistantConfig;
```

Mirror both into `renderer/lib/types.ts` next to its `AppSettings` (line 634). The two
files are hand-mirrored today; keep them identical.

- [ ] **Step 2: Create the window module**

`main/windows/assistant-window.ts`, modeled on `pill-window.ts` (module singleton +
in-flight `loading` promise, `setWindowOpenHandler` deny, `will-navigate` lockdown):

```ts
// The Aiden assistant window: a compact, focusable, closable companion window
// modeled on the dictation pill's lifecycle but shaped like a small chat app.
// Unlike the pill it takes focus and can be closed, so it is recreated on demand
// rather than living for the app's lifetime.

import { BrowserWindow, logger, screen } from "../platform.js";
import type { IpcMainInvokeEvent } from "electron";
import { getAssistantPreloadPath, getWindowUrl } from "./window-paths.js";
import { isTrustedWindowSender } from "./window-sender.js";

const WIDTH = 400;
const HEIGHT = 640;
const EDGE_MARGIN = 24;

let assistantWindow: BrowserWindow | null = null;
let loading: Promise<BrowserWindow> | null = null;
let assistantUrl = "";

function positionAssistant(window: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { workArea } = display;
  const [width, height] = window.getSize();
  window.setBounds({
    x: Math.round(workArea.x + workArea.width - width - EDGE_MARGIN),
    y: Math.round(workArea.y + EDGE_MARGIN),
    width,
    height,
  });
}

async function createAssistantWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    minWidth: 340,
    minHeight: 420,
    frame: false,
    titleBarStyle: "hidden",
    transparent: true,
    vibrancy: "sidebar",
    visualEffectState: "active",
    hasShadow: true,
    alwaysOnTop: false,
    focusable: true,
    resizable: true,
    minimizable: true,
    maximizable: false,
    closable: true,
    show: false,
    webPreferences: {
      preload: getAssistantPreloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.on("closed", () => {
    assistantWindow = null;
  });

  const loaded = new Promise<BrowserWindow>((resolve, reject) => {
    window.webContents.once("did-finish-load", () => resolve(window));
    window.webContents.once("did-fail-load", (_event, code, description) =>
      reject(new Error(`Assistant window failed to load (${code}): ${description}`)),
    );
  });

  const url = getWindowUrl("assistant.html");
  assistantUrl = url;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== assistantUrl) event.preventDefault();
  });
  logger.info("assistant", "Loading the Aiden assistant window", { url });
  void window.loadURL(url);
  return loaded;
}

async function ensureAssistantWindow(): Promise<BrowserWindow> {
  if (assistantWindow && !assistantWindow.isDestroyed()) return assistantWindow;
  if (!loading) {
    loading = createAssistantWindow().finally(() => {
      loading = null;
    });
  }
  assistantWindow = await loading;
  positionAssistant(assistantWindow);
  return assistantWindow;
}

/** Show and focus the assistant window, creating it if it is not open. */
export async function showAssistantWindow(): Promise<BrowserWindow> {
  const window = await ensureAssistantWindow();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  return window;
}

export function hideAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.hide();
}

export async function toggleAssistantWindow(): Promise<void> {
  if (assistantWindow && !assistantWindow.isDestroyed() && assistantWindow.isVisible()) {
    // Visible but behind another app: bring it forward rather than hiding it.
    if (assistantWindow.isFocused()) {
      assistantWindow.hide();
      return;
    }
    assistantWindow.focus();
    return;
  }
  await showAssistantWindow();
}

export function destroyAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) assistantWindow.destroy();
  assistantWindow = null;
}

export function isCurrentAssistantEvent(event: IpcMainInvokeEvent): boolean {
  const current =
    assistantWindow && !assistantWindow.isDestroyed() ? assistantWindow.webContents.id : null;
  const frame = event.senderFrame;
  if (!frame) return false;
  return isTrustedWindowSender(current, assistantUrl, {
    webContentsId: event.sender.id,
    frameUrl: frame.url,
    isMainFrame: frame === event.sender.mainFrame,
  });
}
```

- [ ] **Step 3: Create the handler module with the two window channels**

`main/handlers/assistant.ts`:

```ts
import { ipcMain } from "../platform.js";
import {
  hideAssistantWindow,
  isCurrentAssistantEvent,
  toggleAssistantWindow,
} from "../windows/assistant-window.js";

export function registerAssistantHandlers(): void {
  ipcMain.handle("assistant:toggle-window", async () => {
    await toggleAssistantWindow();
  });

  // Only the assistant window itself may hide the assistant window.
  ipcMain.handle("assistant:hide-window", async (event) => {
    if (!isCurrentAssistantEvent(event)) return;
    hideAssistantWindow();
  });
}
```

- [ ] **Step 4: Register the handlers and the invoke prefix**

In `main/handlers/index.ts`, add
`import { registerAssistantHandlers } from "./assistant.js";` beside the other handler
imports and call `registerAssistantHandlers();` after `registerScheduledTaskHandlers();`.

In `renderer/preload-channels.ts`, add `"assistant:"` to `INVOKE_PREFIXES` in sorted
position (after `"artificialAnalysis:"`).

- [ ] **Step 5: Add the third global shortcut**

In `main/services/shortcut.ts`, following the existing focus/dictation structure exactly:
add `export const DEFAULT_ASSISTANT_ACCELERATOR = "Command+Alt+A";`, an `onAssistant`
callback with `initAssistantShortcut(trigger)`, a `registeredAssistant` slot, and this
block at the end of `applyShortcutFromSettings()`:

```ts
// ── Assistant shortcut ──────────────────────────────────────────────
if (registeredAssistant) {
  globalShortcut.unregister(registeredAssistant);
  registeredAssistant = null;
}
const assistantEnabled = settings.assistant?.hotkeyEnabled !== false;
const assistantAccel = settings.assistant?.hotkeyAccelerator || DEFAULT_ASSISTANT_ACCELERATOR;
// Skip collisions with the already-registered focus and dictation hotkeys.
if (
  assistantEnabled &&
  onAssistant &&
  assistantAccel !== registered &&
  assistantAccel !== registeredDictation
) {
  if (await register(assistantAccel, onAssistant)) registeredAssistant = assistantAccel;
}
```

Also clear `registeredAssistant` in `disposeShortcut()`.

- [ ] **Step 6: Wire the hotkey and cleanup in `main/index.ts`**

Import `initAssistantShortcut` from `./services/shortcut.js` and `destroyAssistantWindow`,
`showAssistantWindow` from `./windows/assistant-window.js`. Beside the existing
`initShortcut(...)` call (`main/index.ts:594`):

```ts
initAssistantShortcut(() => {
  void showAssistantWindow();
});
```

Add `destroyAssistantWindow();` to `cleanupApplication()` next to `disposeDictation();`.

- [ ] **Step 7: Verify the contract test's prefix assertions pass**

```bash
npx tsx --test main/handlers/ipc-contract.test.ts
```

Expected: the two `INVOKE_PREFIX` tests PASS (`assistant:toggle-window` backs the new
prefix). The notification-allowlist test still FAILS until Task 19.

```bash
npm run type-check && npm run lint
```

Expected: PASS.

- [ ] **Step 8: Manual check**

```bash
npm run dev
```

Press ⌘⌥A. Expected: a 400×640 frameless vibrant window appears at the top-right of the
display under the cursor. Press ⌘⌥A again — it hides. Click its close control — it hides.
Press ⌘⌥A once more — it comes back.

- [ ] **Step 9: Commit**

```bash
git add main/windows/assistant-window.ts main/handlers/assistant.ts main/handlers/index.ts main/services/shortcut.ts main/services/types.ts main/index.ts renderer/preload-channels.ts renderer/lib/types.ts
git commit -m "feat(assistant): open the Aiden window from a global hotkey"
```

---

### Task 5: Assistant-mode system prompt

**Files:**

- Create: `main/services/assistant/system-prompt.ts`
- Create: `main/services/assistant/system-prompt.test.ts`
- Modify: `main/services/types.ts` (`ChatStartParams.mode`)
- Modify: `main/handlers/chat-params.ts:74-101`
- Modify: `main/handlers/chat.parse.test.ts`
- Modify: `main/services/llm-client.ts` (~line 518)
- Modify: `package.json`

**Interfaces:**

- Produces: `buildAssistantSystemPrompt(input: AssistantPromptInput): string` where

```ts
export interface AssistantPromptInput {
  /** Names of the user's workspaces, for grounding "my projects" questions. */
  workspaceNames: readonly string[];
  /** Settings section ids the assistant may talk about. */
  settingsSections: readonly string[];
  /** Whether the assistant may mutate settings, and whether it must ask first. */
  settingsPermission: "full" | "ask" | "none";
  /** True for background proactive runs: adds the strict [SILENT] contract. */
  unattended: boolean;
}
```

- Produces: `ChatStartParams.mode?: "assistant" | "assistant-unattended"`. `parseParams`
  accepts `"assistant"` only, so a renderer can never request the unattended prompt.

- [ ] **Step 1: Write the failing test**

`main/services/assistant/system-prompt.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildAssistantSystemPrompt } from "./system-prompt.js";

const base = {
  workspaceNames: ["aiden-agent", "notes"],
  settingsSections: ["providers", "appearance"],
  settingsPermission: "ask" as const,
  unattended: false,
};

test("introduces Aiden as an assistant about the app, not a coding agent", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /You are Aiden/u);
  assert.match(prompt, /Aiden Agent/u);
  assert.match(prompt, /not a coding agent/u);
});

test("grounds the prompt in the user's workspaces and settings sections", () => {
  const prompt = buildAssistantSystemPrompt(base);
  assert.match(prompt, /aiden-agent/u);
  assert.match(prompt, /notes/u);
  assert.match(prompt, /providers/u);
});

test("states the approval posture for settings mutations", () => {
  assert.match(buildAssistantSystemPrompt(base), /must approve/u);
  assert.match(
    buildAssistantSystemPrompt({ ...base, settingsPermission: "full" }),
    /without asking/u,
  );
  assert.match(
    buildAssistantSystemPrompt({ ...base, settingsPermission: "none" }),
    /cannot change settings/u,
  );
});

test("adds the [SILENT] contract only for unattended runs", () => {
  assert.doesNotMatch(buildAssistantSystemPrompt(base), /\[SILENT\]/u);
  const unattended = buildAssistantSystemPrompt({ ...base, unattended: true });
  assert.match(unattended, /\[SILENT\]/u);
  assert.match(unattended, /nothing else/u);
});

test("handles a user with no workspaces without emitting a dangling list", () => {
  const prompt = buildAssistantSystemPrompt({ ...base, workspaceNames: [] });
  assert.doesNotMatch(prompt, /projects are:\s*\./u);
  assert.match(prompt, /no projects/u);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/system-prompt.test.ts
```

Expected: FAIL — cannot resolve `./system-prompt.js`.

- [ ] **Step 3: Write the module**

`main/services/assistant/system-prompt.ts`:

```ts
// The Aiden persona. Kept pure and free of Electron and config I/O so the
// contract that matters most — that unattended runs carry the [SILENT] rule and
// attended ones do not — is unit-testable.

export interface AssistantPromptInput {
  workspaceNames: readonly string[];
  settingsSections: readonly string[];
  settingsPermission: "full" | "ask" | "none";
  unattended: boolean;
}

const PERMISSION_TEXT: Record<AssistantPromptInput["settingsPermission"], string> = {
  full: "You may change settings without asking first.",
  ask: "The user must approve every settings change before it is applied.",
  none: "You cannot change settings; explain what you would change and let the user do it.",
};

const SILENT_CONTRACT = [
  "You are running unattended, on a timer, with no one watching.",
  "If nothing here is worth interrupting the user for, reply with exactly [SILENT]",
  "on a line by itself and nothing else. Do not explain the silence.",
  "Only speak when the user would thank you for the interruption.",
].join(" ");

export function buildAssistantSystemPrompt(input: AssistantPromptInput): string {
  const projects =
    input.workspaceNames.length > 0
      ? `The user's projects are: ${input.workspaceNames.join(", ")}.`
      : "The user has no projects set up yet.";
  const sections = `Settings are organised into these sections: ${input.settingsSections.join(", ")}.`;
  return [
    "You are Aiden, the in-app assistant for Aiden Agent, a macOS desktop app for",
    "chatting with AI models across a user's coding projects. You help the user",
    "understand and operate the app itself: you answer questions about it, explain and",
    "adjust its settings, and report on the state of their projects.",
    "",
    "You are not a coding agent. You have no access to file contents and cannot run",
    "commands. When the user wants code written or changed, tell them to use a project",
    "chat in the main window.",
    "",
    projects,
    sections,
    PERMISSION_TEXT[input.settingsPermission],
    "",
    "Use your tools rather than guessing: read settings before describing them, and",
    "check project status before reporting on it. Be brief — this is a small window.",
    "Use Markdown sparingly and never open with a preamble about what you are about to do.",
    ...(input.unattended ? ["", SILENT_CONTRACT] : []),
  ].join("\n");
}
```

- [ ] **Step 4: Run the test**

```bash
npx tsx --test main/services/assistant/system-prompt.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add `mode` to `ChatStartParams` and validate it**

In `main/services/types.ts`, on `ChatStartParams` (line 501):

```ts
  /**
   * Selects the system prompt and tool set. Absent means the normal workspace
   * chat. "assistant-unattended" is main-only: parseParams never produces it, so
   * a renderer cannot request the [SILENT] prompt.
   */
  mode?: "assistant" | "assistant-unattended";
```

Mirror the field on `renderer/lib/types.ts`'s `ChatStartParams`, but as
`mode?: "assistant"` — the renderer has no business naming the unattended mode.

In `main/handlers/chat-params.ts`, inside `parseParams` before the return:

```ts
if (p.mode !== undefined && p.mode !== "assistant") throw new Error("Invalid chat mode.");
```

and add `...(p.mode === "assistant" ? { mode: "assistant" as const } : {}),` to the returned
object.

- [ ] **Step 6: Extend the parse test**

Add to `main/handlers/chat.parse.test.ts`, matching that file's existing import style:

```ts
test("accepts the assistant mode and rejects the unattended mode from a renderer", () => {
  const base = { chatId: "c1", providerId: "p", model: "m", messages: [] };
  assert.equal(parseParams({ ...base, mode: "assistant" }).mode, "assistant");
  assert.equal(parseParams(base).mode, undefined);
  assert.throws(() => parseParams({ ...base, mode: "assistant-unattended" }), /Invalid chat mode/u);
});
```

- [ ] **Step 7: Branch the system prompt in `llm-client.ts`**

At the `buildSystemPrompt` call site (`main/services/llm-client.ts:518`), replace the single
assignment with:

```ts
const systemPrompt =
  params.mode === "assistant" || params.mode === "assistant-unattended"
    ? buildAssistantSystemPrompt({
        workspaceNames: (await configStore.listWorkspaces()).map((workspace) => workspace.name),
        settingsSections: SETTINGS_SECTIONS,
        settingsPermission: settings.assistant?.settingsPermission ?? "ask",
        unattended: params.mode === "assistant-unattended",
      })
    : await buildSystemPrompt(folderPath, git.branch, permission);
```

Import `buildAssistantSystemPrompt` from `./assistant/system-prompt.js` and
`SETTINGS_SECTIONS` from `../../renderer/lib/settings-section.js`. `settings` is already in
scope in `prepareGeneration` (line 292).

- [ ] **Step 8: Run the suites**

```bash
npx tsx --test main/services/assistant/system-prompt.test.ts main/handlers/chat.parse.test.ts && npm run type-check
```

Expected: PASS.

- [ ] **Step 9: Register the test and commit**

Add `main/services/assistant/system-prompt.test.ts` to the `test` script.

```bash
git add main/services/assistant main/services/types.ts main/services/llm-client.ts main/handlers/chat-params.ts main/handlers/chat.parse.test.ts renderer/lib/types.ts package.json
git commit -m "feat(assistant): add the assistant-mode system prompt"
```

---

### Task 6: Assistant chat UI

**Files:**

- Modify: `renderer/assistant/assistant-app.tsx`
- Create: `renderer/assistant/assistant-thread.tsx`
- Create: `renderer/assistant/assistant-recent.tsx`
- Create: `renderer/assistant/use-assistant-chat.ts`
- Create: `renderer/assistant/use-assistant-chat.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `ASSISTANT_WORKSPACE_ID`, `ASSISTANT_SUGGESTED_PROMPTS` (Task 2);
  `mode: "assistant"` on `ChatStartParams` (Task 5); `startGeneration`, `chatsApi`,
  `settingsApi`, `onNotification` from `renderer/lib/ipc.ts`.
- Produces: `canSendAssistantMessage(draft: string, state: { streaming: boolean; ready: boolean }): boolean`
  and `useAssistantChat()` returning
  `{ messages, streaming, error, ready, threads, activeChatId, send(text), stop(), openThread(id), newThread() }`.

- [ ] **Step 1: Review the UI references**

Read `docs/chatgpt-desktop-ui-inspiration.md` and open
`docs/chatgpt-ui-element-specimen.html`. Note the compact-window header, transcript
density, and composer treatment. Then read `renderer/components/composer.tsx` to see which
pieces are reusable without dragging in attachments or Computer Use.

- [ ] **Step 2: Write the failing test for the send guard**

Test the pure part only, so no DOM or IPC mocking is needed.
`renderer/assistant/use-assistant-chat.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { canSendAssistantMessage } from "./use-assistant-chat.js";

test("blocks empty and whitespace-only sends", () => {
  assert.equal(canSendAssistantMessage("", { streaming: false, ready: true }), false);
  assert.equal(canSendAssistantMessage("   \n ", { streaming: false, ready: true }), false);
});

test("blocks while a response is streaming", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: true, ready: true }), false);
});

test("blocks until a provider and model are known", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: false, ready: false }), false);
});

test("allows a real message when idle and ready", () => {
  assert.equal(canSendAssistantMessage("hi", { streaming: false, ready: true }), true);
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx tsx --test renderer/assistant/use-assistant-chat.test.ts
```

Expected: FAIL — cannot resolve `./use-assistant-chat.js`.

- [ ] **Step 4: Write the hook**

`renderer/assistant/use-assistant-chat.ts`. Export the pure guard first:

```ts
export function canSendAssistantMessage(
  draft: string,
  state: { streaming: boolean; ready: boolean },
): boolean {
  return draft.trim().length > 0 && !state.streaming && state.ready;
}
```

Then `useAssistantChat()`:

- On mount, `settingsApi.get()` for `lastProviderId` / `lastModel`; `ready` is true only
  when both are present. Also `chatsApi.list(ASSISTANT_WORKSPACE_ID)` for `threads`.
- `newThread()` calls
  `chatsApi.create({ title: "Aiden", workspaceId: ASSISTANT_WORKSPACE_ID, providerId, model })`.
- `send(text)` guards on `canSendAssistantMessage`, appends an optimistic user message, then
  calls `startGeneration({ chatId, workspaceId: ASSISTANT_WORKSPACE_ID, providerId, model, mode: "assistant", messages }, callbacks)`,
  appending deltas to the trailing assistant message.
- `stop()` cancels through the returned generation handle.
- Subscribe to `chats:metadata-updated` to refresh `threads`, and to
  `assistant:open-thread` to switch `activeChatId` when a notification click arrives.

Read `renderer/lib/ipc.ts:486` (`startGeneration`) for the exact `StreamCallbacks` shape
before writing this, and match how the main window consumes it.

- [ ] **Step 5: Run the test**

```bash
npx tsx --test renderer/assistant/use-assistant-chat.test.ts
```

Expected: PASS.

- [ ] **Step 6: Build the three components**

- `assistant-thread.tsx` — scrolling transcript, auto-scrolled to the bottom while
  streaming. Reuse the main window's safe message renderer and its Markdown streaming
  handoff so persisted and in-progress replies match the main chat.
- `assistant-recent.tsx` — the `threads` list, newest first, each row calling
  `openThread(id)`. Shown when the active thread is empty.
- `assistant-app.tsx` — header (drag region, "Aiden", close), transcript or empty state with
  `ASSISTANT_SUGGESTED_PROMPTS` as clickable chips that call `send(prompt)`, then a compact
  composer: textarea, Enter to send, Shift+Enter for a newline, Stop button while
  streaming, and a disabled state with an explanatory line when `ready` is false.

Semantic tokens only. Verify every class against `renderer/styles.css`.

- [ ] **Step 7: Manual acceptance**

```bash
npm run dev
```

Press ⌘⌥A, click "Summarize my settings". Expected: a streamed reply that talks about the
app rather than offering to edit files. Send a second message — it continues the same
thread. Press ⌘⌥A twice to hide and reopen — the thread is still there. Confirm the main
window's sidebar does **not** list the Aiden thread.

- [ ] **Step 8: Register the test, run the phase gate, and commit**

Add `renderer/assistant/use-assistant-chat.test.ts` to the `test` script.

```bash
npm run type-check && npm run lint && npm run test
```

Expected: everything passes **except** `ipc-contract.test.ts`, which still fails on the
three unbroadcast `assistant:*` notifications until Task 19. Say so in the commit body.

```bash
git add renderer/assistant package.json
git commit -m "feat(assistant): add the Aiden window chat surface"
```

**Phase 1 checkpoint.** ⌘⌥A opens a working assistant chat with the Aiden persona, its own
thread list, and no folder tools. Stop here for review.

---

## Phase 2 — Settings section and tools

**Implementation checkpoint (2026-07-26):** Task 7's validated, full-config IPC is
implemented and reports whether macOS actually registered the requested shortcut. The
Settings sidebar now includes Aiden with the live shortcut controls plus truthful
model/access/background status. The proactivity controls originally listed in Task 8 stay
unexposed until the Task 12–19 engine exists; showing toggles that cannot affect runtime
would make Settings lie. Task 9 onward remains planned.

### Task 7: `AssistantConfig` parsing and IPC

**Files:**

- Create: `main/handlers/assistant-parse.ts`
- Create: `main/handlers/assistant-parse.test.ts`
- Modify: `main/handlers/assistant.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `AssistantConfig` (Task 4).
- Produces: `DEFAULT_ASSISTANT_CONFIG: AssistantConfig`,
  `assistantConfigFrom(settings: AppSettings): AssistantConfig`,
  `parseAssistantConfigPatch(current: AssistantConfig, patch: unknown): AssistantConfig`.
- Produces handlers `assistant:get-config` and `assistant:set-config`, both resolving to the
  full `AssistantConfig`.

- [ ] **Step 1: Write the failing test**

`main/handlers/assistant-parse.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ASSISTANT_CONFIG,
  assistantConfigFrom,
  parseAssistantConfigPatch,
} from "./assistant-parse.js";

test("proactivity is off by default and the pin is empty", () => {
  assert.equal(DEFAULT_ASSISTANT_CONFIG.enabled, false);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.providerId, undefined);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.model, undefined);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.settingsPermission, "ask");
  assert.equal(DEFAULT_ASSISTANT_CONFIG.pollIntervalMinutes, 30);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.maxNudgesPerDay, 5);
  assert.equal(DEFAULT_ASSISTANT_CONFIG.urgencyThreshold, 7);
});

test("fills defaults for a settings object that has never seen the assistant", () => {
  assert.deepEqual(assistantConfigFrom({}), DEFAULT_ASSISTANT_CONFIG);
});

test("ignores unknown keys and keeps current values for absent ones", () => {
  const next = parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, {
    enabled: true,
    nonsense: "x",
  });
  assert.equal(next.enabled, true);
  assert.equal(next.pollIntervalMinutes, 30);
  assert.equal("nonsense" in next, false);
});

test("clamps the cadence, threshold, cap, and urgency into range", () => {
  const next = parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, {
    pollIntervalMinutes: 1,
    untouchedThresholdDays: 0,
    maxNudgesPerDay: 9999,
    urgencyThreshold: 42,
  });
  assert.equal(next.pollIntervalMinutes, 5);
  assert.equal(next.untouchedThresholdDays, 1);
  assert.equal(next.maxNudgesPerDay, 50);
  assert.equal(next.urgencyThreshold, 10);
});

test("rejects a malformed quiet-hours time instead of storing it", () => {
  assert.throws(
    () => parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, { quietHoursStart: "25:00" }),
    /quiet hours/iu,
  );
  assert.equal(
    parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, { quietHoursStart: "09:30" })
      .quietHoursStart,
    "09:30",
  );
});

test("rejects an invalid settings permission", () => {
  assert.throws(
    () => parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, { settingsPermission: "root" }),
    /permission/iu,
  );
});

test("clears the model pin when it is explicitly emptied", () => {
  const pinned = parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, {
    providerId: "anthropic",
    model: "claude-haiku-4-5-20251001",
  });
  assert.equal(pinned.providerId, "anthropic");
  const cleared = parseAssistantConfigPatch(pinned, { providerId: "", model: "" });
  assert.equal(cleared.providerId, undefined);
  assert.equal(cleared.model, undefined);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/handlers/assistant-parse.test.ts
```

Expected: FAIL — cannot resolve `./assistant-parse.js`.

- [ ] **Step 3: Write the parser**

`main/handlers/assistant-parse.ts` — pure, no Electron import, in the spirit of
`main/handlers/scheduled-tasks-parse.ts`. It throws a user-readable `Error` for malformed
enums and times, and clamps numerics rather than throwing.

```ts
import type { AppSettings, AssistantConfig } from "../services/types.js";

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const PERMISSIONS = new Set(["full", "ask", "none"]);

export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  enabled: false,
  hotkeyEnabled: true,
  // Duplicated from DEFAULT_ASSISTANT_ACCELERATOR in services/shortcut.ts rather
  // than imported: that module pulls in Electron's globalShortcut, and this
  // parser must stay importable from a plain node:test run.
  hotkeyAccelerator: "Command+Alt+A",
  watchUncommitted: true,
  watchUntouchedProjects: true,
  watchConfigChanges: true,
  pollIntervalMinutes: 30,
  untouchedThresholdDays: 14,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  maxNudgesPerDay: 5,
  urgencyThreshold: 7,
  settingsPermission: "ask",
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function time(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !TIME.test(value)) {
    throw new Error(`Invalid quiet hours ${field}; use HH:MM.`);
  }
  return value;
}

/** Optional pin field: an explicit empty string clears it. */
function pin(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw new Error("Invalid assistant model pin.");
  return value.trim() || undefined;
}

export function assistantConfigFrom(settings: AppSettings): AssistantConfig {
  return parseAssistantConfigPatch(DEFAULT_ASSISTANT_CONFIG, settings.assistant ?? {});
}

export function parseAssistantConfigPatch(
  current: AssistantConfig,
  patch: unknown,
): AssistantConfig {
  const p = (patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {}) as Record<
    string,
    unknown
  >;
  if (p.settingsPermission !== undefined && !PERMISSIONS.has(String(p.settingsPermission))) {
    throw new Error("Invalid assistant settings permission.");
  }
  const accelerator =
    typeof p.hotkeyAccelerator === "string" && p.hotkeyAccelerator.trim()
      ? p.hotkeyAccelerator.trim()
      : current.hotkeyAccelerator;
  return {
    enabled: bool(p.enabled, current.enabled),
    hotkeyEnabled: bool(p.hotkeyEnabled, current.hotkeyEnabled),
    hotkeyAccelerator: accelerator,
    providerId: pin(p.providerId, current.providerId),
    model: pin(p.model, current.model),
    watchUncommitted: bool(p.watchUncommitted, current.watchUncommitted),
    watchUntouchedProjects: bool(p.watchUntouchedProjects, current.watchUntouchedProjects),
    watchConfigChanges: bool(p.watchConfigChanges, current.watchConfigChanges),
    pollIntervalMinutes:
      p.pollIntervalMinutes === undefined
        ? current.pollIntervalMinutes
        : clamp(p.pollIntervalMinutes, 5, 1440, current.pollIntervalMinutes),
    untouchedThresholdDays:
      p.untouchedThresholdDays === undefined
        ? current.untouchedThresholdDays
        : clamp(p.untouchedThresholdDays, 1, 365, current.untouchedThresholdDays),
    quietHoursEnabled: bool(p.quietHoursEnabled, current.quietHoursEnabled),
    quietHoursStart: time(p.quietHoursStart, "start", current.quietHoursStart),
    quietHoursEnd: time(p.quietHoursEnd, "end", current.quietHoursEnd),
    maxNudgesPerDay:
      p.maxNudgesPerDay === undefined
        ? current.maxNudgesPerDay
        : clamp(p.maxNudgesPerDay, 1, 50, current.maxNudgesPerDay),
    urgencyThreshold:
      p.urgencyThreshold === undefined
        ? current.urgencyThreshold
        : clamp(p.urgencyThreshold, 0, 10, current.urgencyThreshold),
    settingsPermission: (p.settingsPermission ??
      current.settingsPermission) as AssistantConfig["settingsPermission"],
  };
}
```

- [ ] **Step 4: Run the test**

```bash
npx tsx --test main/handlers/assistant-parse.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the config handlers**

In `main/handlers/assistant.ts`, importing `configStore`, the two parse functions, and
`applyShortcutFromSettings`:

```ts
ipcMain.handle("assistant:get-config", async () =>
  assistantConfigFrom(await configStore.getSettings()),
);

ipcMain.handle("assistant:set-config", async (_event, patch: unknown) => {
  const current = assistantConfigFrom(await configStore.getSettings());
  const assistant = parseAssistantConfigPatch(current, patch);
  await configStore.setSettings({ assistant });
  // The hotkey may have moved or been switched off.
  await applyShortcutFromSettings();
  return assistant;
});
```

Task 19 adds an `assistantTicker.restart()` call to this handler; leave a comment marking
the spot so it is not forgotten.

- [ ] **Step 6: Verify, register, and commit**

```bash
npx tsx --test main/handlers/assistant-parse.test.ts && npm run type-check
```

Expected: PASS. Register `main/handlers/assistant-parse.test.ts` in the `test` script.

```bash
git add main/handlers/assistant-parse.ts main/handlers/assistant-parse.test.ts main/handlers/assistant.ts package.json
git commit -m "feat(assistant): add AssistantConfig parsing and its IPC surface"
```

---

### Task 8: Aiden settings section

**Files:**

- Modify: `renderer/lib/settings-section.ts`
- Modify: `renderer/lib/settings-section.test.ts`
- Modify: `renderer/main/settings-view.tsx`
- Create: `renderer/components/settings/assistant-settings.tsx`

**Interfaces:**

- Consumes: `assistant:get-config` / `assistant:set-config` (Task 7).
- Produces: an `"assistant"` `SettingsSection` id and an `AssistantSettings` component.

- [ ] **Step 1: Add the section id and extend its test**

In `renderer/lib/settings-section.ts`, add `"assistant"` to `SETTINGS_SECTIONS` after
`"scheduledTasks"`. In `renderer/lib/settings-section.test.ts`, matching that file's
existing style:

```ts
test("parses the assistant section id", () => {
  assert.equal(parseSettingsSection("assistant"), "assistant");
});
```

- [ ] **Step 2: Run it**

```bash
npx tsx --test renderer/lib/settings-section.test.ts
```

Expected: PASS. `npm run type-check` now FAILS because `CONTENT` in `settings-view.tsx` is a
`Record<SettingsSection, …>` missing the new key — that is the compiler enforcing the next
step.

- [ ] **Step 3: Add the NAV and CONTENT entries**

In `renderer/main/settings-view.tsx`, add to `NAV` after the `scheduledTasks` entry:

```tsx
  {
    id: "assistant",
    title: "Aiden",
    icon: <Sparkles className="size-5" />,
    group: "Agent",
    keywords: "assistant proactive nudges reminders companion window notifications",
  },
```

Import `Sparkles` from `lucide-react` alongside the existing icons, and add
`assistant: AssistantSettings,` to `CONTENT`.

- [ ] **Step 4: Build the settings panel**

`renderer/components/settings/assistant-settings.tsx`, following the structure and component
vocabulary of `renderer/components/settings/scheduled-tasks-settings.tsx`:

- Master switch bound to `enabled`, with copy making clear proactivity is opt-in.
- A **model pin** row: provider + model selects, with an inline warning when `enabled` is
  true and the pin is empty — "Aiden needs its own model before it can watch in the
  background." Reuse `renderer/lib/model-picker-data.ts` rather than fetching provider lists
  directly.
- Hotkey row: enable toggle plus accelerator capture, reusing whatever
  `renderer/components/settings/shortcut-settings.tsx` uses (see `renderer/lib/accelerator.ts`).
- Watch toggles: uncommitted changes, untouched projects, configuration changes.
- Cadence: poll interval and untouched threshold as number inputs, with the Task 7 clamp
  ranges reflected as `min` / `max`.
- Anti-spam: quiet hours toggle plus two time inputs, daily cap, urgency threshold.
- Settings permission: the same three-way `full` / `ask` / `none` control the workspace
  permission UI uses.
- A **health row** placeholder reading "Watching: off"; Task 19 wires it to
  `assistant:get-state`.

Every value writes through a single `assistant:set-config` patch call and re-renders from
its return value.

- [ ] **Step 5: Verify and commit**

```bash
npm run type-check && npm run lint && npx tsx --test renderer/lib/settings-section.test.ts
```

Expected: PASS.

Manual: open Settings → Agent → Aiden. Toggle proactivity on without a pin; the warning
appears. Set a pin; it clears. Change the hotkey to ⌘⌥J and confirm ⌘⌥J opens the window and
⌘⌥A no longer does.

```bash
git add renderer/lib/settings-section.ts renderer/lib/settings-section.test.ts renderer/main/settings-view.tsx renderer/components/settings/assistant-settings.tsx
git commit -m "feat(assistant): add the Aiden settings section"
```

---

### Task 9: Settings tools

**Files:**

- Create: `main/services/assistant/settings-field-policy.ts`
- Create: `main/services/assistant/settings-field-policy.test.ts`
- Create: `main/services/assistant/settings-tools.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `ASSISTANT_MUTABLE_SETTING_FIELDS: ReadonlySet<string>`,
  `redactSettingsForAssistant(settings: AppSettings): Record<string, unknown>`,
  `assistantSettingPatch(field: string, value: unknown): Partial<AppSettings>`,
  `ASSISTANT_SET_SETTING_TOOL_NAME = "set_setting"`,
  `buildAssistantSettingsTools(deps: AssistantSettingsToolDeps): AgentTool[]` where

```ts
export interface AssistantSettingsToolDeps {
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
}
```

- [ ] **Step 1: Write the failing policy test**

`main/services/assistant/settings-field-policy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ASSISTANT_MUTABLE_SETTING_FIELDS,
  assistantSettingPatch,
  redactSettingsForAssistant,
} from "./settings-field-policy.js";

test("the whitelist excludes identity, provider, and appearance fields", () => {
  for (const forbidden of [
    "lastProviderId",
    "lastModel",
    "profileName",
    "appearance",
    "assistant",
    "computerUseEnabled",
  ]) {
    assert.equal(ASSISTANT_MUTABLE_SETTING_FIELDS.has(forbidden), false, forbidden);
  }
});

test("the whitelist covers the small, safe, reversible toggles", () => {
  for (const allowed of [
    "exaEnabled",
    "shortcutEnabled",
    "dictationEnabled",
    "scheduledTasksEnabled",
  ]) {
    assert.equal(ASSISTANT_MUTABLE_SETTING_FIELDS.has(allowed), true, allowed);
  }
});

test("redaction drops per-model history and the assistant's own block", () => {
  const redacted = redactSettingsForAssistant({
    lastProviderId: "anthropic",
    lastModel: "claude-opus-5",
    exaEnabled: true,
    anthropicThinkingByModel: { "claude-opus-5": "high" },
    assistant: { enabled: true },
  } as never);
  assert.equal("anthropicThinkingByModel" in redacted, false);
  assert.equal("assistant" in redacted, false);
  assert.equal(redacted.exaEnabled, true);
  // The current model is useful context and is not secret, but stays read-only.
  assert.equal(redacted.lastModel, "claude-opus-5");
});

test("rejects a field outside the whitelist", () => {
  assert.throws(() => assistantSettingPatch("profileName", "x"), /cannot change/iu);
});

test("rejects a value of the wrong type for a boolean field", () => {
  assert.throws(() => assistantSettingPatch("exaEnabled", "yes"), /true or false/iu);
});

test("builds a single-field patch for an allowed boolean", () => {
  assert.deepEqual(assistantSettingPatch("exaEnabled", false), { exaEnabled: false });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/settings-field-policy.test.ts
```

Expected: FAIL — cannot resolve `./settings-field-policy.js`.

- [ ] **Step 3: Write the policy module**

Keep the whitelist tiny and boolean-only: these are the settings a nudge conversation
plausibly needs to flip, and every one is reversible from the Settings UI. Anything that
changes which model runs, who the user is, or how the app looks stays out of tool reach.

Redaction drops the three per-model thinking maps (noisy, and not the assistant's business)
and the nested `assistant` block — the assistant must not read its own cadence, or it will
reason about self-scheduling.

- [ ] **Step 4: Run the test**

```bash
npx tsx --test main/services/assistant/settings-field-policy.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the tools**

`main/services/assistant/settings-tools.ts` — two `AgentTool`s in the style of
`main/services/tools.ts` (typebox `Type.Object`, `execute` returning
`{ content: [{ type: "text", text }], details: null }`):

- `get_settings` — no parameters; returns
  `JSON.stringify(redactSettingsForAssistant(await deps.getSettings()))`.
- `set_setting` — `Type.Object({ field: Type.String(...), value: Type.Boolean(...) })`;
  builds the patch with `assistantSettingPatch` and applies it through `deps.setSettings`.

Approval is **not** implemented inside the tool: it is enforced generically by the
`beforeToolCall` hook in `llm-client.ts`, which Task 11 extends. Say so in a comment so a
later reader does not add a second approval path.

- [ ] **Step 6: Verify, register, and commit**

```bash
npm run type-check && npx tsx --test main/services/assistant/settings-field-policy.test.ts
```

Register the test in the `test` script.

```bash
git add main/services/assistant/settings-field-policy.ts main/services/assistant/settings-field-policy.test.ts main/services/assistant/settings-tools.ts package.json
git commit -m "feat(assistant): add the settings read and write tools"
```

---

### Task 10: Project status tools

**Files:**

- Create: `main/services/assistant/project-tools.ts`
- Create: `main/services/assistant/project-tools.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `summarizeProject(workspace: Workspace, git: GitInfo, now: number): ProjectSummary`
  and `buildAssistantProjectTools(deps: AssistantProjectToolDeps): AgentTool[]` where

```ts
export interface ProjectSummary {
  id: string;
  name: string;
  hasFolder: boolean;
  isRepo: boolean;
  branch?: string;
  uncommitted: number;
  ahead: number;
  behind: number;
  daysSinceTouched: number;
}

export interface AssistantProjectToolDeps {
  listWorkspaces(): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  gitInfo(folderPath: string): Promise<GitInfo>;
  now(): number;
}
```

- [ ] **Step 1: Write the failing test**

`main/services/assistant/project-tools.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProject } from "./project-tools.js";

const DAY = 86_400_000;
const now = 1_700_000_000_000;

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "w1",
    name: "aiden-agent",
    folderPath: "/Users/x/aiden-agent",
    permission: "ask" as const,
    createdAt: now - 30 * DAY,
    updatedAt: now - 3 * DAY,
    ...overrides,
  };
}

test("summarizes a dirty repository", () => {
  const summary = summarizeProject(
    workspace(),
    { isRepo: true, branch: "main", uncommitted: 12, ahead: 2, behind: 0 },
    now,
  );
  assert.deepEqual(summary, {
    id: "w1",
    name: "aiden-agent",
    hasFolder: true,
    isRepo: true,
    branch: "main",
    uncommitted: 12,
    ahead: 2,
    behind: 0,
    daysSinceTouched: 3,
  });
});

test("treats missing git counters as zero rather than undefined", () => {
  const summary = summarizeProject(workspace(), { isRepo: true, branch: "main" }, now);
  assert.equal(summary.uncommitted, 0);
  assert.equal(summary.ahead, 0);
  assert.equal(summary.behind, 0);
});

test("reports a folderless workspace without claiming it is a repository", () => {
  const summary = summarizeProject(workspace({ folderPath: undefined }), { isRepo: false }, now);
  assert.equal(summary.hasFolder, false);
  assert.equal(summary.isRepo, false);
  assert.equal(summary.branch, undefined);
});

test("floors the touched age so a workspace touched minutes ago reads as today", () => {
  assert.equal(
    summarizeProject(workspace({ updatedAt: now - 600_000 }), { isRepo: false }, now)
      .daysSinceTouched,
    0,
  );
});

test("never reports a negative age when the clock moved backwards", () => {
  assert.equal(
    summarizeProject(workspace({ updatedAt: now + DAY }), { isRepo: false }, now).daysSinceTouched,
    0,
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/project-tools.test.ts
```

Expected: FAIL — cannot resolve `./project-tools.js`.

- [ ] **Step 3: Write the module**

`summarizeProject` is pure. `buildAssistantProjectTools` wraps it in two read-only
`AgentTool`s (neither needs approval):

- `list_projects` — no parameters; maps every workspace through `summarizeProject`, calling
  `deps.gitInfo` only when `folderPath` is set, each call in its own try/catch so one bad
  folder cannot fail the whole list.
- `get_project_status` — `Type.Object({ projectId: Type.String(...) })`; one workspace, the
  same summary plus `upstream` and `defaultBranch` from `GitInfo`.

- [ ] **Step 4: Run the test, register it, and commit**

```bash
npx tsx --test main/services/assistant/project-tools.test.ts && npm run type-check
```

Expected: PASS. Add the test to the `test` script.

```bash
git add main/services/assistant/project-tools.ts main/services/assistant/project-tools.test.ts package.json
git commit -m "feat(assistant): add the project listing and status tools"
```

---

### Task 11: Wire assistant tools into generation

**Files:**

- Modify: `main/services/tools.ts:138-208`
- Modify: `main/services/llm-client.ts` (tool-context construction, `beforeToolCall`)

**Interfaces:**

- Consumes: `buildAssistantSettingsTools` and `ASSISTANT_SET_SETTING_TOOL_NAME` (Task 9),
  `buildAssistantProjectTools` (Task 10).
- Produces: `ToolContext.mode?: "assistant"`.

- [ ] **Step 1: Add `mode` to `ToolContext`**

In `main/services/tools.ts`, on the `ToolContext` interface:

```ts
  /**
   * "assistant" swaps the workspace tool set for the Aiden tools: app settings
   * and project status, no folder access, no scheduling, no connectors.
   */
  mode?: "assistant";
```

- [ ] **Step 2: Branch `buildAgentTools`**

Immediately after `const settings = await configStore.getSettings();` in `buildAgentTools`,
return the assistant set early:

```ts
if (ctx.mode === "assistant") {
  // No folder tools (no workspaceRoot is passed), no scheduling tools (an
  // assistant run must not create schedules), and no MCP tools (unknown
  // mutation semantics in a window with no approval affordance for them).
  return [
    ...buildAssistantSettingsTools({
      getSettings: () => configStore.getSettings(),
      setSettings: (patch) => configStore.setSettings(patch),
    }),
    ...buildAssistantProjectTools({
      listWorkspaces: () => configStore.listWorkspaces(),
      getWorkspace: (id) => configStore.getWorkspace(id),
      gitInfo,
      now: Date.now,
    }),
  ];
}
```

Import `gitInfo` from `./git.js` and the two builders.

- [ ] **Step 3: Pass the mode from the generation**

In `main/services/llm-client.ts`, where the `ToolContext` is built for `buildAgentTools`,
add:

```ts
        mode:
          params.mode === "assistant" || params.mode === "assistant-unattended"
            ? "assistant"
            : undefined,
        allowScheduling: params.mode === undefined && ctxAllowScheduling,
        allowMcpTools: params.mode === undefined && ctxAllowMcpTools,
```

Read the surrounding code first and adapt the two existing expressions rather than
inventing `ctxAllowScheduling` / `ctxAllowMcpTools` names — the point is that assistant runs
set both to `false` explicitly, so the guarantee does not rest solely on the early return.

- [ ] **Step 4: Make `set_setting` respect the approval posture**

In the `beforeToolCall` hook (`main/services/llm-client.ts:566`), read how it currently
chooses between block, approve, and pass for `APPROVAL_TOOL_NAMES`, then add a branch for
`ASSISTANT_SET_SETTING_TOOL_NAME`:

- `settings.assistant?.settingsPermission === "none"` → block, with the reason "Aiden is not
  allowed to change settings."
- `"ask"` (the default) → request approval through the same `ToolApprovalCoordinator` path,
  with a summary of the form `Change setting: exaEnabled → false`.
- `"full"` → pass through.

Leave `APPROVAL_TOOL_NAMES` in `coding-tools.ts` alone: it means "folder-mutating", and
widening it would change scheduled-task behaviour too.

- [ ] **Step 5: Manual acceptance**

```bash
npm run dev
```

With Aiden's settings permission at "ask", open the Aiden window and say "turn off web
search". Expected: an approval prompt appears in the Aiden window; approving applies it and
Settings → Web Search reflects the change; denying leaves it alone and the assistant says
so. Set the permission to "none" and repeat — the assistant explains it cannot change
settings. Ask "any uncommitted changes?" — it calls `list_projects` and answers from real
git state. Ask it to "read src/index.ts" — it has no such tool and says so.

- [ ] **Step 6: Phase gate and commit**

```bash
npm run type-check && npm run lint && npm run test
```

Expected: green except the known `ipc-contract.test.ts` notification failure.

```bash
git add main/services/tools.ts main/services/llm-client.ts
git commit -m "feat(assistant): gate the assistant tool set behind assistant mode"
```

**Phase 2 checkpoint.** Aiden can read and change a small whitelist of settings with
approvals, and report real project status. Stop here for review.

---

## Phase 3 — Proactivity

### Task 12: Strict `[SILENT]` parser

**Files:**

- Create: `main/services/assistant/silent-parser.ts`
- Create: `main/services/assistant/silent-parser.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: `isSilentResponse(response: string): boolean`.

- [ ] **Step 1: Write the failing test**

This is its own module because of the hermes regression history: substring matching both
leaks (a nudge that merely quotes the marker gets swallowed) and over-swallows.

`main/services/assistant/silent-parser.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isSilentResponse } from "./silent-parser.js";

test("treats a bare marker as silence, with any surrounding whitespace", () => {
  assert.equal(isSilentResponse("[SILENT]"), true);
  assert.equal(isSilentResponse("  [SILENT]\n\n"), true);
  assert.equal(isSilentResponse("[silent]"), true);
});

test("treats the marker alone on the first or last line as silence", () => {
  assert.equal(isSilentResponse("[SILENT]\nNothing worth saying."), true);
  assert.equal(isSilentResponse("Nothing worth saying.\n[SILENT]"), true);
});

test("an empty or whitespace-only response is silence", () => {
  assert.equal(isSilentResponse(""), true);
  assert.equal(isSilentResponse("   \n\t "), true);
});

test("a mid-sentence mention is NOT silence and must be delivered", () => {
  assert.equal(isSilentResponse("You asked me to stay [SILENT] unless it matters."), false);
  assert.equal(isSilentResponse("Line one\nI considered [SILENT] here\nLine three"), false);
});

test("a marker with trailing prose on the same line is NOT silence", () => {
  assert.equal(isSilentResponse("[SILENT] but here is a thought"), false);
  assert.equal(isSilentResponse("nothing to report [SILENT]"), false);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/silent-parser.test.ts
```

Expected: FAIL — cannot resolve `./silent-parser.js`.

- [ ] **Step 3: Write the parser**

```ts
// The [SILENT] contract for unattended assistant runs. Deliberately strict: the
// marker counts only as an entire trimmed response, or as the whole of the first
// or last line. Substring matching is the known failure mode — it swallows real
// nudges that merely mention the marker.

const MARKER = /^\[silent\]$/iu;

export function isSilentResponse(response: string): boolean {
  const trimmed = response.trim();
  if (!trimmed) return true;
  if (MARKER.test(trimmed)) return true;
  const lines = trimmed.split(/\r?\n/u).map((line) => line.trim());
  const first = lines[0] ?? "";
  const last = lines[lines.length - 1] ?? "";
  return MARKER.test(first) || MARKER.test(last);
}
```

- [ ] **Step 4: Run, register, commit**

```bash
npx tsx --test main/services/assistant/silent-parser.test.ts
```

Expected: PASS. Register in the `test` script.

```bash
git add main/services/assistant/silent-parser.ts main/services/assistant/silent-parser.test.ts package.json
git commit -m "feat(assistant): add the strict [SILENT] response parser"
```

---

### Task 13: Nudge policy

**Files:**

- Create: `main/services/assistant/nudge-policy.ts`
- Create: `main/services/assistant/nudge-policy.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces:

```ts
/** A mechanically collected candidate, before any model has judged it. */
export interface NudgeCandidate {
  dedupKey: string;
  kind: NudgeKind;
  title: string;
  body: string;
}

export interface PolicyClock {
  now: number;
  /** Local minutes past midnight, 0–1439. */
  localMinutes: number;
  /** Local date key, "YYYY-MM-DD". */
  localDate: string;
}

export const MAX_PENDING_NUDGES = 5;

export function isWithinQuietHours(config: AssistantConfig, clock: PolicyClock): boolean;
export function filterCandidates(
  candidates: readonly NudgeCandidate[],
  nudges: readonly NudgeRecord[],
  clock: PolicyClock,
): NudgeCandidate[];
export function canDeliver(
  config: AssistantConfig,
  nudges: readonly NudgeRecord[],
  clock: PolicyClock,
): { allowed: boolean; reason?: "quiet-hours" | "daily-cap" };
export function isBacklogFull(nudges: readonly NudgeRecord[]): boolean;
export function shouldDeferFirstRun(
  config: AssistantConfig,
  lastRunAt: number | undefined,
  now: number,
): boolean;
```

- [ ] **Step 1: Write the failing test**

`main/services/assistant/nudge-policy.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PENDING_NUDGES,
  canDeliver,
  filterCandidates,
  isBacklogFull,
  isWithinQuietHours,
  shouldDeferFirstRun,
} from "./nudge-policy.js";
import { DEFAULT_ASSISTANT_CONFIG } from "../../handlers/assistant-parse.js";
import type { NudgeRecord } from "../types.js";

const MINUTE = 60_000;
const now = 1_700_000_000_000;
const clock = { now, localMinutes: 10 * 60, localDate: "2026-07-25" };

function record(overrides: Partial<NudgeRecord>): NudgeRecord {
  return {
    id: "n1",
    dedupKey: "uncommitted:w1",
    kind: "uncommitted",
    title: "Uncommitted work",
    body: "12 files",
    status: "pending",
    urgency: 8,
    createdAt: now - MINUTE,
    ...overrides,
  };
}

test("quiet hours that do not cross midnight", () => {
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    quietHoursEnabled: true,
    quietHoursStart: "09:00",
    quietHoursEnd: "17:00",
  };
  assert.equal(isWithinQuietHours(config, { ...clock, localMinutes: 10 * 60 }), true);
  assert.equal(isWithinQuietHours(config, { ...clock, localMinutes: 8 * 60 }), false);
  assert.equal(isWithinQuietHours(config, { ...clock, localMinutes: 17 * 60 }), false);
});

test("quiet hours that cross midnight cover both sides of it", () => {
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    quietHoursEnabled: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
  };
  assert.equal(isWithinQuietHours(config, { ...clock, localMinutes: 23 * 60 }), true);
  assert.equal(isWithinQuietHours(config, { ...clock, localMinutes: 2 * 60 }), true);
  assert.equal(isWithinQuietHours(config, { ...clock, localMinutes: 12 * 60 }), false);
});

test("disabled quiet hours are never quiet", () => {
  assert.equal(isWithinQuietHours(DEFAULT_ASSISTANT_CONFIG, clock), false);
});

test("a dismissed dedupKey is latched forever", () => {
  const filtered = filterCandidates(
    [{ dedupKey: "uncommitted:w1", kind: "uncommitted", title: "t", body: "b" }],
    [record({ status: "dismissed", createdAt: now - 400 * 24 * 60 * MINUTE })],
    clock,
  );
  assert.deepEqual(filtered, []);
});

test("a snoozed candidate returns once the snooze expires", () => {
  const candidate = {
    dedupKey: "uncommitted:w1",
    kind: "uncommitted" as const,
    title: "t",
    body: "b",
  };
  assert.deepEqual(
    filterCandidates(
      [candidate],
      [record({ status: "snoozed", snoozeUntil: now + MINUTE })],
      clock,
    ),
    [],
  );
  assert.deepEqual(
    filterCandidates(
      [candidate],
      [record({ status: "snoozed", snoozeUntil: now - MINUTE })],
      clock,
    ),
    [candidate],
  );
});

test("an already-pending or already-delivered candidate is not duplicated", () => {
  const candidate = {
    dedupKey: "uncommitted:w1",
    kind: "uncommitted" as const,
    title: "t",
    body: "b",
  };
  assert.deepEqual(filterCandidates([candidate], [record({ status: "pending" })], clock), []);
  assert.deepEqual(filterCandidates([candidate], [record({ status: "delivered" })], clock), []);
});

test("an unseen candidate survives filtering", () => {
  const candidate = { dedupKey: "untouched:w2", kind: "untouched" as const, title: "t", body: "b" };
  assert.deepEqual(filterCandidates([candidate], [record({})], clock), [candidate]);
});

test("the daily cap counts only nudges delivered on the same local date", () => {
  const config = { ...DEFAULT_ASSISTANT_CONFIG, maxNudgesPerDay: 2 };
  const delivered = [
    record({ id: "a", status: "delivered", deliveredAt: now }),
    record({ id: "b", status: "delivered", deliveredAt: now }),
  ];
  assert.deepEqual(canDeliver(config, delivered, clock), { allowed: false, reason: "daily-cap" });
  assert.equal(canDeliver(config, delivered, { ...clock, localDate: "2026-07-26" }).allowed, true);
});

test("quiet hours block delivery and report themselves distinctly", () => {
  const config = {
    ...DEFAULT_ASSISTANT_CONFIG,
    quietHoursEnabled: true,
    quietHoursStart: "09:00",
    quietHoursEnd: "17:00",
  };
  assert.deepEqual(canDeliver(config, [], clock), { allowed: false, reason: "quiet-hours" });
});

test("the backlog cap is reached at five pending records", () => {
  const pending = Array.from({ length: MAX_PENDING_NUDGES }, (_value, index) =>
    record({ id: `n${index}`, dedupKey: `k${index}` }),
  );
  assert.equal(isBacklogFull(pending), true);
  assert.equal(isBacklogFull(pending.slice(1)), false);
});

test("the first run is deferred by a full interval after enabling", () => {
  const config = { ...DEFAULT_ASSISTANT_CONFIG, pollIntervalMinutes: 30 };
  assert.equal(shouldDeferFirstRun(config, now, now + 29 * MINUTE), true);
  assert.equal(shouldDeferFirstRun(config, now, now + 30 * MINUTE), false);
  // An unseeded store must defer rather than fire immediately.
  assert.equal(shouldDeferFirstRun(config, undefined, now), true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/nudge-policy.test.ts
```

Expected: FAIL — cannot resolve `./nudge-policy.js`.

- [ ] **Step 3: Write the policy module**

Pure functions only — no `Date.now()` inside. The caller supplies `PolicyClock`, which is
what makes every case above deterministic. Quiet hours compare minutes-past-midnight and
handle the wrapping window (`start > end`) explicitly. `filterCandidates` drops any
candidate whose `dedupKey` matches a record that is `dismissed`, `pending`, `delivered`, or
`snoozed` with `snoozeUntil > now`.

On `shouldDeferFirstRun(config, undefined, now)` returning `true`: the ticker seeds
`lastRunAt = now` the moment proactivity is enabled, so `undefined` only arises on a fresh
or hand-cleared store — exactly where firing immediately would be the barrage this rule
exists to prevent.

- [ ] **Step 4: Run, register, commit**

```bash
npx tsx --test main/services/assistant/nudge-policy.test.ts && npm run type-check
```

Expected: PASS. Register the test.

```bash
git add main/services/assistant/nudge-policy.ts main/services/assistant/nudge-policy.test.ts package.json
git commit -m "feat(assistant): add nudge latching, quiet hours, and cap policy"
```

---

### Task 14: Assistant state store

**Files:**

- Create: `main/services/assistant/assistant-store.ts`
- Create: `main/services/assistant/assistant-store.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `DataStore` (`main/services/data-store.ts`), `NudgeRecord`, `AssistantState`,
  `MAX_PENDING_NUDGES` (Task 13).
- Produces: `normalizeAssistantState(value: unknown): AssistantState`,
  `createAssistantStore(persistence: Persistence<AssistantState>, now?: () => number)`
  returning
  `{ load, recordTick, recordSuccess, recordError, seedFirstRun, addNudges, markDelivered, dismiss, snooze, ensureChatId, setSettingsSnapshot }`,
  and the module singleton `assistantStore` with `export type AssistantStore`.
- `Persistence<T>` matches the local interface `schedule-store.ts:17` declares:
  `{ load(): Promise<T>; update<R>(mutation: (draft: T) => R | Promise<R>): Promise<R> }`.

- [ ] **Step 1: Write the failing test**

`main/services/assistant/assistant-store.test.ts`. Follow
`main/services/schedule-store.test.ts` for the in-memory persistence double. One test per
case, all of them:

- `normalizeAssistantState` returns the empty default for `null`, a string, an array, and
  `{ nudges: "no" }`, and drops individual malformed records while keeping valid ones.
- `addNudges` refuses to exceed `MAX_PENDING_NUDGES`, dropping the overflow rather than
  evicting an existing pending record.
- `dismiss(id)` sets `status: "dismissed"` and **retains** the record — the records are the
  dedup memory, so a dismiss must never delete.
- `snooze(id, until)` sets `status: "snoozed"` and `snoozeUntil`.
- `markDelivered(id, chatId)` sets `status`, `deliveredAt`, and `chatId`.
- `recordTick` / `recordSuccess` / `recordError` set `lastTickAt` / `lastSuccessAt` /
  `lastError`, and a success clears `lastError`.
- `ensureChatId` creates exactly once under two concurrent callers and returns the same id to
  both — mirror the `chatClaims` test in `schedule-store.test.ts`.
- `seedFirstRun` sets `lastRunAt` only when it is currently unset.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/assistant-store.test.ts
```

Expected: FAIL — cannot resolve `./assistant-store.js`.

- [ ] **Step 3: Write the store**

Mirror `schedule-store.ts`: a `createAssistantStore(persistence, now)` factory that is pure
apart from the injected persistence, with the module singleton at the bottom:

```ts
const persistence = new DataStore<AssistantState>("assistant-state.json", { nudges: [] });

export const assistantStore = createAssistantStore(persistence);
export type AssistantStore = ReturnType<typeof createAssistantStore>;
```

`assistant-state.json` is machine-local regenerable state, so it belongs in `userData` (the
`DataStore` default root) and **not** in the portable Aiden config directory. It does not set
`preserveCorruptFile` — it is not a file the user hand-edits.

- [ ] **Step 4: Run, register, commit**

```bash
npx tsx --test main/services/assistant/assistant-store.test.ts && npm run type-check
```

Expected: PASS. Register the test.

```bash
git add main/services/assistant/assistant-store.ts main/services/assistant/assistant-store.test.ts package.json
git commit -m "feat(assistant): add the assistant nudge and health store"
```

---

### Task 15: Signal collectors

**Files:**

- Create: `main/services/assistant/signals.ts`
- Create: `main/services/assistant/signals.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `NudgeCandidate` (Task 13), `ProjectSummary` and `summarizeProject` (Task 10).
- Produces:

```ts
export interface SignalDeps {
  listWorkspaces(): Promise<Workspace[]>;
  gitInfo(folderPath: string): Promise<GitInfo>;
  getSettings(): Promise<AppSettings>;
  now(): number;
}

export function collectSignals(
  config: AssistantConfig,
  previousSnapshot: Record<string, unknown> | undefined,
  deps: SignalDeps,
): Promise<{ candidates: NudgeCandidate[]; snapshot: Record<string, unknown> }>;

/** Exported for direct testing. */
export function uncommittedCandidate(summary: ProjectSummary): NudgeCandidate | undefined;
export function untouchedCandidate(
  summary: ProjectSummary,
  thresholdDays: number,
): NudgeCandidate | undefined;
export function configDriftCandidates(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>,
): NudgeCandidate[];
export function settingsSnapshot(settings: AppSettings): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing test**

`main/services/assistant/signals.test.ts`, covering the three collectors as pure functions:

- `uncommittedCandidate` returns `undefined` for a clean repo, a non-repo, and a folderless
  workspace; returns a candidate with `dedupKey` `uncommitted:<workspaceId>` for a dirty one,
  whose `body` mentions the file count and the branch.
- `untouchedCandidate` returns `undefined` below the threshold and at threshold minus one,
  and a candidate at the threshold and beyond, with `dedupKey` `untouched:<workspaceId>`.
- `configDriftCandidates` returns `[]` for an undefined previous snapshot (the first run
  establishes the baseline; it must never nudge that "everything changed"), `[]` for an
  identical snapshot, and one candidate naming the changed key when a watched key changes.
  Include a case proving a key absent from the snapshot produces nothing.
- `settingsSnapshot` includes only the keys drift cares about and excludes the nested
  `assistant` block — otherwise every settings change Aiden itself makes nudges about
  itself.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/signals.test.ts
```

Expected: FAIL — cannot resolve `./signals.js`.

- [ ] **Step 3: Write the collectors**

Mechanical and deterministic — no model involvement. `collectSignals` respects the three
`watch*` toggles, skips workspaces with no `folderPath`, and wraps each `gitInfo` call in its
own try/catch so one unreadable repository cannot fail the tick. `gitInfo` is argv-only and
cached (`main/services/git.ts:964`), so polling every workspace on a 30-minute cadence is
cheap.

- [ ] **Step 4: Run, register, commit**

```bash
npx tsx --test main/services/assistant/signals.test.ts && npm run type-check
```

Expected: PASS. Register the test.

```bash
git add main/services/assistant/signals.ts main/services/assistant/signals.test.ts package.json
git commit -m "feat(assistant): add the mechanical nudge signal collectors"
```

---

### Task 16: Usage attribution and idle gating

**Files:**

- Modify: `main/services/usage-store-core.ts:8,67`
- Modify: `main/services/usage-store-core.test.ts`
- Modify: `main/services/llm-client.ts` (add `hasActiveGenerations`)

**Interfaces:**

- Produces: `UsageRequestSource` gains `"assistant"`;
  `llmClient.hasActiveGenerations(): boolean`.

- [ ] **Step 1: Extend the usage source and its test**

In `main/services/usage-store-core.ts`:

```ts
export type UsageRequestSource =
  | "chat"
  | "chat-title"
  | "voice-transcription"
  | "scheduled"
  | "assistant";
```

and add `"assistant"` to the `REQUEST_SOURCES` set at line 67. Then add to
`main/services/usage-store-core.test.ts` a case asserting a bucket with
`source: "assistant"` survives normalization, and one asserting an unknown source is still
rejected. Reuse the file's existing bucket fixture rather than inventing a new shape.

- [ ] **Step 2: Run the usage test**

```bash
npx tsx --test main/services/usage-store-core.test.ts
```

Expected: PASS.

- [ ] **Step 3: Add the global generation check**

In `main/services/llm-client.ts`, next to `isChatBusy` (line 928):

```ts
  /**
   * True when any generation is initializing or running. The assistant's
   * proactive ticker uses this as an idle gate: a background decision call must
   * never compete with a response the user is watching.
   */
  hasActiveGenerations(): boolean {
    return initializing.size > 0 || active.size > 0;
  },
```

- [ ] **Step 4: Verify and commit**

```bash
npm run type-check && npx tsx --test main/services/usage-store-core.test.ts
git add main/services/usage-store-core.ts main/services/usage-store-core.test.ts main/services/llm-client.ts
git commit -m "feat(assistant): attribute assistant usage and expose an idle gate"
```

---

### Task 17: Decision call

**Files:**

- Create: `main/services/assistant/decide-parse.ts`
- Create: `main/services/assistant/decide-parse.test.ts`
- Create: `main/services/assistant/decide.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `isSilentResponse` (Task 12), `NudgeCandidate` (Task 13),
  `"assistant-unattended"` mode (Task 5), `"assistant"` usage source (Task 16),
  `ASSISTANT_WORKSPACE_ID` (Task 2).
- Produces:

```ts
// decide-parse.ts — pure
export interface UrgencyVerdict {
  dedupKey: string;
  urgency: number;
  title: string;
  body: string;
}
export function buildDecisionPrompt(candidates: readonly NudgeCandidate[]): string;
export function parseUrgencyVerdicts(
  response: string,
  candidates: readonly NudgeCandidate[],
): UrgencyVerdict[];

// decide.ts — impure
export interface DecisionResult {
  silent: boolean;
  verdicts: UrgencyVerdict[];
}
export function decideNudges(
  candidates: readonly NudgeCandidate[],
  config: AssistantConfig,
): Promise<DecisionResult>;
```

- [ ] **Step 1: Write the failing parse test**

`main/services/assistant/decide-parse.test.ts`:

````ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildDecisionPrompt, parseUrgencyVerdicts } from "./decide-parse.js";
import type { NudgeCandidate } from "./nudge-policy.js";

const candidates: NudgeCandidate[] = [
  { dedupKey: "uncommitted:w1", kind: "uncommitted", title: "Uncommitted work", body: "12 files" },
  { dedupKey: "untouched:w2", kind: "untouched", title: "Untouched", body: "21 days" },
];

test("the prompt names every candidate's dedupKey so verdicts can be matched back", () => {
  const prompt = buildDecisionPrompt(candidates);
  assert.match(prompt, /uncommitted:w1/u);
  assert.match(prompt, /untouched:w2/u);
  assert.match(prompt, /\b0\b[\s\S]*\b10\b/u);
});

test("parses a well-formed JSON array of verdicts", () => {
  const verdicts = parseUrgencyVerdicts(
    JSON.stringify([
      { dedupKey: "uncommitted:w1", urgency: 8, title: "Uncommitted work", body: "12 files" },
    ]),
    candidates,
  );
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]?.urgency, 8);
});

test("parses JSON wrapped in a fenced code block", () => {
  const verdicts = parseUrgencyVerdicts(
    '```json\n[{"dedupKey":"untouched:w2","urgency":3,"title":"t","body":"b"}]\n```',
    candidates,
  );
  assert.equal(verdicts[0]?.dedupKey, "untouched:w2");
});

test("drops a verdict whose dedupKey was never a candidate", () => {
  const verdicts = parseUrgencyVerdicts(
    JSON.stringify([{ dedupKey: "invented:w9", urgency: 10, title: "t", body: "b" }]),
    candidates,
  );
  assert.deepEqual(verdicts, []);
});

test("clamps out-of-range urgency and drops non-numeric urgency", () => {
  const verdicts = parseUrgencyVerdicts(
    JSON.stringify([
      { dedupKey: "uncommitted:w1", urgency: 99, title: "t", body: "b" },
      { dedupKey: "untouched:w2", urgency: "high", title: "t", body: "b" },
    ]),
    candidates,
  );
  assert.deepEqual(
    verdicts.map((verdict) => [verdict.dedupKey, verdict.urgency]),
    [["uncommitted:w1", 10]],
  );
});

test("returns nothing for unparseable output rather than inventing urgency", () => {
  assert.deepEqual(parseUrgencyVerdicts("I think the first one matters most.", candidates), []);
  assert.deepEqual(parseUrgencyVerdicts("", candidates), []);
});

test("falls back to the candidate's own title and body when the model omits them", () => {
  const verdicts = parseUrgencyVerdicts(
    JSON.stringify([{ dedupKey: "uncommitted:w1", urgency: 9 }]),
    candidates,
  );
  assert.equal(verdicts[0]?.title, "Uncommitted work");
  assert.equal(verdicts[0]?.body, "12 files");
});
````

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/decide-parse.test.ts
```

Expected: FAIL — cannot resolve `./decide-parse.js`.

- [ ] **Step 3: Write the pure parse module**

`buildDecisionPrompt` emits the candidates as a JSON array and asks for a JSON array of
`{ dedupKey, urgency, title, body }` back, urgency 0–10, instructing the model to omit
anything not worth interrupting for. `parseUrgencyVerdicts` strips an optional fenced code
block, `JSON.parse`s inside a try/catch, keeps only entries whose `dedupKey` matches a
supplied candidate, clamps urgency to 0–10, drops non-numeric urgency, and falls back to the
candidate's own `title` / `body`.

- [ ] **Step 4: Run the test**

```bash
npx tsx --test main/services/assistant/decide-parse.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the decision runner**

`main/services/assistant/decide.ts`. Copy the background-owner shape from
`main/services/schedule-execution.ts:17-45` — a `ChatGenerationOwner` with `id: 0`, a
`documentId` of `` `assistant:${streamId}` ``, and a terminal promise settled by `chat:done`
/ `chat:error`. Then:

```ts
export async function decideNudges(
  candidates: readonly NudgeCandidate[],
  config: AssistantConfig,
): Promise<DecisionResult> {
  // Fail closed: an unattended run never picks a model on the user's behalf.
  if (!config.providerId || !config.model) {
    throw new Error(
      "Aiden needs its own provider and model before it can watch in the background.",
    );
  }
  const provider =
    (await providerRegistry.selectionProvider(config.providerId)) ??
    (await configStore.getProvider(config.providerId));
  if (!provider) throw new Error("Aiden's pinned provider no longer exists.");
  // Then: create a scratch chat, run llmClient.start with
  //   { chatId, workspaceId: ASSISTANT_WORKSPACE_ID, providerId: config.providerId,
  //     model: config.model, mode: "assistant-unattended",
  //     messages: [{ role: "user", content: buildDecisionPrompt(candidates) }] }
  // and options
  //   { permission: "none", allowComputerUse: false, allowMcpTools: false,
  //     usageSource: "assistant" }
  // await the terminal payload, then:
  //   if (isSilentResponse(content)) return { silent: true, verdicts: [] };
  //   return { silent: false, verdicts: parseUrgencyVerdicts(content, candidates) };
}
```

Two deliberate choices to preserve: the decision call is pure judgment, so
`permission: "none"` with no `workspaceRoot` gives it no tools at all; and it runs in a
scratch chat rather than the delivery thread — that thread receives the finished nudge, not
the model's raw scoring.

- [ ] **Step 6: Verify, register, and commit**

```bash
npm run type-check && npx tsx --test main/services/assistant/decide-parse.test.ts
```

Register `main/services/assistant/decide-parse.test.ts` in the `test` script.

```bash
git add main/services/assistant/decide.ts main/services/assistant/decide-parse.ts main/services/assistant/decide-parse.test.ts package.json
git commit -m "feat(assistant): add the urgency decision call and its parser"
```

---

### Task 18: Delivery

**Files:**

- Create: `main/services/assistant/deliver.ts`
- Create: `main/services/assistant/nudge-notification.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `assistantStore` (Task 14), `showAssistantWindow` (Task 4),
  `ASSISTANT_WORKSPACE_ID` (Task 2).
- Produces:

```ts
export interface NudgeNotificationDeps {
  isSupported(): boolean;
  create(options: { title: string; body: string }): {
    on(event: "click", listener: () => void): unknown;
    show(): void;
  };
  openThread(chatId: string): void | Promise<void>;
}

/** Dependency-injected, like showScheduledNotification. */
export function showNudgeNotification(
  nudge: NudgeRecord,
  dependencies: NudgeNotificationDeps,
): boolean;

export function deliverNudge(nudge: NudgeRecord): Promise<void>;
```

- [ ] **Step 1: Write the failing notification test**

`main/services/assistant/nudge-notification.test.ts`, modeled on
`main/services/schedule-notification.test.ts` (a fake `create` returning a recording stub).
Cover: returns `false` and shows nothing when `isSupported()` is false; shows with the
nudge's title and a whitespace-collapsed body truncated to 120 characters; registers a click
listener that calls `openThread` with the nudge's `chatId`; registers no click listener when
`chatId` is absent.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/nudge-notification.test.ts
```

Expected: FAIL — cannot resolve `./deliver.js`.

- [ ] **Step 3: Write delivery**

`showNudgeNotification` mirrors `showScheduledNotification` exactly — same body cleaning,
same click wiring. `deliverNudge`:

1. `assistantStore.ensureChatId(() => chatStore.create({ title: "Aiden", workspaceId: ASSISTANT_WORKSPACE_ID, providerId, model }))`
   — one dedicated Aiden thread, claimed once, the way `schedule-store.ensureChatId` does.
2. `chatStore.appendMessage(chatId, { role: "assistant", content })` with the nudge body,
   then `ipcMain.broadcast("chats:metadata-updated", …)` — the same pair
   `schedule-execution.appendChatMessage` uses.
3. `assistantStore.markDelivered(nudge.id, chatId)`.
4. `showNudgeNotification(nudge, { isSupported: () => Notification.isSupported(), create: (options) => new Notification(options), openThread: async (id) => { await showAssistantWindow(); ipcMain.broadcast("assistant:open-thread", { chatId: id }); } })`.
5. `ipcMain.broadcast("assistant:nudge", { nudge })`.

- [ ] **Step 4: Two of the three contract entries now have sites**

```bash
npx tsx --test main/handlers/ipc-contract.test.ts
```

Expected: still FAILS, now only on `assistant:state-changed`. Task 19 broadcasts it; finish
Task 19 before the phase gate.

- [ ] **Step 5: Verify, register, and commit**

```bash
npx tsx --test main/services/assistant/nudge-notification.test.ts && npm run type-check
```

Register the test in the `test` script.

```bash
git add main/services/assistant/deliver.ts main/services/assistant/nudge-notification.test.ts package.json
git commit -m "feat(assistant): deliver nudges as notifications and thread messages"
```

---

### Task 19: Ticker, state IPC, and health surface

**Files:**

- Create: `main/services/assistant/ticker-core.ts`
- Create: `main/services/assistant/ticker-core.test.ts`
- Create: `main/services/assistant/ticker.ts`
- Modify: `main/handlers/assistant.ts`
- Modify: `main/index.ts`
- Modify: `renderer/components/settings/assistant-settings.tsx`
- Modify: `package.json`

**Interfaces:**

- Consumes: everything from Tasks 12–18.
- Produces:

```ts
export interface TickerCoreDeps {
  loadConfig(): Promise<AssistantConfig>;
  loadState(): Promise<AssistantState>;
  collect(
    config: AssistantConfig,
    snapshot: Record<string, unknown> | undefined,
  ): Promise<{ candidates: NudgeCandidate[]; snapshot: Record<string, unknown> }>;
  decide(candidates: readonly NudgeCandidate[], config: AssistantConfig): Promise<DecisionResult>;
  addNudges(verdicts: readonly UrgencyVerdict[]): Promise<NudgeRecord[]>;
  deliver(nudge: NudgeRecord): Promise<void>;
  setSettingsSnapshot(snapshot: Record<string, unknown>): Promise<void>;
  recordTick(): Promise<void>;
  recordSuccess(): Promise<void>;
  recordError(message: string): Promise<void>;
  isBusy(): boolean;
  clock(): PolicyClock;
}

export type TickOutcome =
  | "disabled"
  | "needs-model"
  | "deferred"
  | "busy"
  | "backlog-full"
  | "no-candidates"
  | "silent"
  | "delivered"
  | "suppressed"
  | "error";

export function createAssistantTickerCore(deps: TickerCoreDeps): { tick(): Promise<TickOutcome> };
```

- [ ] **Step 1: Write the failing test**

`main/services/assistant/ticker-core.test.ts` — the highest-value test in the phase, because
it pins the whole gating order. Build a deps double with call counters, then one test each:

- `enabled: false` → `"disabled"`; `collect` and `decide` never called.
- pin missing → `"needs-model"`; `decide` never called (never spend on a half-configured
  assistant).
- inside the first-run deferral window → `"deferred"`; `collect` never called.
- `isBusy()` true → `"busy"`; `decide` never called.
- backlog already at `MAX_PENDING_NUDGES` → `"backlog-full"`; `decide` never called.
- no candidates after filtering → `"no-candidates"`; **`decide` never called** — the model is
  only paid for when there is something to judge.
- `decide` returns `{ silent: true }` → `"silent"`; `deliver` never called.
- all verdicts below `urgencyThreshold` → `"no-candidates"`; `deliver` never called.
- one verdict at or above the threshold with delivery allowed → `"delivered"`; `deliver`
  called exactly once, with that nudge.
- one verdict above the threshold during quiet hours → `"suppressed"`; `deliver` never
  called, and the record stays `pending` so it goes out later.
- `collect` throwing → `"error"`; `recordError` called with the message, and `tick()`
  **resolves** rather than rejecting — one bad tick must never kill the loop.
- every path calls `recordTick()` exactly once.
- a successful path calls `recordSuccess()`; an error path does not.

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx tsx --test main/services/assistant/ticker-core.test.ts
```

Expected: FAIL — cannot resolve `./ticker-core.js`.

- [ ] **Step 3: Write the core**

`createAssistantTickerCore` implements exactly the order the test pins, with the whole body
wrapped in try/catch so `tick()` always resolves. It never schedules anything itself — the
shell owns cadence, which makes "no recursive self-scheduling" structural rather than a rule
someone has to remember.

- [ ] **Step 4: Write the croner shell**

`main/services/assistant/ticker.ts`, as thin as `schedule-service.ts`:

```ts
import { Cron } from "croner";
import { ipcMain, logger } from "../../platform.js";
// ... plus configStore, assistantStore, and the assistant modules

let job: Cron | null = null;

export const assistantTicker = {
  async start(): Promise<void> {
    const config = assistantConfigFrom(await configStore.getSettings());
    if (!config.enabled) return;
    // Enabling must never fire immediately; seed the deferral window first.
    await assistantStore.seedFirstRun();
    this.stop();
    job = new Cron(
      "* * * * *",
      {
        name: "assistant:ticker",
        // croner's minimum-interval option turns a per-minute pattern into an
        // arbitrary N-minute cadence, so pollIntervalMinutes needs no cron math.
        interval: config.pollIntervalMinutes * 60,
        protect: () => logger.warn("assistant", "Skipped an overlapping assistant tick."),
        catch: (error) => logger.error("assistant", "Assistant tick failed.", error),
      },
      async () => {
        const outcome = await assistantTickerCore.tick();
        ipcMain.broadcast("assistant:state-changed", { outcome });
      },
    );
  },

  stop(): void {
    job?.stop();
    job = null;
  },

  /** Re-read cadence and enablement after a config change. */
  async restart(): Promise<void> {
    this.stop();
    await this.start();
  },
};
```

Build `assistantTickerCore` in this module by passing the real dependencies into
`createAssistantTickerCore`: `collectSignals`, `decideNudges`, `assistantStore`'s methods,
`deliverNudge`, `() => llmClient.hasActiveGenerations()`, and a `clock()` that derives
`localMinutes` and `localDate` from the current `Date`.

- [ ] **Step 5: Add the remaining handlers**

In `main/handlers/assistant.ts`:

- `assistant:get-state` → build an `AssistantHealth` from `assistantStore.load()` and the
  config. `state` is `"off"` when disabled, `"needs-model"` when the pin is missing,
  `"degraded"` when `lastError` is set or `lastSuccessAt` is older than three intervals, and
  `"healthy"` otherwise. `pending` lists the pending and snoozed records.
- `assistant:dismiss-nudge` / `assistant:snooze-nudge` → require a non-empty string id, gate
  on `isCurrentAssistantEvent(event)`, write through the store, then
  `ipcMain.broadcast("assistant:state-changed", {})`. Snooze takes a duration in minutes and
  clamps it to 1–10080 (a week).
- In `assistant:set-config`, add `await assistantTicker.restart();` after the save so a
  cadence or enablement change takes effect immediately.

- [ ] **Step 6: Wire the lifecycle in `main/index.ts`**

- `void assistantTicker.start();` beside `await scheduleService.start();` (line 611).
- `assistantTicker.stop();` in `cleanupApplication()` beside `scheduleService.stop();`.

The ticker has no in-flight work of its own to drain — its model call goes through
`llmClient`, which `shutdownAndQuit` already awaits via `llmClient.shutdown()` — so it needs
no entry in the `Promise.all` shutdown barrier. Record that reasoning in a comment so nobody
later adds a redundant barrier.

- [ ] **Step 7: Wire the health surface**

Replace the placeholder in `assistant-settings.tsx` with a live row driven by
`assistant:get-state` and refreshed on the `assistant:state-changed` broadcast: "Watching:
healthy — last checked 4 minutes ago", "Watching: needs a model", "Watching: off", or
"Watching: degraded — <lastError>". Add the pending-nudge list beneath it with Dismiss and
Snooze buttons calling the two handlers.

`assistant:state-changed` is in the shared notification allowlist, so the main window's
Settings UI receives it with no extra plumbing.

- [ ] **Step 8: Full contract and test run**

```bash
npm run type-check && npm run lint && npm run test
```

Expected: **fully green**, `ipc-contract.test.ts` included — all three `assistant:*`
broadcasts now have live sites.

- [ ] **Step 9: Manual acceptance**

Run the spec's acceptance list end to end, with `pollIntervalMinutes` temporarily at 5:

1. Enable proactivity with a pinned model. No nudge appears before the first interval
   elapses.
2. Make an uncommitted change in a workspace project. Within one interval a notification
   appears and the Aiden thread has a matching message.
3. Dismiss it. The same `dedupKey` never nudges again, across an app restart.
4. Click a notification. The Aiden window opens focused on the nudge thread.
5. Turn on quiet hours covering now. A new candidate does not deliver; the pending record is
   visible in Settings and delivers once quiet hours end.
6. Set `maxNudgesPerDay` to 1 and confirm the second nudge of the day is held.
7. Clear the model pin while proactivity is on. Settings reads "needs a model" and no model
   call is made.

- [ ] **Step 10: Register and commit**

Register `main/services/assistant/ticker-core.test.ts` in the `test` script.

```bash
git add main/services/assistant/ticker-core.ts main/services/assistant/ticker-core.test.ts main/services/assistant/ticker.ts main/handlers/assistant.ts main/index.ts renderer/components/settings/assistant-settings.tsx package.json
git commit -m "feat(assistant): add the proactive ticker, state IPC, and health surface"
```

---

### Task 20: Test grouping and documentation

**Files:**

- Modify: `package.json` (add `test:assistant`)
- Modify: `docs/plans/README.md`
- Modify: `docs/plans/aiden-assistant-plan.md` (the `Status:` line)
- Modify: `/Users/sambitbiswas/projects/aiden-macos/.memory/PLANNED.md` and
  `PROJECT-HISTORY.md` (gitignored, so they live only in the main checkout)

- [ ] **Step 1: Add a grouped test script**

In `package.json`:

```json
"test:assistant": "tsx --test main/handlers/assistant-parse.test.ts main/services/assistant/assistant-store.test.ts main/services/assistant/decide-parse.test.ts main/services/assistant/nudge-notification.test.ts main/services/assistant/nudge-policy.test.ts main/services/assistant/project-tools.test.ts main/services/assistant/settings-field-policy.test.ts main/services/assistant/signals.test.ts main/services/assistant/silent-parser.test.ts main/services/assistant/system-prompt.test.ts main/services/assistant/ticker-core.test.ts main/windows/window-sender.test.ts renderer/assistant/use-assistant-chat.test.ts renderer/preload-assistant-channels.test.ts"
```

Every one of these files is also individually registered in `test` (or `test:preflight`) by
its own task, so this script is a convenience for iterating on the feature, not the CI path.

- [ ] **Step 2: Run it**

```bash
npm run test:assistant
```

Expected: PASS, all files.

- [ ] **Step 3: Update the plan index and status**

In `docs/plans/README.md`, change the Aiden Assistant row to reflect reality —
`In progress` with a current-state note, or moved to the Completed table with the file moved
to `docs/plans/completed/` if all three phases shipped. Update this document's `Status:`
line to match.

- [ ] **Step 4: Update project memory**

In `.memory/PLANNED.md`, replace the "Status: planned only … No code yet." line under
`## Aiden Assistant` with the shipped scope. Add a `PROJECT-HISTORY.md` entry summarising
what landed, the four resolved decisions (pin-required proactivity, no tray, no file
watching, no main-window nudge surface), and the five corrections to the original draft.

- [ ] **Step 5: Record any friction**

Append anything that cost real time to `.papercuts/troubleshooting.md` in the main checkout.
Likely candidates: the deliberately-red `ipc-contract.test.ts` window between Tasks 2 and 19,
and the vibrancy/transparency interaction with `titleBarStyle: "hidden"`.

- [ ] **Step 6: Final gate and commit**

```bash
npm run type-check && npm run lint && npm run test
```

Expected: fully green.

```bash
git add package.json docs/plans/README.md docs/plans/aiden-assistant-plan.md
git commit -m "docs(assistant): group the assistant tests and record the shipped scope"
```

**Phase 3 checkpoint.** Aiden watches, judges, and nudges — opt-in, pinned, rate-limited,
latching, and fail-closed.

---

## Testing summary

- **Unit (colocated `*.test.ts`, `tsx --test`)**: `[SILENT]` parser edge cases (mid-sentence
  mentions must deliver), nudge latching and dedup, quiet hours across midnight, daily and
  backlog caps, first-run deferral, `AssistantConfig` clamping and validation, settings
  field whitelist and redaction, project summarisation, urgency-verdict parsing, store
  normalisation and concurrent chat claims, and the ticker's full gating order.
- **Contract**: `main/handlers/ipc-contract.test.ts` (existing, extended by the shared
  notification list) and the new `renderer/preload-assistant-channels.test.ts`.
- **Manual acceptance**: the seven-step list in Task 19, plus the per-phase checks in
  Tasks 4, 6, 8, and 11.

## Deferred (a future plan, not this one)

- Real-time file watching, with the `chokidar` vs. bounded `fs.watch` dependency decision
  taken explicitly rather than bolted on.
- The `remember` assistant-memory tool.
- User-customizable urgency criteria.
- Menu-bar tray presence.
- Markdown rendering in the assistant transcript, if Task 6 shipped plain text.
- The draft's "expand to main window" header button. It needs a main-window-focus channel in
  the assistant allowlist, which is main-window integration — deliberately out of v1 along
  with the sidebar affordance and the nudge badge.
