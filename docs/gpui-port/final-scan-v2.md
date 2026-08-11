# GPUI Port — Final Exhaustive Scan v2

> **Historical snapshot — superseded by the Phase 6 acceptance record.** This
> scan was written before the retained onboarding/main-window lifecycle,
> production update-feed, and provider stream retry work landed. Its Check 5
> window-close finding is resolved by the current `on_window_should_close` and
> reopen paths in `main.rs`/`onboarding/mod.rs`; its network-down retry note is
> resolved by the provider-specific no-reconnect policy. Use
> [`docs/plans/gpui-ui-fidelity-plan.md`](../plans/gpui-ui-fidelity-plan.md)
> and the current workspace gates for present-state evidence. The remaining
> deliberate limitations are distribution-specific automatic app replacement,
> unavailable depth-2/background Subagents, and final macOS pixel capture.

Branch: `gpui-rust` (HEAD `7c839d5`).
Scope: `rust/aiden-ui/src/` runtime paths, cross-checked against the vendored
GPUI 0.2.2 source, `aiden-providers`, and `reqwest-eventsource` 0.6.0 internals.
Every finding below was verified by reading the actual code (not just grepping).

Build: `cargo build -p aiden-ui` — **clean** (1 warning, transitive dep future-incompat).
Tests: `cargo test -p aiden-ui` — **270 passed, 0 failed**.

Severity legend: **CRASH** (panics / `panic_cannot_unwind` / deadlocks the app) ·
**HIGH** (core feature non-functional or strands the user) · **MEDIUM** (feature
partial / degraded) · **LOW** (cosmetic / misleading / hard-to-trigger).

---

## Summary

| # | Check | Verdict | Detail |
|---|-------|---------|--------|
| 1 | Entity double-lease `cx.entity().read/update` | ✅ **CLEAN** | Zero results across all of `rust/`. |
| 2 | `unreachable!` / `panic!` in production | ✅ **CLEAN** | All 6 production sites are provably-unreachable invariants; rest are `#[test]`. |
| 3 | `tokio::spawn` from a GPUI context | ✅ **CLEAN** | The one production site is documented-safe (runs inside the pill watcher, which `Tokio::spawn` owns). |
| 4 | `.expect()` in non-test code | ✅ **CLEAN** | One production site; provably infallible (serde default). |
| 5 | Window-close (the red ✕ button) | 🔴 **HIGH** | No `on_window_should_close` / `on_reopen` — ✕ closes the window but leaves a headless, locked process; user cannot reopen. |
| 6 | Onboarding end-to-end | ✅ **SOUND** | Deferred completion callback avoids the both-windows-visible race; keychain id matches. |
| 7 | Provider key chain (Anthropic) | ✅ **CLEAN** | Onboarding write path and ChatService read path use the same `ProviderKeysStore` + `provider.id`. |
| 8 | Streaming actually works | ✅ **WORKS** | Full chain wired end-to-end; verified `reqwest_eventsource` surfaces 4xx/5xx promptly. |
| 9 | Dead code / unwired modules | 🟡 **LOW** | Most `#[allow(dead_code)]` are stale (the fns ARE wired); 2 genuinely-unwired pill helpers (minor). |
| 10 | Missing error surfaces (401/403/429/500) | 🟡 **LOW** | Errors surface as a red banner with the status code + Retry; one edge case (network-down retries forever). |

