# GPUI Port — Final Exhaustive Parity Scan

Branch: `gpui-rust` (HEAD `3ef2064`).
Scope: `rust/aiden-ui/src/` runtime paths, cross-checked against `main/handlers/`,
`renderer/`, and the on-disk data layout. Every finding below was verified by
reading the actual code (and, for the lease semantics, the vendored GPUI source).

Severity legend: **CRASH** (panics the app / `panic_cannot_unwind`) · **HIGH**
(core feature non-functional) · **MEDIUM** (feature partial / degraded) · **LOW**
(cosmetic / misleading).

---

## Summary

| # | Finding | Severity | Fixable |
|---|---------|----------|---------|
| 1 | Latent entity double-lease panics across **9 settings files** (the unfixed siblings of the `shortcuts.rs` bug) | **CRASH** | Yes (mechanical) |
| 2 | Scheduled-task executor is a no-op stub (`LoggingTaskExecutor`) — due tasks never run a real chat | **HIGH** | Yes |
| 3 | Skills management settings section is missing (no list/save/remove UI) | **HIGH** | Yes |
| 4 | Provider OAuth login (`providers:auth:*`) is unwired — only API-key auth works | **MEDIUM** | Yes |
| 5 | MCP server OAuth is stubbed (`oauth: None`) | **MEDIUM** | Yes |
| 6 | Computer-use readiness probe is a hard-coded "Coming soon" row | **MEDIUM** | Yes |
| 7 | Anthropic `AnthropicProvider` carries a stale "Stub provider" doc comment (impl is fully wired) | **LOW** | Yes |

