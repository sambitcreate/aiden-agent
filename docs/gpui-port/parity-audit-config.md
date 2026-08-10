# Parity Audit: Config, Workspace & Background Services (TS Electron vs Rust GPUI)

**Branch:** `gpui-rust` | **Audited:** 2026-08-08 | **Scope:** CONFIG, WORKSPACE, BACKGROUND SERVICES

This audit traces each TS service from its trigger point through to its side
effect, then checks whether the Rust port reproduces both the logic **and the
wiring**. A port can exist as a standalone module and still be a functional gap
if nothing in the app constructs or drives it. Findings are graded:

- **CRITICAL** — security/data-loss risk, or a headline feature silently dead.
- **HIGH** — user-visible feature is missing or partially broken.
- **MEDIUM** — degraded behavior; works in the common case, fails on edge cases.
- **LOW** — ergonomic/quality gap, no correctness impact.

A summary table is at the bottom.

---

## 1. Portable config watch — **CRITICAL (logic ported, NOT wired)**

| | |
|---|---|
| **TS** | `main/services/portable-config-watch-core.ts` (core) + `main/services/portable-config.ts:42` (`reloadPortableConfig`) |
| **TS wiring** | `main/index.ts:1015-1036` (builds `reloadAndReconcilePortableConfig` + `createPortableConfigWatcher`), `main/index.ts:1171-1172` (triggers) |
| **Rust** | `rust/aiden-data/src/portable_watch.rs` (641 LOC, full logic port, 8 unit tests) |
| **Rust wiring** | **NONE** |

### What TS does
On every **window focus** (`app.on("browser-window-focus")`) and every **wake
from sleep** (`powerMonitor.on("resume")`), the watcher re-reads
`~/.aiden/config.json`, compares contents, and only on a real change:
1. Reconciles external provider-credential changes (`reconcileExternalProviderCredentialChanges`).
2. Reconciles external MCP-credential changes (disconnects moved/removed servers).
3. Broadcasts `app:config-externally-changed` so the renderer refreshes
   provider/MCP/skill lists.

The last-safe-snapshot tracker guarantees an unsafe (corrupt) file never
replaces the last reconciled baseline. This is the mechanism that lets a user
hand-edit `config.json` and see it picked up without a restart.

### What Rust does
`portable_watch.rs` faithfully ports `LastSafeSnapshotTracker`,
`LastSafeSnapshotReload`, `PortableConfigWatcher`, and the
`mutate_portable_config_and_sync` / snapshot-listener plumbing. It is declared
in `rust/aiden-data/src/lib.rs:66` (`pub mod portable_watch;`).

### The gap
`portable_watch` is referenced **nowhere outside its own file**. There is no
trigger on window focus, no sleep/wake hook, no
`set_portable_credential_snapshot_listener` call, and no
`app:config-externally-changed` equivalent broadcast. `Stores::open()`
(`rust/aiden-ui/src/services/stores.rs:46`) builds the portable stores but
never wraps them in a watcher.

**Consequence:** editing `~/.aiden/config.json` by hand (or with another tool)
while the Rust app runs is invisible until restart. The credential
reconciliation that depends on it (items 5 and 7) therefore has no trigger path
either.

---

## 2. Workspace file browsing — **HIGH (missing)**

| | |
|---|---|
| **TS** | `main/services/workspace-files.ts` (453 LOC) |
| **TS wiring** | `main/handlers/workspaces.ts:42-46,423-443` (IPC: list/read/write); `renderer/components/files-panel.tsx` (UI); also consumed by `llm-client.ts:735` |
| **Rust** | **MISSING** |

### What TS does
A bounded, workspace-confined file API for the user-facing **Files panel**:
`listWorkspaceFiles` (capped index, max 4000 entries / depth 20, skips
`.git`/`node_modules`/etc., follows symlinks only inside the workspace root),
`readWorkspaceFile`, `writeWorkspaceFile` (optimistic read → verify → atomic
displacement → `lsof` recovery probe on macOS). Also feeds attachment
resolution in the LLM client.

### What Rust does
Nothing. The Rust panels directory (`rust/aiden-ui/src/panels/mod.rs`) declares
only `command_palette`, `scheduled_panel`, `subagents_panel`, `terminal_drawer`,
`usage_panel` — **no files panel**. `rust/aiden-ui/src/workspace/{state,editors}.rs`
have no file-listing/index/read/write surface. No IPC or service equivalent
exists.