**Net: one HIGH-severity functional gap (Check #5) remains. Everything else is
clean or LOW.** The previous ~50-gap rounds eliminated the entire CRASH-class
(double-lease, foreground-tokio, unreachable race conditions). What's left is
one shell-lifecycle wiring hole and a handful of polish items.

---

## Check 1 — Entity double-lease: ✅ CLEAN

**Command:** `rg "cx\.entity\(\)\.read\(|cx\.entity\(\)\.update\(" rust/ -g '*.rs'`

**Result: ZERO matches** across the entire `rust/` tree (not just `aiden-ui`).
Commit `10869bf` ("eliminate ALL entity double-lease panics in settings, 13
sites across 10 files") and the earlier `50e9fc5` cleared the full pattern. The
13-site sweep in the v1 scan (`final-scan.md` §1) is fully resolved.

---

## Check 2 — `unreachable!` / `panic!` in production: ✅ CLEAN

**Command:** `rg "unreachable!|panic!" rust/aiden-ui/src/ -g '*.rs' -g '!*test*'`

28 matches total. Breakdown:

### In `#[test]` modules (22 matches) — safe by construction

- `provider_kit.rs:1424, 1443, 1528, 1539, 1542, 1551, 1564, 1567, 1575, 1590,
  1616, 1619, 1623, 1678, 2244, 2256` — all inside `#[cfg(test)] mod tests`
  (starts line 1323). Pattern-match assertions like
  `let Message::Assistant(ref a) = msg else { panic!("expected assistant") }`.
- `stream.rs:449, 481, 491, 659, 684` — inside `#[cfg(test)] mod tests`.
- `approval_bridge.rs:433` — inside `#[test] fn evaluate_asks_…`.
- `view_state.rs:543` — inside `#[test] fn history_projects_…`.

### In production code (6 matches) — provably-unreachable invariants

`provider_kit.rs:952, 972, 987` — these guard `reducer.finalize()` matching
`StreamTerminal::Done` *after* the code has already taken the
`if reducer.failure.is_some()` branch:

```rust
// provider_kit.rs:933
if reducer.failure.is_some() {
    // ...
    match reducer.finalize() {
        StreamTerminal::Error { .. } => { /* send StreamMsg::Error */ }
        StreamTerminal::Done { .. } => unreachable!("a failing reducer finalizes as Error"),  // :952
    }
    return;
}
```

**Why this is safe:** `StreamReducer::fail()` sets `self.failure = Some(..)`.
`finalize()` (in `stream.rs`) returns `Error` whenever `failure.is_some()`.
The invariant holds as long as the two methods agree on the failure state —
which they do, and which the reducer's own unit tests assert
(`stream.rs` `eof_without_terminal_is_an_error_terminal`). A user action
cannot reach these arms because the upstream `is_some()` guard is exhaustive.

**Verdict: no user-reachable panic remains.**

---

## Check 3 — `tokio::spawn` from a GPUI context: ✅ CLEAN

**Command:** `rg "tokio::spawn\(" rust/aiden-ui/src/ -g '*.rs'`

5 matches:

| Site | Context | Safe? |
|------|---------|-------|
| `approval_bridge.rs:470, 495, 515` | inside `#[tokio::test]` | ✅ |
| `pill/coordinator.rs:398` | inside `#[cfg(test)] mod tests` (starts line 286) | ✅ |
| `pill/coordinator.rs:270` | **production** — see below | ✅ (documented) |

### The one production `tokio::spawn` (coordinator.rs:262–275)

```rust
fn set_timer(&self, callback: Box<dyn FnOnce() + Send>, delay_ms: u64) -> TimerHandle {
    // Runtime contract: this is only ever invoked from the dictation
    // coordinator's state machine, which runs inside the pill watcher — and
    // the watcher is spawned via `Tokio::spawn` (see wire_pill_coordinator).
    let handle = tokio::spawn(async move {
        tokio::time::sleep(...).await;
        callback();
    });
    ...
}
```

**Verified the contract holds:**
- `set_timer` is a `DictationCoordinatorDeps` trait method.
- The only non-test impl caller is `aiden-mac/src/dictation_coordinator.rs:150`,
  invoked from the coordinator state machine.
- The coordinator state machine runs inside the pill watcher future.
- `app.rs:1396` spawns that watcher via `gpui_tokio_bridge::Tokio::spawn(cx, watcher)`
  — so a tokio guard IS present when `set_timer` runs.
- A regression guard exists: `coordinator.rs:414` `#[test] fn new_does_not_touch_tokio()`
  is deliberately a plain `#[test]` (no runtime) that fails CI if anyone
  reintroduces a tokio call in `PillCoordinator::new`.

**Also verified (broader tokio surface):** every `tokio::time::sleep` /
`tokio::time::interval` / `tokio::task::spawn_blocking` in production code
(`provider_kit.rs:879`, `app.rs:1483`, `pill/live_audio.rs:288`, `pill/coordinator.rs:205,271`,
`workspace/state.rs:937,978,1047`) is inside a future that `Tokio::spawn` owns.
No GPUI-foreground tokio call remains.

---

## Check 4 — `.expect()` in non-test code: ✅ CLEAN

**Command:** `rg "\.expect\(" rust/aiden-ui/src/ -g '*.rs' -g '!*test*'`

28 matches. **27 are inside `#[cfg(test)]` modules** (the `-g '!*test*'` filter
only excludes filenames containing "test"; it does not exclude test *functions*
inside normal files — those were verified by reading each call site).

### One production `.expect()` — provably infallible

`services/appearance.rs:227`:

```rust
pub fn appearance_to_settings(config: &AppearanceConfig) -> serde_json::Value {
    serde_json::to_value(config).unwrap_or_else(|_| {
        serde_json::to_value(create_default_appearance_config()).expect("default serializes")
    })
}
```

`AppearanceConfig` is a plain `#[derive(Serialize)]` struct of primitives;
`create_default_appearance_config()` returns fixed values. Serde cannot fail to
serialize it (no custom serializer, no enum tag edge cases). This `.expect()`
is a defensive assertion on an infallible serialization, not a user-triggerable
panic. **LOW — acceptable.**

---

## Check 5 — Window-close (the red ✕ button): 🔴 HIGH

### What's wrong

The app handles **⌘W** (the `CloseWindow` action) correctly — it routes to
`on_close_window` (`app.rs:793`) which calls `request_quit` → full clean
shutdown (cancel generation, `scheduler.stop()`, `barrier.force()`, `cx.quit()`).

**But the red ✕ close button is unhandled.** Clicking it triggers macOS's
native `windowShouldClose:` path, which GPUI handles in
`gpui-0.2.2/src/platform/mac/window.rs:2045`:

```rust
extern "C" fn window_should_close(...) -> BOOL {
    if let Some(mut callback) = lock.should_close_callback.take() {
        callback()  // <-- never registered by Aiden
    } else {
        YES  // <-- default: close the window
    }
}
```

Aiden never calls `window.on_window_should_close(..)` (verified: zero matches in
`rust/aiden-ui/src/`). So the ✕ button returns `YES`, closes the window, and…
nothing else.

### Why this strands the user (verified against GPUI + macOS semantics)

1. **The process does not quit.** GPUI does not implement
   `applicationShouldTerminateAfterLastWindowClosed` (the macOS default is NO).
   After the ✕ click, `NSApplication` keeps running its event loop.

2. **`request_quit`'s cleanup never runs.** The scheduler tick loop
   (`stores.scheduler`), the tokio runtime (`gpui_tokio_bridge`), the
   portable-config watcher, and the global dictation hotkey listener all keep
   running. The single-instance lock (`aiden.lock`) stays claimed.

3. **The window cannot be reopened.** Aiden does not register
   `cx.on_reopen(..)` (verified: zero matches). GPUI's
   `should_handle_reopen` (`platform/mac/platform.rs:1409`) only fires the
   callback if one was registered; with none, clicking the dock icon does
   nothing. The app sits in the Dock with no visible window.

4. **The onboarding window is worse.** If the user clicks ✕ during
   onboarding, the `OnboardingView` entity is dropped, the `with_on_complete`
   callback never fires, and the main window never opens. The user is stranded
   mid-first-run with a locked, windowless process.

### Severity: **HIGH**

Not a crash — but a clear "core feature non-functional / strands the user"
scenario. The user's only escape is to right-click the Dock icon → Quit (which
bypasses `request_quit`'s cleanup), or force-quit. Relaunching hits the
single-instance lock and the new instance exits after trying to activate the
headless one (which has no window to activate).

### Fix (fixable now)

Wire `on_window_should_close` on the main window in `open_main_window`
(`main.rs:405`) and on the onboarding window in `open_onboarding_window`
(`onboarding/mod.rs:514`):

```rust
let handle = cx.open_window(options, |window, cx| { ... })?;
handle.update(cx, |_, window, cx| {
    window.on_window_should_close(cx, |_, cx| {
        cx.dispatch_action_into_window(app::Quit);  // or call request_quit
        false  // veto the native close; let the quit path drive it
    });
})?;
```

Alternatively (simpler): register `cx.on_reopen` at the app level to reopen the
main window, AND set `applicationShouldTerminateAfterLastWindowClosed`-equivalent
behavior. The cleanest single fix is the `on_window_should_close` route above —
it makes ✕ behave like ⌘W, matching the documented intent at `app.rs:790–792`:

> "⌘W: close the window. A single-window app has nothing to fall back to, so
> this is a full quit (same barrier path as ⌘Q) — no windowless process lingers
> in the dock."

The ✕ button currently violates exactly that stated contract.

---

## Check 6 — Onboarding end-to-end: ✅ SOUND

Traced the full flow: `should_show_onboarding` (`main.rs:236`) → `open_onboarding_window`
→ `OnboardingView::new` → step navigation (`on_next_pressed` → `save_provider_then_advance`
→ `persist_after_step`) → `complete_onboarding` → deferred `with_on_complete` callback.

### Completion callback race — correctly handled

`complete_onboarding` (`onboarding/mod.rs:445`) writes the first-run marker on
the background, then:

```rust
this.update(cx, |this, cx| {
    if let Some(callback) = this.on_complete.take() {
        cx.defer(move |cx| callback(cx));  // <-- deferred out of this update cycle
    }
    cx.emit(OnboardingEvent::Completed);
})?;
```

The `cx.defer` (`gpui-0.2.2/src/app.rs:1434`) pushes an `Effect::Defer` that
`flush_effects` (line 1225) runs at the **end** of the current update cycle —
after GPUI has returned the onboarding window to its window map (the window is
temporarily taken out during event dispatch). The callback then runs
`handle.update(remove_window)` + `open_main_window` without the "window not
found" nested-update failure. **No both-windows-visible race.** The deferral
contract is documented in a thorough comment at `onboarding/mod.rs:426–444`.

### `with_on_complete` fires — verified

The callback is stored in `OnboardingServices::on_complete`, moved into the
view at construction (`onboarding/mod.rs:129`), and `take()`n exactly once in
`complete_onboarding`. The guard `if self.completed_emitted { return; }` (line
446) makes it idempotent against double-completion (e.g., the boot self-close
path at line 205 racing a user button). ✅

### Marker-write-before-callback ordering — verified

The `background_spawn` (marker write) is `.await`ed before `this.update` runs
the callback (lines 452–468). If the write fails, the result is discarded but
the callback still fires — so the main window opens regardless, and the worst
case is onboarding re-showing on next launch (defensive, acceptable).

**Verdict: the onboarding flow is race-free and correctly sequenced.** The only
onboarding-related gap is the ✕-button strand (Check #5), which is a
shell-lifecycle issue, not a flow-logic issue.

---

## Check 7 — Provider key chain (Anthropic): ✅ CLEAN

Traced the full path for an Anthropic key entered in onboarding:

| Step | Code | Key / service name |
|------|------|--------------------|
| Onboarding save | `onboarding/mod.rs:356–360` `stores.keys.set(&provider.id, key)` | account = `provider.id` = `"anthropic"` |
| Keychain service | `stores.rs:45,108` `ProviderKeysStore::new(local_root, KEYCHAIN_SERVICE, …)` | service = `"com.sambitcreate.aiden-agent.provider-keys"` |
| ChatService boot | `chat_service.rs:178` `.list_providers()` → config store | returns the `"anthropic"` record saved above |
| Enrich | `provider_kit.rs:254` `enrich_provider` | preserves `provider.id` |
| Resolve | `chat_service.rs:991` `resolve_api_key(&keys, &snapshot.provider)` | `provider_kit.rs:1320` `keys.get(&provider.id)` |
| Read service | same `ProviderKeysStore` | same `KEYCHAIN_SERVICE` |

**The write account (`provider.id`) and the read account (`provider.id`) are the
same string, against the same `ProviderKeysStore` with the same
`KEYCHAIN_SERVICE`. No mismatch.** The `StoreSecretsPort` binding/migration
layer (`stores.rs:113,388–410`) only affects *legacy alias keys* (e.g.
`"gemini"` → `"google"`), not fresh onboarding writes — and even there the
reconciliation is tested (`stores.rs` `migrate_keys_rehomes_alias_keys…`).

---

## Check 8 — Streaming actually works: ✅ WORKS

Full chain verified end-to-end:

```
send_message (chat_service.rs:805)
  → send_message_with (810)
    → start_generation (935)
      → Tokio::spawn(cx, drive_stream(snapshot, api_key, cancel, tx))   [chat_service.rs:990]
      → cx.spawn(watcher: drains rx → apply_stream_msg)                 [chat_service.rs:995]
        ↓
drive_stream (provider_kit.rs:761)
  → transport.stream_simple(&request, &options)                         [provider_kit.rs:882]
    → AnthropicProvider::stream_simple (anthropic.rs:539)
      → reqwest_eventsource::EventSource::new(request_builder)
      → futures::stream::unfold → accumulator.step(event, data)
        → AssistantMessageEvent::{TextDelta, ThinkingDelta, Done, …}
  → reducer.apply(event) → send_flush(&tx) every FLUSH_INTERVAL_MS
  → on terminal: StreamMsg::{Done, Error, Cancelled}
```

The watcher (`chat_service.rs:995–1009`) drains the mpsc channel into
`apply_stream_msg`, which updates `self.generation` (text/thinking/error/
complete) and calls `cx.notify()` to re-render the streaming bubble.

### No broken links

- `transport()` resolves the correct provider impl by `api_family` (anthropic →
  `AnthropicProvider`).
- `build_stream_request_with_tools` produces the wire `StreamRequest`; the
  anthropic `build_request` injects `x-api-key` + `anthropic-version` headers.
- The SSE unfold correctly terminates on `None` (connection closed) and maps
  `Some(Err)` to `ProviderError::Stream`.
- Missing API key fails fast: `build_request` (`anthropic.rs:506–509`) returns
  `ProviderError::Config("missing api key for anthropic")` *before* any network
  I/O, which `drive_stream` surfaces via `reducer.fail(provider_error_message(..))`.

**Verdict: the streaming chain is fully wired and would render live SSE deltas.**

---

## Check 9 — Dead code / unwired modules: 🟡 LOW

**Command:** `rg "#\[allow\(dead_code\)\]" rust/aiden-ui/src/ -g '*.rs'` → 71 matches.

### Stale annotations (the fn IS wired — annotation should be removed)

These are **not** missing wiring; the `#[allow(dead_code)]` is simply stale:

| Site | Why it's actually used |
|------|------------------------|
| `chat_service.rs:386,395,411,458` (`workspace_folder`, `select_workspace`, `add_workspace_from_folder`, `persist_workspace`) | Called from `app.rs:475,479,592,772,1104` (⌘O folder picker, workspace chip, terminal cwd). |
| `pill/mod.rs:128` (`push_dictation`) | Called from `app.rs:1321` (`bridge_broadcast` → forwards coordinator state to the pill view). |
| `stores.rs:78` (`config_watcher`) | Intentionally a drop-guard — the field exists to keep the watcher reachable for the shell's `refresh()`, not to be read. |
| `panels/*` "standalone/demo scaffolding" | Demo `*Source` impls; the app uses the `Store*Source` / `AppPaletteSource` / `LiveRunSource` variants instead (wired at `app.rs:934,936,1140,1191`). These are test/demo scaffolds, not missing features. |

### Genuinely unwired (2 items, both minor, both in the dictation pill)

- `pill/mod.rs:139` `update_appearance` — "appearance sync lands with the wiring
  phase." The pill reads appearance at open-time via `bridge_show_pill`
  (`app.rs:1341–1349`), so live appearance changes while the pill is hidden
  don't propagate. **Impact: minimal** — the pill re-reads on each open.
- `pill/mod.rs:146` `set_system_reduced_motion` — "the platform probe lands
  later." The pill uses the persisted reduce-motion setting, not the live OS
  preference. **Impact: minimal** — onboarding captures the preference.

Neither blocks a core workflow. The dictation pill itself (hotkey → coordinator
→ audio capture → whisper → paste) **is** wired end-to-end via
`wire_pill_coordinator` (`app.rs:1329`) and the global hotkey
(`register_global_dictation_hotkey`, `app.rs:1427`).

---

## Check 10 — Missing error surfaces (401/403/429/500): 🟡 LOW

### The happy-error path works

Traced: SSE/HTTP error → `drive_stream` → `reducer.fail(message)` →
`StreamMsg::Error { message, partial_text, .. }` → `apply_stream_msg`
(`chat_service.rs:1229`) sets `generation.error = Some(message)` → rendered as a
red banner in `message_list.rs:423–457`:

```
[⚠ triangle]  <error message>  [Retry]
```

The banner uses `danger.opacity(0.12)` background, a `TriangleAlert` icon, and a
ghost "Retry" button (`service.retry_last`). Partial content is preserved
(`generation.text = partial_text`). Usage is recorded as `Failed`.
**This is a clear, actionable error surface — not a silent failure or a crash.**

### 4xx/5xx surface promptly (verified in reqwest_eventsource internals)

I verified the exact retry semantics in `reqwest-eventsource-0.6.0`:

- **HTTP non-200 (401/403/429/500):** `check_response`
  (`event_source.rs:118–124`) returns `Err(InvalidStatusCode(status, ..))`.
  `poll_next` (line 243–246) sets `is_closed = true` and returns
  `Poll::Ready(Some(Err(..)))` **immediately — no retry.** The error reaches
  `drive_stream` on the next `stream.next()`, fails the reducer, and surfaces
  as the banner above within one `FLUSH_INTERVAL_MS` tick.

- **Transport errors (DNS, connection refused, timeout):** these DO go through
  `handle_error` → the `DEFAULT_RETRY` policy (`ExponentialBackoff` with
  `max_retries: None`) retries forever (300ms → 600ms → … capped at 5s). See
  the edge case below.

The user-visible message for a 401 is `"Invalid status code: 401 Unauthorized"`
(`reqwest-eventsource` `Error::InvalidStatusCode` Display =
`"Invalid status code: {status}"`, and `reqwest::StatusCode` Display includes
the canonical reason). This is **adequate but not maximally friendly** — it
doesn't say "Your API key looks invalid; check it in Settings." The Retry
button re-sends, which will fail identically until the key is fixed.

### The one edge case: network-down retries forever (LOW)

If the network is fully unreachable (not a 4xx — a transport error), the
`DEFAULT_RETRY` policy retries indefinitely. The user sees a blinking streaming
cursor with no banner, potentially for minutes. **Mitigations already in place:**

1. The user can press **Stop**, which sets the cancel flag; `drive_stream`'s
   `interval.tick()` arm (`provider_kit.rs:898–905`) checks
   `cancel.load(Ordering::Relaxed)` every `FLUSH_INTERVAL_MS` and breaks.
2. Each individual HTTP request has `timeout_ms: Some(TURN_TIMEOUT_MS)`
   (`provider_kit.rs:800`), so a hung connection (not a refused one) does
   surface within the turn timeout.

**Not a silent data-loss bug** — but the transport-retry-forever policy means a
truly-down network hangs the bubble until the user intervenes. A `Never` or
bounded retry policy on the `EventSource` (or a turn-level deadline wrapping
the whole `drive_stream` loop) would make this self-resolving. **LOW — fixable,
not blocking.**

---

## Conclusion

After the ~50-gap cleanup across the prior rounds, the Aiden-RS GPUI app is in
strong shape on the crash-correctness axis:

- **Zero** double-lease panics (Check 1).
- **Zero** user-reachable `unreachable!`/`panic!` (Check 2).
- **Zero** foreground-tokio violations (Check 3).
- **Zero** risky `.expect()` (Check 4).
- Streaming, keychain, and onboarding-flow logic are all correctly wired
  (Checks 6, 7, 8).

**The single remaining HIGH-severity gap is Check #5: the red ✕ window-close
button is unhandled.** It bypasses `request_quit`'s cleanup and leaves a
headless, single-instance-locked process with no way to reopen the window. The
fix is small (one `on_window_should_close` registration per window) and is
documented above with the exact code site and a sketch.

Everything else (Checks 9, 10) is LOW-severity polish — stale dead-code
annotations, two minor pill helpers, slightly-cryptic error strings, and a
transport-retry edge case — none of which blocks a core workflow.
