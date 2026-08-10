# GPUI Panic-Source Audit — `rust/aiden-ui/src/`

**Branch:** `gpui-rust` · **Date:** 2026-08-09 · **Scope:** every file under `rust/aiden-ui/src/`

This is a focused audit of panic sources that fire inside GPUI's Objective-C
callbacks (render, `on_click`/`on_action`/`on_key_down` listeners, `observe`,
`subscribe`, timers, dialog builders). The app has SIGABRT'd repeatedly; this
document lists every remaining crash source, ranked by severity.

---

## 0. Root cause — verified against the GPUI 0.2.2 source

GPUI does **not** use `RefCell` for entities. It uses a **lease model**
(`gpui-0.2.2/src/app/entity_map.rs`):

- `EntityMap::lease()` **removes** the entity from the entity map
  (`entity_map.rs:115` `.remove()`). If it is already removed →
  `double_lease_panic("update")` (`:116`, `:182`).
- `EntityMap::read()` **looks up** the entity in the map (`:135` `.get()`).
  If it was removed (currently leased out) → `None` →
  `double_lease_panic("read")` (`:138`, `:182`).

When do entities get leased (removed from the map)?

| Callback | How GPUI invokes it | Lease held |
|---|---|---|
| `render(&mut self, ..)` | `view.update(cx, \|view, cx\| view.render(..))` (`view.rs:47`, `:362`) | **self** |
| `cx.listener(f)` | `weak.update(cx, \|view, cx\| f(view,..))` (`context.rs:258`) | **self** |
| `cx.observe(e, f)` | `this.update(cx, \|this, cx\| f(this, e, cx))` (`context.rs:75`) | **self** |
| `cx.subscribe(e, f)` | `this.update(cx, \|this, cx\| f(this, e, ev, cx))` (`context.rs:111`) | **self** |

> Note: the `observe`/`subscribe` second parameter is `Entity<W>` (a **handle**),
> **not** `&W` (`context.rs:66`) — so the *observed* entity is **not** pre-borrowed.
> Only the *listener's own* entity is leased.

**Therefore:** during `render` / any `cx.listener` / `cx.observe` / `cx.subscribe`
closure, calling `cx.entity().read(cx)` (or `.update(cx, ..)`) on the **same**
entity that owns the callback hits `double_lease_panic` → **SIGABRT**.

`notify()` is **deferred** — it pushes an `Effect::Notify`
(`app.rs:2042-2044`) processed *after* `end_lease` (`app.rs:1301`). So a
*bounce-back* (`A.update → notify → B observe → A.update`) is **safe**; only a
*direct self-read during an active lease* crashes. `cx.listener`'s
`weak.update(..).ok()` (`context.rs:258`) means a **dropped** entity is silently
swallowed (no panic) — so dropped-entity handles are not a crash source here.

---

## 1. CRASH findings — `cx.entity().read(cx)` on the leased `SettingsView`

**Severity: CRASH (will SIGABRT).** This is the dominant cluster. The entire
Settings surface is one crash zone.

### The bug pattern

Every settings *section* state struct (`AppearanceState`, `WebSearchState`,
`VoiceState`, `McpState`, …) needs `SettingsServices`, but it is not `SettingsView`
itself, so it reaches back to the parent with a helper:

```rust
// settings/{model_data,assistant,computer_use,providers,voice,mcp,
//          web_search,scheduled}.rs  — repeated 8×, identical each time
fn services(&self, cx: &mut Context<SettingsView>) -> SettingsServices {
    cx.entity().read(cx).services.clone()   // ← re-reads SettingsView
}
```