**Consequence:** users cannot browse, open, or edit workspace files through the
UI in the Rust app. (File *mutation* by the agent via tools is a separate
`aiden-subagents`/`aiden-git` path and is not affected.)

---

## 3. Skills discovery — **HIGH (missing)**

| | |
|---|---|
| **TS** | `main/services/skills-discovery.ts` (194 LOC) |
| **TS wiring** | `main/services/llm-client.ts:382` (injects into system prompt via `formatAvailableSkills`), `main/services/tools.ts:289` (turns skills into tools), `main/handlers/phase2.ts:55` (IPC) |
| **Rust** | **MISSING** (only the `Skill` config *type* exists in `portable_config.rs:303`) |

### What TS does
Scans global roots (`~/.agents`, `~/.claude`, `~/.aiden`) and workspace roots
(`<workspace>/.agents`, `.claude`, `.aiden`) for `SKILL.md` files (legacy,
nested, and Aiden-native layouts), parses YAML frontmatter (`name`,
`description`), and returns discovered skills. Workspace skills override global
ones of the same name. The results are injected into the system prompt and
surfaced as agent tools.

### What Rust does
`portable_config.rs` carries the user-editable skill **list** (the `skills`
field) and its validators, but there is **no filesystem discovery** —
`SKILL.md` parsing and root-scanning are absent. No crate references
`discover_skills` / `skills_discovery`, and skills are never read into the
system prompt (`rust/aiden-agent/src/system_prompt.rs`) or tool surface.

**Consequence:** Agent Skills installed on disk are invisible to the Rust app.
The persisted skill list still loads, but skills are never actually loaded as
instructions/tools.

---

## 4. Scheduled task execution — **CRITICAL (runtime ported, NOT wired; TaskExecutor is a stub)**

| | |
|---|---|
| **TS** | `main/services/schedule-execution.ts` (385 LOC) — real execution; `main/services/schedule-service-core.ts` — runtime |
| **TS wiring** | `main/index.ts:1179` (`scheduleService.start()`) runs the tick loop; `schedule-execution.ts:91-99` fires notifications |
| **Rust** | `rust/aiden-scheduler/src/runtime.rs` (1,622 LOC tick loop + state machine) |
| **Rust wiring** | **NONE — `TaskExecutor` has only a `FakeExecutor` test impl** |

### What TS does
`createScheduleExecution` is the real `ScheduleExecutionLike`: for each due
task it ensures/creates a chat, builds a background generation owner, runs an
LLM turn (or a shell script) with the task's provider/model/workspace/MCP
binding, appends the assistant message, records a `ScheduledRun`, and fires a
macOS notification. `scheduleService.start()` runs the cron tick loop that
dispatches due tasks through this executor.

### What Rust does
`runtime.rs` ports the full scheduler state machine: the 30s tokio tick loop,
`advanceBeforeRun` claim semantics, missed-run catch-up, per-task lifecycle
locks, revision-checked saves, `stopAndSettle`, and the workspace-revocation
kill switch. It exposes a `TaskExecutor` trait (`runtime.rs:86-91`) as the
execution seam.

### The gap
1. **`TaskExecutor` has exactly one implementation: `FakeExecutor` inside
   `runtime.rs:1031` under `#[cfg(test)]`.** No real implementation exists in
   `aiden-ui`, `aiden-agent`, or `aiden-mac`.
2. **`aiden-scheduler` is a dead crate.** No other crate depends on it
   (`rust/aiden-ui/Cargo.toml` lists 7 sibling crates; `aiden-scheduler` is
   not among them). `SchedulerRuntime` is never constructed or `.start()`ed.
3. The scheduled-tasks panel (`rust/aiden-ui/src/panels/scheduled_panel.rs:515`)
   runs a tick loop, but it only advances a display clock (`this.now`) — it
   does not dispatch or execute tasks. It reads the store for display only.

**Consequence:** scheduled tasks are **persisted and listed but never run**.
A task scheduled for 9 AM will not fire at 9 AM. No chat is created, no LLM
turn executes, no run is recorded, no notification is sent. This is a silent
total failure of a headline automation feature.

---

## 5. Provider credential rotation — **CRITICAL (security mechanism missing)**

| | |
|---|---|
| **TS** | `main/services/provider-credential-rotation-core.ts` (131 LOC) + `main/services/provider-credential-rotation.ts` (243 LOC) |
| **TS wiring** | Save/remove/key paths in provider handlers; `reconcileExternalProviderCredentialChanges` called from the portable watcher |
| **Rust** | Low-level quarantine/binding primitives exist in `secret_map.rs`; the rotation **journal and reconcile logic are MISSING** |