Items 2–6 are confirmed functional gaps; item 1 is a latent crash that the unit
suite cannot see (state structs are tested in isolation, never through GPUI
listener dispatch). Data-format parity (#6 of the request) and the Anthropic
streaming path (#7 of the request) are **clean** — details at the end.

---

## 1. CRASH — Entity double-lease panics in 9 settings files

### What's wrong

Commit `50e9fc5` ("fix: entity double-lease panic in SettingsView shortcuts")
fixed one instance of a systemic bug. The identical, unfixed pattern is still
present in **9 other settings sub-states**.

The bug: a `cx.listener(...)` closure on `SettingsView` calls a sub-state method
(e.g. `this.assistant.save(...)`, `this.appearance.set_mode(...)`) which does:

```rust
fn services(&self, cx: &mut Context<SettingsView>) -> SettingsServices {
    cx.entity().read(cx).services.clone()   // <-- PANIC
}
```

### Why it panics (verified in the GPUI source)

`~/.cargo/registry/src/.../gpui-0.2.2/src/app/entity_map.rs`:

- `lease()` (line 108) — used by listener/`update` dispatch — **removes** the
  entity from `self.entities`.
- `read()` (line 130) — `self.entities.get(id)...unwrap_or_else(|| double_lease_panic::<T>("read"))`.

So while a `SettingsView` listener is executing, `SettingsView` is leased out
(absent from the map). `cx.entity().read(cx)` then looks it up, gets `None`, and
calls `double_lease_panic` → message **"cannot read SettingsView while it is
already being updated"** → `panic_cannot_unwind` from the GPUI event loop.

The `shortcuts.rs` fix proves this is a real panic, not a theoretical one: it
changed `cx.entity().read(cx).services.clone()` to passing `&this.services` from
the listener. None of the files below got that treatment.

### Affected files & listener-reachable trigger points

`cx.entity().read(cx).services.clone()` (or the equivalent `mcp.servers` read)
lives in **9 files**; each is reached from `on_click(cx.listener(...))` closures:

| File | Crash trigger (user action → method) | Line of `read` |
|------|--------------------------------------|----------------|
| `settings/appearance.rs` | toggle Light/Dark → `set_mode`; pick preset → `set_preset`; reduce-motion → `set_reduce_motion` | 301, 328, 351 |
| `settings/assistant.rs` | flip any assistant switch → `save` | 164 (via 176) |
| `settings/computer_use.rs` | toggle computer-use on/off → `set_enabled` | 44 (via 55) |
| `settings/mcp.rs` | toggle server → `toggle_server`; save → `save_draft`; remove → `confirm_remove`; test → `test_server` | 615, 622, 728 (via 620/660/697/726) |
| `settings/model_data.rs` | save AA key / refresh catalog → `services` | 489 (via 588/630/671/707) |
| `settings/providers.rs` | remove key → `remove_key`; save editor → `save_editor`; test/discover → `test_discover`; remove provider → `confirm_remove` | 1280 (via 1016/1057/1212/1253) |
| `settings/scheduled.rs` | save task → `save_draft`; toggle → `toggle_enabled`; remove → `confirm_remove` | 660 (via 680/725/748) |
| `settings/voice.rs` | remove voice model → `remove` | 128 (via 156/201/296) |
| `settings/web_search.rs` | toggle Exa → `set_enabled`; save key → `save_key`; test → `test_key` | 59 (via 64/108/161/194) |

That is ~24 distinct crash sites spanning **every interactive control in every
settings section**, including the default Appearance tab. The whole settings
surface is non-functional at runtime.

### Why the test suite doesn't catch it

The 1367 tests exercise the state structs (`AppearanceState`, `McpState`, …) as
plain Rust objects in `#[cfg(test)] mod tests`. They never construct a
`SettingsView` entity and dispatch a listener through GPUI, so the lease is
never held and `cx.entity().read(cx)` is never hit from a listener.

### Fix

Mechanical, identical to the `shortcuts.rs` precedent: make each `services(cx)`
helper take `&SettingsServices` (or `services: SettingsServices`) and have the
listener pass `&this.services` / `this.services.clone()` (the listener already
holds `this: &mut SettingsView`, so `this.services` needs no lease). The
background-write path that follows (`cx.spawn(... this.update(...) ...)`) is
unaffected — only the synchronous read before the spawn is wrong.

---

## 2. HIGH — Scheduled-task executor is a no-op stub

`rust/aiden-ui/src/services/stores.rs:141` wires the scheduler with
`Arc::new(LoggingTaskExecutor)`. Its `run` impl (`stores.rs:331-353`) is:

```rust
async fn run(&self, task: &ScheduledTask) -> Result<...> {
    tracing::info!("scheduled task would execute: {task:?} (real chat execution lands with the scheduler executor follow-up)");
    Ok(TaskRunOutcome {
        result: ScheduledRunResult::Success,
        output: "Evaluated by the scheduler runtime; execution lands in a follow-up.".to_string(),
        ...
        chat_id: None,
    })
}
```

`app.rs:384` does start the scheduler tick loop, and due tasks fire on schedule —
but each one logs "would execute" and records a **fake Success run** without
producing a chat, an assistant turn, or any tool work. `cancel`/`cancel_all`
return `false`/no-op. The TS app (`main/handlers/scheduled-tasks.ts` +
`aiden-scheduler`) drives a real chat generation for each due task.

Result: the entire Scheduled Tasks feature (the `/scheduled` route, the settings
section, the run history) is present and persists configuration, but the actual
"run this prompt on a cron" behavior is absent. Users see a stream of
successful runs that did nothing.

`stores.rs:337`, `stores.rs:341`, and `app.rs:380` all explicitly defer to a
"scheduler-executor follow-up".

---

## 3. HIGH — Skills management settings section is missing

The TS settings view (`renderer/main/settings-view.tsx:25`) renders a
`SkillsSettings` section backed by four IPC handlers (`main/handlers/phase2.ts:46-54`):
`skills:list`, `skills:save`, `skills:remove`, `skills:discovered`.

The Rust port only implements `discover_skills()` (`rust/aiden-ui/src/skills.rs:32`)
— a read-only filesystem scan. There is **no Skills section** in
`rust/aiden-ui/src/settings/` (confirmed: `rg skills settings/mod.rs` returns
nothing) and no list/save/remove-through-configStore path. Users cannot enable,
disable, edit, or remove skills from the UI; only on-disk discovery works.

---

## 4. MEDIUM — Provider OAuth login is unwired

The TS app exposes `providers:auth:start`, `providers:auth:respond`,
`providers:auth:cancel`, `providers:auth:status` (used for ChatGPT/Codex and
other OAuth providers). `rg 'providers:auth|auth_start|oauth'` against
`rust/aiden-ui/src/services/provider_kit.rs` returns nothing, and
`provider_kit.rs:144` states verbatim:

> Codex OAuth is not wired into the chat driver yet; an empty …

Only API-key authentication works in the Rust build. Providers that require or
prefer OAuth sign-in (e.g. ChatGPT/Codex) cannot be connected.

---

## 5. MEDIUM — MCP server OAuth is stubbed

`rust/aiden-mcp/src/oauth.rs` implements the OAuth state machines (PKCE S256,
session/operation), but the UI→transport seam is open:

- `rust/aiden-ui/src/services/mcp_tools.rs:156` and `:173` hard-code `oauth: None`
  on constructed MCP server records.
- `rust/aiden-mcp/src/oauth.rs:924` carries a `// TODO` for the metadata round-trip
  the TS SDK performs.

Remote MCP servers that require OAuth (browser sign-in) cannot be connected;
header/url-auth servers work.

---

## 6. MEDIUM — Computer-use readiness probe is a hard "Coming soon"

`rust/aiden-ui/src/settings/computer_use.rs:7-8` and `:178` document and render a
static "Coming soon" row in place of the signed-helper readiness check
(`cua-driver` status + Accessibility / Screen Recording probes). The enable
toggle itself persists `computerUseEnabled`, but the TS `computerUse:status` /
`computerUse:requestPermissions` live-probe surface (`main/handlers/computer-use.ts`)
has no Rust equivalent, so users get no real readiness/permission feedback.
(The toggle would also crash per finding 1.)

---

## 7. LOW — Stale "Stub provider" doc on a fully-wired Anthropic transport

`rust/aiden-providers/src/anthropic.rs:473-475` documents `AnthropicProvider` as:

> Stub provider for the Anthropic Messages API. Phase 3 wires the transport
> shape (SSE via reqwest-eventsource → normalized events) …

The implementation immediately below (`anthropic.rs:501-588`) is **fully wired**:
`build_request` posts to `/v1/messages` with `x-api-key` + `anthropic-version`,
and `stream_simple` drives a real `reqwest_eventsource::EventSource` through the
`AnthropicAccumulator`. This is misleading documentation only; no behavior is
missing. Recommend deleting/rewriting the doc comment.

---

## Areas confirmed CLEAN

### #1 Runtime panic surface (non-test `.unwrap`/`expect`/`unreachable!`/`panic!`)

The complete non-test list across `rust/aiden-ui/src/`:

- `main.rs:308` `owner.unwrap()` — guarded by `owner.is_some_and(...)` two lines
  above; log-only on the single-instance path. **Safe.**
- `services/stores.rs:228,230` `.lock().unwrap()` — std `Mutex` in the portable-config
  watcher reload closure; only poisons if a prior holder panicked (background
  thread, GPUI-isolated). **Standard idiom, low risk.**
- `services/provider_kit.rs:952,972,987` `unreachable!` — inside `drive_stream`,
  which runs on the `Tokio::spawn` background thread. A violation kills that one
  stream task (surfaces as a closed channel to the `cx.spawn` watcher), it does
  **not** unwind through GPUI. Correct internal invariants. **Safe for the app.**
- `services/appearance.rs:227` `expect("default serializes")` — serializing a
  default struct in a fallback branch. **Effectively unreachable.**
- `pill/mod.rs:247` `Phase::Idle => unreachable!` — render path, but `pill_card`
  is only called inside `.when(self.state.visible(), …)` and
  `PillState::visible()` is `self.phase != Phase::Idle` (`pill/state.rs:165-167`).
  **Properly guarded.**

No `panic!`/`unreachable!` lives in a GPUI `on_click`/`on_action`/`render`/
`cx.listener`/`cx.observe` body that could `panic_cannot_unwind` — except the
double-lease in finding 1 (which is a `read`-time panic, not a literal `panic!`
macro, but equally fatal).

### #3 Tokio-from-GPUI

Every bare `tokio::spawn` outside tests lives on a thread that already hosts a
tokio runtime:

- `pill/coordinator.rs:270` is annotated with an explicit runtime-contract
  comment (lines 262-269): it runs only inside the pill watcher, which
  `app::wire_pill_coordinator` starts via `gpui_tokio_bridge::Tokio::spawn`.
- `approvals/approval_bridge.rs:470/495/515` spawn onto the bridge's own runtime.
- All `aiden-mac` / `aiden-computer-use` / `aiden-git` spawns are inside their
  own background tasks, not GPUI foreground callbacks.

`main.rs:22-40` codifies this contract. No offending bare spawn found in
`aiden-ui` foreground code.

### #6 Data-format parity (ChatStore byte-compatibility)

The TS `Chat`/`ChatMeta`/`ChatMessage`/`Attachment` shapes
(`main/services/types.ts:167-255`) are mirrored byte-for-byte by the Rust
structs in `rust/aiden-core/src/lib.rs:165-242`, all annotated
`#[serde(rename_all = "camelCase")]` with `#[serde(skip_serializing_if =
"Option::is_none")]` on optionals — matching the TS `undefined`-omitting
serializer. Field-by-field: `id`, `title`, `workspaceId`, `providerId`, `model`,
`createdAt`, `updatedAt`, `computerUseEnabled`, `messages` (Chat); `id`, `role`,
`content`, `createdAt`, `model`, `reasoning`, `attachments`, `timeline`,
`subagents` (ChatMessage); `id`, `name`, `mimeType`, `kind`, `size`, `data`,
`text` (Attachment) — all aligned. The on-disk layout (per-chat `<id>.json` +
`index.json` of `ChatMeta`, durable staged writes, transaction reconciliation)
is reproduced in `rust/aiden-data/src/chat_store.rs`. `subagents` is held as an
opaque `serde_json::Value` in Rust and normalized via
`parse_subagent_message_reference_v1` on read, preserving round-trip fidelity.
(The live TS profile at `~/Library/Application Support/aiden-agent/chats/`
held only an empty `index.json`, so byte-level verification was done by
type/serializer comparison rather than sample-file round-trip.)

### #7 Anthropic streaming end-to-end (request question 7)

Traced and **fully connected**:

1. Onboarding collects `api_key` (`onboarding/state.rs:490-496`).
2. `onboarding/mod.rs:356-361` writes it via `stores.keys.set(&provider.id, key)`
   (keychain-backed `ProviderKeysStore`).
3. On send, `ChatService::send` clones `self.stores.keys` and runs the driver in
   `Tokio::spawn` (`chat_service.rs:988-993`).
4. `resolve_api_key(&keys, &provider)` (`provider_kit.rs:1313-1321`) returns the
   stored key for `needs_key` providers.
5. `drive_stream` → `AnthropicProvider::stream_simple` (`anthropic.rs:539-588`)
   → live SSE via `reqwest_eventsource`.

No broken links. An Anthropic key entered in onboarding **will** produce a
streaming response. (Only the *doc comment* is wrong — finding 7.)

### Renderer routes / IPC parity (request question 5)

The five TS routes (`/`, `/chat/$chatId`, `/profile`, `/scheduled`, `/settings`)
all have Rust shells (chat index/pane, usage panel, scheduled panel, settings
view). The `git:*` IPC handlers exist in TS but have **no user-facing route** in
either app — they are internal tooling consumed by the assistant/git tools, and
`aiden-git` provides the Rust equivalent. So there is no missing git *panel*
(neither app ships one). Gaps are limited to findings 2–6 above.

### #8 `#[allow(dead_code)]` audit

The full `#[allow(dead_code)]` set was enumerated. Every annotation is either:
- a renderer-contract helper exercised by unit tests,
- standalone/demo scaffolding explicitly swapped out by the live app
  (`StoreUsageSource`, `StoreScheduledSource`, `LiveRunSource`,
  `AppPaletteSource`, `SettingsRecentStore`),
- a coordinator-facing hook the shell injects (`PillCoordinator` deps), or
- pending workspace-picker wiring (`chat_service.rs:386-458`).

None of them indicates a *silently un-wired* user feature beyond what findings
2–6 already capture. They are deliberate seems, not dead wiring.

---

## Recommended fix order

1. **Finding 1 (CRASH)** first — settings is unusable until the double-lease is
   resolved. ~24 mechanical edits mirroring `50e9fc5`.
2. **Finding 2 (scheduler)** — swap `LoggingTaskExecutor` for a real executor
   that drives `ChatService` generation, or the scheduler is a placebo.
3. **Findings 3–6** — feature-completeness gaps (skills UI, OAuth, computer-use
   probe).
4. **Finding 7** — one-line doc fix.