`cx.entity()` returns `Entity<SettingsView>`; `.read(cx)` reads it back. When
this helper is reached from an `on_click(cx.listener(..))` body (or from
`boot`'s `this.update(..)`), **`SettingsView` is currently leased** →
`double_lease_panic("read")` → **SIGABRT**. The `Context<SettingsView>` type
parameter is what `cx.entity()` returns regardless of which `impl` block the
method lives in.

The correct pattern already exists in the codebase and is **safe** —
`scheduled.rs:775 reload_schedules` and `voice.rs:231 download` use
`self.services.clone()` (direct field access on `&mut SettingsView`) + spawn, with
no re-read. The fix for every finding below is to thread the already-cloned
`SettingsServices` in as a parameter instead of calling the `services(cx)`
helper. (Out of scope for this audit — flagging the recommended repair only.)

### 1a. CRASH on opening Settings (boot path)

`SettingsView::boot` (`settings/mod.rs:193`) is called from `SettingsView::new`
(`:184`). Its background snapshot completes and runs
`this.update(cx, |this, cx| { .. })` (`settings/mod.rs:251`), which **leases
`SettingsView`**, then synchronously calls:

| File:line (call) | File:line (crash) | Method | Read |
|---|---|---|---|
| `settings/mod.rs:279` | `web_search.rs:64` | `load_key_state` | `self.services(cx)` → `:59` `cx.entity().read(cx)` |
| `settings/mod.rs:281` | `model_data.rs:707` | `load_aa_status` | `self.services(cx)` → `:489` `cx.entity().read(cx)` |

(`settings/mod.rs:280` → `voice.rs:133 load_runtime` is **SAFE** — it only spawns
a background task and never re-reads `SettingsView`.)

**Trigger:** open the Settings window (gear icon / palette). After the background
boot snapshot lands (~tens of ms–1 s), `load_key_state` (called first) panics.
This is the most reliable repro.

### 1b. CRASH on clicking any Settings control (listener → helper → self-read)

Each row below is an `on_click(cx.listener(..))` whose body directly calls a
section method that does `cx.entity().read(cx)` (via the `services(cx)` helper or
a direct read) **while `SettingsView` is leased by the listener**. Every one
SIGABRTs on the click.

**Appearance** (`settings/appearance.rs`) — direct `cx.entity().read(cx)`:
| Listener | → method | Crash site |
|---|---|---|
| `:150` (System/Light/Dark) | `set_mode` `:300` | `:301` `cx.entity().read(cx).services.clone()` |
| `:226` (Reduce motion) | `set_reduce_motion` `:327` | `:328` |
| `:270` (Preset row) | `set_preset` `:350` | `:351` |

**Assistant** (`settings/assistant.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:268`, `:312`, `:431` | `save` `:169` | `:176` `self.services(cx)` → `:164` |

**Computer Use** (`settings/computer_use.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:150` (toggle) | `set_enabled` `:48` | `:55` `self.services(cx)` → `:44` |

**Model Data / Artificial Analysis** (`settings/model_data.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:284` (Refresh catalog) | `run_catalog_refresh` `:495` | `:588` `self.services(cx)` → `:489` |
| `:461` (AA Connect) | `aa_connect` `:573` | `:630` |
| `:381` (AA Refresh) | `aa_refresh` `:624` | `:671` |
| `:392` (AA Disconnect) | `aa_disconnect` `:665` | `:671` |

**MCP** (`settings/mcp.rs`) — two are **direct** `cx.entity().read(cx)`:
| Listener | → method | Crash site |
|---|---|---|
| `:381` (toggle server) | `toggle_server` `:619` | `:622` `cx.entity().read(cx).mcp.servers.clone()` |
| `:370` / `:394` (Test server) | `test_server` `:725` | `:728` `cx.entity().read(cx).mcp.servers.clone()` |
| `:562` (Save draft) | `save_draft` `:648` | `:660` `self.services(cx)` → `:615` |
| `:572` (Confirm remove) | `confirm_remove` `:696` | `:697` `self.services(cx)` |

**Providers** (`settings/providers.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:609` (Test/Discover) | `test_discover` `:1165` | `:1212` `self.services(cx)` → `:1280` |
| `:779` (Thinking level) | `set_thinking_level` `:1002` | `:1016` |
| `:825` (Remove key) | `remove_key` `:1010` | `:1057` |
| `:854` (Save editor) | `save_editor` `:1034` | `:1016` |
| `:900` (Confirm remove) | `confirm_remove` `:1251` | `:1253` |

**Scheduled** (`settings/scheduled.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:370` (toggle enabled) | `toggle_enabled` `:724` | `:725` `self.services(cx)` → `:660` |
| `:510` / `:521` (Save draft) | `save_draft` `:664` | `:680` |
| `:586` / `:596` (Confirm remove) | `confirm_remove` `:747` | `:748` |

**Voice** (`settings/voice.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:419` (provider) | `set_provider` `:150` | `:156` `self.services(cx)` → `:128` |
| `:561` (local model) | `select_local_model` `:194` | `:201` |
| `:662` (Remove) | `remove` `:289` | `:296` |

(`:676` Download → `voice.rs:231 download` is **SAFE** — field access + spawn.)

**Web Search** (`settings/web_search.rs`):
| Listener | → method | Crash site |
|---|---|---|
| `:295` (toggle) | `set_enabled` `:189` | `:194` `self.services(cx)` → `:59` |
| `:339` (Test) | `test_key` `:155` | `:161` |
| `:349` (Save) | `save_key` `:99` | `:108` |

**Total CRASH sites in the settings cluster: ~30 distinct triggers** across 9
sections, plus the 2 boot-path reads. A single `services(cx)` helper fix (8 files)
plus the 5 direct `cx.entity().read(cx)` reads (3 in `appearance.rs`, 2 in
`mcp.rs`) eliminates all of them.

---

## 2. RISKY findings (panic only on edge cases — not normal ObjC callbacks)

### 2a. Config-watcher `Mutex::lock().unwrap()` (poison panic)
- `services/stores.rs:228` — `let changed = disk != *last_disk.lock().unwrap();`
- `services/stores.rs:230` — `*last_disk.lock().unwrap() = disk;`

These are `std::sync::Mutex` (returns `Result`). `.unwrap()` only panics if the
mutex is **poisoned** — i.e. a *previous* panic already occurred while holding
this lock in the portable-config watcher thread. It is a background thread, not a
UI ObjC callback, so it cannot itself be the *first* crash, but a poison here
would cascade. Prefer `.lock().unwrap_or_else(|e| e.into_inner())` or
`parking_lot::Mutex`. **Severity: RISKY.**

(All other `Mutex::lock().unwrap()` occurrences — `provider_kit.rs:1358`,
`stores.rs:465`, `live_audio.rs:388/395/417`, `workspace/state.rs:1624/1647` — are
inside `#[cfg(test)]` modules and are excluded.)

---

## 3. SAFE — explicitly verified (documented so they are not re-investigated)

Verified against the GPUI source and the call graph; these **cannot** panic from
a user action.

### 3a. `open_window` (crash category 6) — all SAFE
- `main.rs:405`, `onboarding/mod.rs:514`, `pill/mod.rs:446` — every one returns
  `anyhow::Result<WindowHandle<_>>` directly with **no** `.unwrap()`/`.expect()`.
  Window-creation failure propagates as `Err`, no panic in the run loop.

### 3b. `WeakEntity::update(...).expect/unwrap` (crash category 5) — none exist
Grep for `.update(cx,..).expect(` / `.update(cx,..).unwrap()` returns **zero**
matches. Every `cx.listener` uses `weak.update(..).ok()` (`context.rs:258`), so a
dropped entity is swallowed, never panicked. SAFE.

### 3c. `cx.entity()` capture sites — SAFE (used later, outside the lease)
- `chat/chat_pane.rs:228` — captures strong `Entity` for a `capture_action`
  closure that fires on the paste *event* (not during render); `update` returns
  the handled-flag. The entity is not leased when paste dispatches. SAFE.
- `panels/command_palette.rs:789` — `let entity = cx.entity();` used in
  `on_close` / `on_cancel` callbacks that run when the dialog closes (later
  frame, not leased). The `entity.read(cx)` at `:809` is inside `on_cancel`.
  SAFE.
- `workspace/state.rs:320` — `let entity = cx.entity();` used inside
  `window.open_dialog(cx, ..)`. The dialog builder is **stored, not invoked
  synchronously** (`gpui-component root.rs:134` `builder: Rc::new(build)`); it
  runs during a later `Root` render when `WorkspaceState` is back in the map.
  `overlay_content` (`:359`) reads at `:364`/`:381` during that later render, and
  its internal `entity.update` (`:365`) returns before the `:381` read
  (sequential, not nested). SAFE.
- `chat/message_list.rs:104` — `cx.entity().entity_id()` (id only, no read).
  SAFE.

### 3d. Array indexing in event/parse paths (crash category 3) — all SAFE
Every external-data index is bounds-checked:
- `panels/terminal_drawer.rs:286` (`escape[1]`) — guarded by `len() < 2` check
  (`:283`); `:361`/`:364` (`codes[index]`) guarded by `while index < codes.len()`
  (`:360`); `:366`/`:369` use `codes.get(..)`; `:849`/`:851` (`base[index]`,
  `index+8`) are over a fixed `[Hsla; 16]` with `0..8`. Processes raw PTY bytes
  but cannot panic. SAFE.
- `services/chat_service.rs:443` (`workspaces[index]`) — guarded by
  `iter().position(..)` (`:442`). SAFE.
- `panels/scheduled_panel.rs:227/241/247-251` (cron parse) — guarded by
  `len()` matches and `normalized.len() != 5` early-return (`:244`). SAFE.
- `approvals/approval_bridge.rs:366-370` (cron parse) — guarded by
  `parts.len() == 5` (`:365`). SAFE.
- `panels/usage_panel.rs:330/332` (initials) — guarded by `words.is_empty()`
  (`:326`) and `len() == 1` (`:329`). SAFE.
- Every other `[0]`/`[1]`/`[i]` (e.g. `provider_kit.rs:1421+`,
  `approval_bridge.rs:450+`, `subagents_panel.rs:1038`, all `.last().unwrap()`
  in `view_state.rs`/`queue.rs`/`command_palette.rs`) is inside `#[cfg(test)]`.

### 3e. Production `.unwrap()`/`.expect()` (crash category 4) — all SAFE
After excluding `#[cfg(test)]`, only four remain, all infallible:
- `main.rs:308` `owner.unwrap()` — guarded by `owner.is_some_and(..)` (`:306`).
  Single-instance startup, not a callback. SAFE.
- `services/appearance.rs:227` `.expect("default serializes")` — serializes the
  `Default` appearance config (primitives/enums only); serde cannot fail. SAFE.
- `services/stores.rs:228/230` — listed under §2a (RISKY, poison-only).
- No `.read(cx).unwrap()` / `.read(cx).expect()` / `.upgrade().unwrap()` exist
  anywhere in production code.

### 3f. Re-entrant `B.update → notify → A observe → A.update` bounce — SAFE
`notify()` is deferred (`app.rs:2042-2044` → `Effect::Notify` →
`apply_notify_effect` at `:1301` runs *after* `end_lease`). By the time any
observer fires, the originating entity is back in the map, so bounce-back cannot
double-lease. The `AppState` observe chain (`app.rs:505 sync_from_service` →
`service.update` / `workspace_state.update` / `terminal.update`) touches only
*other* entities and is SAFE.

---

## 4. Summary

| Severity | Count | Location | Fix |
|---|---|---|---|
| **CRASH** | ~30 click triggers + 2 boot reads | `settings/*.rs` `cx.entity().read(cx)` via `services(cx)` helper + 5 direct reads | pass `SettingsServices` as a param; stop re-reading the leased `SettingsView` |
| **RISKY** | 2 | `services/stores.rs:228,230` `Mutex::lock().unwrap()` | poison-proof the lock |
| **SAFE** | all others | — | documented in §3 |

**Priority:** fix the settings cluster first (§1). It is the source of the
"quit unexpectedly" crashes — every interaction with every Settings section, and
simply opening Settings, panics inside an ObjC callback with
`"cannot read SettingsView while it is already being updated"`.

**Recommended single-pass repair:**
1. Delete the 8 identical `fn services(&self, cx: ..)` helpers
   (`model_data.rs:488`, `assistant.rs:163`, `computer_use.rs:43`,
   `providers.rs:1279`, `voice.rs:127`, `mcp.rs:614`, `web_search.rs:58`,
   `scheduled.rs:659`).
2. Change every `let services = self.services(cx);` call site to receive
   `services: SettingsServices` as a parameter, supplied by the listener with
   `this.services.clone()` (field access — `SettingsView` owns `services`
   directly; see `scheduled.rs:775` / `voice.rs:231` for the correct shape).
3. Replace the 5 direct `cx.entity().read(cx)` reads in `appearance.rs:301/328/351`
   and `mcp.rs:622/728` with the same parameter-threading.
4. Re-run `npm test` / `cargo test -p aiden-ui`.