### What TS does
When a provider's connection (base URL / kind) changes, the API key must not be
sent to the new host unproven. The rotation journal
(`__aiden_internal_provider_credential_rotation_v1__`) atomically stages the
`previous`/`target` connection snapshots + keys, publishes the config, then
reconciles: the key is rebound only when the current connection matches the
journal's `target` (or `previous`), otherwise it is **cleared or quarantined**
to avoid leaking an old key to a new endpoint. On startup, pending rotations
and unbound legacy keys are reconciled. External config writes quarantine
(rather than delete) bound keys.

### What Rust does
- `rust/aiden-data/src/secret_map.rs` ports the encrypted store's
  quarantine/binding *primitives* (`quarantine`, `move_secret_entry_with_binding_if_vacant`,
  `bind_secret_entry_if_unbound`) — the storage layer is present.
- `config_store.rs:112` has `provider_connection_snapshot`.

### The gap
- The **rotation journal logic is entirely absent**: no
  `__aiden_internal_provider_credential_rotation_v1__` key, no
  `saveProviderWithCredentialRotation` / `removeProviderWithCredentialCleanup`
  / `setProviderKeyWithCredentialRotation` / `reconcilePendingProviderCredentialRotation`
  equivalents.
- `StoreSecretsPort` (`rust/aiden-ui/src/services/stores.rs:107-136`) **ignores
  the binding**: `get_provider_key` takes `_binding: &str` (underscore-prefixed =
  unused), `migrate_keys` is a no-op (`Ok(())`), and
  `migrate_provider_keys_with_bindings` returns `Ok(true)` without doing work.
- Because item 1 (portable watch) is unwired, the
  `reconcileExternalProviderCredentialChanges` trigger has no path to fire.

**Consequence:** if a user changes a provider's base URL, an API key bound to
the old host can be reused against the new host with no binding check or
quarantine. This is a **credential-exposure risk**. Startup reconciliation of
interrupted rotations is also absent.

---

## 6. Provider model discovery (live) — **HIGH (load-state probe ported; live discovery + test-connection missing)**

| | |
|---|---|
| **TS** | `main/services/models.ts:427` (`discoverModels`), `:459` (`listModels`), `:467` (`testConnection`); `main/services/provider-model-info-core.ts` |
| **TS wiring** | `main/handlers/providers.ts:296` (`providers:listModels` IPC), attachment `models:info` |
| **Rust** | `rust/aiden-providers/src/catalog.rs` (parsers only); `rust/aiden-mac/src/local_runtime_status.rs` (load probe) |

### What TS does
`discoverModels` performs a **live HTTP fetch** against a running provider to
list its available models: Ollama (`/api/tags` + `/api/show`), LM Studio
(`/api/v1/models` with v0 fallback), generic OpenAI-compatible (`/models`),
Google. `testConnection` wraps this as a connectivity/auth probe. These drive
the provider-settings "fetch models" / "test connection" actions and the model
picker.

### What Rust does
- `catalog.rs` ports the **parsers** (`parse_generic_response:828`,
  `parse_lmstudio_response:961`, `ollama_model_metadata:1026`) but has **no
  `discover_models` HTTP function** and no caller. Model lists come only from
  the offline `models.dev` capability catalog (`resources/...`) and provider
  presets.
- `local_runtime_status.rs` ports the **load-state probe** (is a given model
  resident in Ollama/LM Studio memory) faithfully.

### The gap
There is no live model discovery and no "test connection" in the Rust provider
settings UI (`rust/aiden-ui/src/settings/providers.rs`). Users cannot refresh
the model list from a running local server, nor verify a custom provider's
endpoint/key before saving.

**Note:** the catalog-based model capabilities (vision/tool-call/reasoning) are
ported; this gap is specifically the live HTTP enumeration + connectivity test.

---

## 7. MCP config lease — **HIGH (missing)**

| | |
|---|---|
| **TS** | `main/services/mcp-config-lease.ts` (115 LOC) |
| **TS wiring** | `main/services/portable-config.ts:14-27` (`invalidateChangedMcpConfigurationLeases` on both sides of every portable publish); MCP dispatch uses `lease.assertCurrent()` as a fence |
| **Rust** | **MISSING** |

### What TS does
A per-server epoch registry. Acquiring a lease captures `(serverId, epoch,
signal)`. When a server's runtime authority (URL/command/env/transport) changes,
`invalidateChangedMcpConfigurationLeases` bumps the epoch and **aborts every
in-flight tool call** holding the old epoch synchronously. `assertCurrent()`
is a synchronous fence checked immediately before raw dispatch, so a config
save mid-turn cannot let a tool call land against a stale/changed server.
`withMcpConfigurationPublication` fences leases on both sides of a publish.

### What Rust does
`rust/aiden-mcp/src/connection_cache.rs` has its own invalidation — but it is
**per-generation / per-disconnect**, not per-config-change. There is no
per-server config epoch, no `assertCurrent` fence, no
`invalidate_changed_mcp_configuration_leases`, and no
`withMcpConfigurationPublication`.

### The gap
A precise search for `LeaseRegistry` / `McpConfigurationLease` /
`invalidate_changed_mcp` / `config_lease` / server-config `epoch` returns
**nothing** in the Rust tree (the `epoch` hits in `lib.rs`/`codex.rs` are
unrelated timestamps/cache epochs). Saving an MCP server's config does not
abort in-flight tool calls against the old configuration.

**Consequence:** if an MCP server's URL/command/env changes while a tool call
is in flight, the call can complete against the old (or now-mismatched)
server. Combined with item 1 being unwired, external MCP config edits are also
not reconciled.

---

## 8. Chat deletion reconciliation — **HIGH (data model ported, NOT wired)**

| | |
|---|---|
| **TS** | `main/services/chat-deletion-reconciliation.ts` (18 LOC) |
| **TS wiring** | `main/index.ts:1058` (startup reconciliation), `main/handlers/chats.ts:141,146` (per-delete: `completeChatDeletion`, gate on `pendingChatDeletions`) |
| **Rust** | `rust/aiden-subagents/src/run_store_v2.rs` (API present: `delete_chat:1721`, `pending_chat_deletions:1808`, `complete_chat_deletion:1818`, `preflight_chat_deletion:1697`) |
| **Rust wiring** | **NONE** |

### What TS does
Deleting a chat is a **cross-store** operation: it removes the chat record AND
the subagent runs / file-mutation effects / workspace refs owned by that chat.
Because the multi-store delete can crash mid-way, pending deletions are journaled
and reconciled at startup (`reconcilePendingChatDeletions`) before any renderer
can replay a chat whose private child history was already removed.

### What Rust does
`run_store_v2.rs` ports the full pending-deletion data model and exposes the
complete API (`delete_chat`, `preflight_chat_deletion`,
`pending_chat_deletions`, `complete_chat_deletion`). The `Stores` struct,
however, **does not hold a run store** (`rust/aiden-ui/src/services/stores.rs`
has chat/config/keys/schedules/usage/mcp — no run store).

### The gap
- `ChatService::delete_chat` (`rust/aiden-ui/src/services/chat_service.rs:451-480`)
  **only** calls `stores.chat.remove(&task_id)`. It never calls
  `run_store.delete_chat()`, never `preflight`s, never
  `complete_chat_deletion`.
- There is **no startup reconciliation** — `reconcilePendingChatDeletions` has
  no Rust call site (only the data type exists in the run store).
- The subagents panel uses `MemoryRunSource` (in-memory demo), not
  `LiveRunSource`; `LiveRunSource` is `#[allow(dead_code)]` and never swapped
  in by `app.rs` (it constructs `MemoryRunSource::default()` at `app.rs:876`).

**Consequence:** deleting a chat orphans its subagent runs, file-mutation
records, and workspace references in the run store. A crash-interrupted delete
is never recovered at restart.

---

## 9. Quit barrier — **HIGH (logic ported, NOT wired)**

| | |
|---|---|
| **TS** | `main/services/quit-barrier.ts` (46 LOC) |
| **TS wiring** | `main/index.ts:481` (`closeRendererBeforeShutdown`), `main/index.ts:993-1002` (`before-quit` → `requestApplicationQuit`) |
| **Rust** | `rust/aiden-mac/src/quit_barrier.rs` (454 LOC, full port incl. `QuitBarrier` state machine) |
| **Rust wiring** | **NONE** |

### What TS does
On `before-quit`, the app does not quit immediately. It closes the renderer
first (`closeRendererBeforeShutdown` resolves `true` only after the renderer
can no longer veto/issue IPC), and the in-flight-generation guard blocks quit
unless forced — so a user with an active generation is warned rather than
silently losing output.

### What Rust does
`quit_barrier.rs` ports `RendererQuitWindow`, `close_renderer_before_shutdown`,
and adds a `QuitBarrier` state machine whose docstring states "in-flight
generations block quit unless forced, and the renderer must be closed first."

### The gap
`QuitBarrier` and `close_renderer_before_shutdown` are **never referenced
outside `quit_barrier.rs`**. The app's quit handler is
`App::on_quit` (`rust/aiden-ui/src/app.rs:519-521`):

```rust
fn on_quit(&mut self, _: &Quit, _: &mut Window, cx: &mut Context<Self>) {
    cx.quit();
}
```

It calls `cx.quit()` unconditionally — no in-flight-generation check, no
renderer-close barrier, no warning.

**Consequence:** quitting during an active generation kills it silently with no
prompt. The `⌘Q` binding (`main.rs:145`) routes straight through to this handler.

---

## 10. Single instance lock — **HIGH (missing)**

| | |
|---|---|
| **TS** | `main/index.ts:92` (`app.requestSingleInstanceLock()`), `main/index.ts:983` (`second-instance` → focus main window) |
| **Rust** | **MISSING** |

### What TS does
At startup Electron acquires a single-instance lock; if another instance is
already running, the new process exits and the existing instance's
`second-instance` handler focuses the main window.

### What Rust does
`rust/aiden-ui/src/main.rs:79` (`fn main()`) has no lock-file, no
`flock`/advisory-lock, no bundle-id singleton check, and no `second-instance`
focus path. A search for `single_instance`/`lock_file`/`flock`/`Singleton`
across `aiden-ui`/`aiden-mac` returns nothing relevant.

**Consequence:** multiple Aiden instances can run simultaneously, each opening
its own stores against the same `~/.aiden` and machine-local data dirs — a
recipe for conflicting writes and store corruption.

---

## 11. macOS notifications (scheduled tasks) — **CRITICAL (never sent; backend is a stub)**

| | |
|---|---|
| **TS** | `main/services/schedule-notification.ts` + `schedule-execution.ts:91-99` (fires on every run) |
| **TS wiring** | Electron `Notification` surface, delivered from inside the scheduler executor |
| **Rust** | `rust/aiden-mac/src/notify.rs` (delivery impl via `mac-notification-sys`); `rust/aiden-scheduler/src/notification.rs` (`NotificationBackend` trait) |
| **Rust wiring** | **NONE** |

### What TS does
`showScheduledNotification` is called at the end of every scheduled run
(`schedule-execution.ts:92`) to post a macOS banner with an `openChat` action.

### What Rust does
- `notify.rs` ports delivery (`send_notification`, `preflight`,
  `is_supported`) using `mac-notification-sys`.
- `notification.rs` defines a `NotificationBackend` trait and
  `show_scheduled_notification`.

### The gap
1. `NotificationBackend` has **only test implementations** (`Captured`,
   `Unsupported` in `notification.rs:123,147`). There is **no implementation
   that bridges to `aiden_mac::notify::send_notification`**.
2. `aiden_mac::notify::{send_notification, preflight}` is **never called from
   anywhere** outside `notify.rs`'s own tests.
3. This is moot anyway because the scheduler itself never runs (item 4), so
   there is no code path that would call `show_scheduled_notification`.

**Consequence:** no scheduled-task notification is ever delivered, regardless
of platform support.

---

## 12. Global hotkey (dictation/pill) — **HIGH (in-app only)**

| | |
|---|---|
| **TS** | `main/services/shortcut.ts:134` (`globalShortcut.register`) — real OS-level global hotkey |
| **Rust** | `rust/aiden-mac/src/hotkey.rs` (reconcile algorithm + `MacHotkeyPort` using the `global-hotkey` crate) |
| **Rust wiring** | **NONE — in-app keybindings only** |

### What TS does
`shortcut.ts` registers real **global** shortcuts via Electron's
`globalShortcut.register`, active while another app is focused. The dictation
hotkey fires the pill/coordinator even when Aiden is not frontmost.

### What Rust does
- `hotkey.rs` ports the full transactional reconcile model and includes a real
  `MacHotkeyPort` (`hotkey.rs:363`) backed by the `global-hotkey` crate
  (dep present in `aiden-mac/Cargo.toml:34`).
- The pill toggle is bound **in-app only**: `main.rs:152`
  (`KeyBinding::new("cmd-shift-d", TogglePill, Some("App"))`) and
  `pill/mod.rs:109` (`cmd-.`). Both are GPUI app-scope bindings, not OS-global.

### The gap
`MacHotkeyPort` is **never constructed or used outside `hotkey.rs`** (only a
test `FakePort` exercises the trait otherwise). The pill module itself
documents the gap (`rust/aiden-ui/src/pill/mod.rs:35-36`): *"the global hotkey
coordinator lands in a later phase"* and *"the aiden-mac hotkey wiring lands
later"* (`mod.rs:128`). This is also acknowledged in
`docs/gpui-port/COMPLETION-REPORT.md:74`.

**Consequence:** the dictation/pill hotkey works only while the Aiden window is
focused. It cannot be triggered from another app — the core pill/dictation UX
is unavailable system-wide.

---

## Summary

| # | Feature | TS | Rust status | Severity |
|---|---|---|---|---|
| 1 | Portable config watch | ported+wired | logic ported, **not wired** | CRITICAL |
| 2 | Workspace file browsing | ported+wired | **missing** | HIGH |
| 3 | Skills discovery | ported+wired | **missing** (type only) | HIGH |
| 4 | Scheduled task execution | ported+wired | runtime ported, **executor stub, not started** | CRITICAL |
| 5 | Provider credential rotation | ported+wired | primitives only, **journal missing, binding ignored** | CRITICAL |
| 6 | Provider model discovery (live) | ported+wired | parsers + load-probe only, **no live fetch / test-conn** | HIGH |
| 7 | MCP config lease | ported+wired | **missing** | HIGH |
| 8 | Chat deletion reconciliation | ported+wired | data model ported, **not wired** | HIGH |
| 9 | Quit barrier | ported+wired | logic ported, **not wired** (`cx.quit()` direct) | HIGH |
| 10 | Single instance lock | wired | **missing** | HIGH |
| 11 | macOS notifications (scheduler) | wired | delivery + trait ported, **backend stub, never called** | CRITICAL |
| 12 | Global hotkey | wired (OS-global) | algorithm + port ported, **in-app binding only** | HIGH |

### Cross-cutting observations

- **The "ported but not wired" pattern is the dominant failure mode.** Six of
  twelve items (#1, #4, #8, #9, #11, #12) have substantial, well-tested Rust
  modules that are simply never constructed or driven by the app. Reading the
  crate-level COMPLETION-REPORT's "ported" claims overstates runnable behavior.
- **Item 4 is the load-bearing gap.** The scheduler being unstarted also kills
  item 11 (notifications have no trigger) and is the most user-visible broken
  headline feature.
- **Item 1 is the silent-multiplier.** The portable-config watcher is the
  trigger for items 5 and 7's external-change reconciliation; with it unwired,
  hand-edits and external tooling changes to `config.json` are invisible, and
  credential/MCP reconciliation has no external-change path.
- **Items 5 and 7 are the security cluster.** Credential rotation (#5) and MCP
  config leases (#7) both exist to prevent stale credentials/connections from
  being reused after a config change. Their absence is a credential-exposure
  risk, not merely a missing feature.
- **The subagent run store is not part of the live app at all** (item 8): the
  `Stores` struct doesn't hold it, the panel reads demo data, and chat deletion
  never touches it. This is broader than the reconciliation gap — live subagent
  runs may not be surfaced correctly either.

### Recommended fix order (dependency-aware)

1. **#4** Wire a real `TaskExecutor` (chat generation) into `aiden-ui` and
   `.start()` the `SchedulerRuntime` — unblocks #11's trigger.
2. **#11** Add a `NotificationBackend` impl bridging to `aiden_mac::notify`,
   call `preflight` once at startup.
3. **#1** Wire `portable_watch` on window-focus/sleep-wake; emit a
   config-changed event the renderer subscribes to — unblocks #5/#7 triggers.
4. **#5** Port the credential-rotation journal; honor `binding` in
   `StoreSecretsPort::get_provider_key`.
5. **#7** Port the MCP config-lease registry; fence MCP dispatch and publish.
6. **#8** Add the run store to `Stores`; call `delete_chat`/reconcile in
   `ChatService::delete_chat` and at startup; swap `LiveRunSource` into the panel.
7. **#9** Wire `QuitBarrier` into `on_quit` with an in-flight-generation check.
8. **#10** Add a single-instance lock (lockfile or `global-hotkey`-style guard).
9. **#12** Construct `MacHotkeyPort` and register the dictation hotkey globally.
10. **#2 / #3 / #6** Port the missing user-facing services (files panel, skills
    discovery, live model discovery + test-connection).
